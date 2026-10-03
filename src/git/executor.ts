import { constants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { CommitGroup, CommitPlan, ExecutionResult, RepoSnapshot } from "../types.js";
import { validatePlan } from "../plan/validate.js";
import { buildHunkPatch } from "./patch.js";
import { digest, git, lineOutput, nulPaths } from "./process.js";
import { headOid, pathState, safePath, snapshotRepository, worktreeDigest, worktreePaths } from "./snapshot.js";

async function optionalRead(path: string): Promise<Buffer | null> {
  try { return await readFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function sameBytes(a: Buffer | null, b: Buffer | null): boolean { return a === null ? b === null : b !== null && a.equals(b); }
function appendError(result: ExecutionResult, context: string, error: unknown): void {
  const text = error instanceof Error ? error.message : String(error);
  result.error = `${result.error ? `${result.error}; ` : ""}${context}: ${text}`;
}
async function writeChangelogAtomic(path: string, content: string, expected: string | null): Promise<void> {
  const temporary = await mkdtemp(join(dirname(path), ".pi-commit-changelog-"));
  const file = join(temporary, "content");
  try {
    let mode = 0o666 & ~process.umask();
    if (expected !== null) {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Changelog is no longer a regular file");
      mode = stat.mode & 0o777;
    }
    await writeFile(file, content, { flag: "wx", mode });
    await chmod(file, mode);
    if (!sameBytes(await optionalRead(path), expected === null ? null : Buffer.from(expected))) throw new Error("Changelog changed before atomic write");
    if (expected === null) await link(file, path); // atomic create, never overwrite an unexpected new file
    else {
      if ((await lstat(path)).isSymbolicLink()) throw new Error("Changelog became a symlink");
      await rename(file, path);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

/** Changelog writes may not traverse a symlink, including at the leaf. */
async function checkChangelog(root: string, plan: CommitPlan): Promise<void> {
  const change = plan.changelog;
  if (!change) return;
  if (!safePath(change.file)) throw new Error("Unsafe changelog path");
  if (plan.groups.some(group => group.selectors.some(s => s.path === change.file))) throw new Error("Generated changelog overlaps selected changes");
  let current = root;
  for (const component of change.file.split("/")) {
    current = join(current, component);
    try { if ((await lstat(current)).isSymbolicLink()) throw new Error("Generated changelog cannot be a symlink or traverse one"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const actual = await optionalRead(join(root, change.file));
  const expected = change.originalContent === null ? null : Buffer.from(change.originalContent);
  if (!sameBytes(actual, expected)) throw new Error("Changelog changed since preview");
}

/** Replace only selected entries, retaining flags and unrelated staged entries from the real index. */
async function reconcileIndex(root: string, realIndex: string, temporary: string, paths: string[], oid: string): Promise<void> {
  const existing = await optionalRead(realIndex);
  const env = { GIT_INDEX_FILE: temporary };
  await rm(temporary, { force: true });
  if (existing) await writeFile(temporary, existing);
  else await git(root, ["read-tree", "--empty"], { env });
  const tree = nulPaths((await git(root, ["ls-tree", "-z", "--full-tree", oid, "--", ...paths])).stdout);
  const entries = new Map(tree.map(entry => {
    const tab = entry.indexOf("\t"), meta = entry.slice(0, tab).split(" ");
    return [entry.slice(tab + 1), `${meta[0]} ${meta[2]}`];
  }));
  const zero = "0".repeat(lineOutput((await git(root, ["hash-object", "--stdin"], { input: "" })).stdout).length);
  const input = Buffer.from([...new Set(paths)].map(path => `${entries.get(path) ?? `0 ${zero}`}\t${path}\0`).join(""));
  await git(root, ["update-index", "-z", "--index-info"], { env, input });
  // The real index.lock is held throughout. Rename provides an atomic reader-visible replacement.
  const next = `${realIndex}.pi-commit-${process.pid}`;
  await copyFile(temporary, next, constants.COPYFILE_EXCL);
  try { await rename(next, realIndex); } finally { await rm(next, { force: true }); }
}

/**
 * Authorization belongs to the caller. Revalidates the plan and drift before mutation.
 * Each group uses a private index and ordinary `git commit`: standard commit hooks and signing run.
 * Generated changelog belongs to the final group. No reset, fallback commit, or worktree checkout is used.
 */
export async function executePlan(snapshot: RepoSnapshot, plan: CommitPlan, orderedGroups?: CommitGroup[]): Promise<ExecutionResult> {
  const result: ExecutionResult = { succeeded: [], remainingGroups: plan.groups.map(g => g.id), restoredIndex: false, changelogRestored: false };
  let temp: string | undefined, lock: Awaited<ReturnType<typeof open>> | undefined, realIndex: string | undefined;
  let originalIndex: Buffer | null = null, expectedIndex: Buffer | null = null;
  let root: string | undefined, changelogWritten = false, changelogCommitted = false;
  let generatedState: Buffer | undefined;
  let active: string | undefined;
  try {
    const validation = validatePlan(plan, snapshot);
    if (!validation.valid) throw new Error(`Invalid commit plan: ${validation.errors.map(e => e.message).join("; ")}`);
    const groups = validation.orderedGroups;
    if (orderedGroups && JSON.stringify(orderedGroups.map(g => g.id)) !== JSON.stringify(groups.map(g => g.id))) throw new Error("Commit groups are not in validated dependency order");
    result.remainingGroups = groups.map(g => g.id);
    if (!snapshot.root) throw new Error("Snapshot has no repository root");
    root = snapshot.root;
    const fresh = await snapshotRepository(root);
    if (fresh.fingerprint !== snapshot.fingerprint) throw new Error("Repository changed since preview; generate a fresh plan");
    await checkChangelog(root, plan);
    realIndex = lineOutput((await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout);
    originalIndex = expectedIndex = await optionalRead(realIndex);
    // Reserve the actual index lock, while all Git writes use different private indexes.
    lock = await open(`${realIndex}.lock`, "wx", 0o600);
    if ((await snapshotRepository(root)).fingerprint !== snapshot.fingerprint) throw new Error("Repository changed while acquiring index lock");
    temp = await mkdtemp(join(tmpdir(), "pi-commit-index-"));
    const sourceIndex = join(temp, "source"), commitIndex = join(temp, "commit"), reconcile = join(temp, "reconcile");
    if (originalIndex) await writeFile(sourceIndex, originalIndex);
    else await git(root, ["read-tree", "--empty"], { env: { GIT_INDEX_FILE: sourceIndex } });
    const fixedPaths = await worktreePaths(root);
    if (plan.changelog && !fixedPaths.includes(plan.changelog.file)) fixedPaths.push(plan.changelog.file);
    fixedPaths.sort();
    const expectedStates = new Map<string, Buffer>();
    for (const path of fixedPaths) expectedStates.set(path, await pathState(root, path));
    const expectedDigest = () => digest(...fixedPaths.flatMap(path => [path, expectedStates.get(path)!]));
    let expectedWorktree = expectedDigest();
    if ((await snapshotRepository(root)).fingerprint !== snapshot.fingerprint) throw new Error("Repository changed while preparing execution");
    let expectedHead = snapshot.headOid;
    const committedHunks = new Map<string, string[]>();
    const sourceEnv = { GIT_INDEX_FILE: sourceIndex }, commitEnv = { GIT_INDEX_FILE: commitIndex };
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i]; active = group.id;
      if ((await headOid(root)) !== expectedHead || !sameBytes(await optionalRead(realIndex), expectedIndex) ||
          await worktreeDigest(root, fixedPaths) !== expectedWorktree) throw new Error("Repository changed during commit execution");
      await rm(commitIndex, { force: true });
      await git(root, expectedHead ? ["read-tree", expectedHead] : ["read-tree", "--empty"], { env: commitEnv });
      const changedPaths: string[] = [];
      for (const selector of group.selectors) {
        const file = snapshot.files.find(f => f.path === selector.path)!;
        changedPaths.push(file.path, ...(file.oldPath ? [file.oldPath] : []));
        if (selector.hunks !== "all") {
          const patch = buildHunkPatch(file, selector.hunks, committedHunks.get(file.path) ?? []);
          await git(root, ["apply", "--cached", "--whitespace=nowarn", "-"], { env: commitEnv, input: patch });
        } else if (snapshot.mode === "staged") {
          const paths = [file.path, ...(file.oldPath ? [file.oldPath] : [])];
          for (const path of paths) {
            const entry = (await git(root, ["ls-files", "--stage", "-z", "--", path], { env: sourceEnv })).stdout;
            if (entry.length) await git(root, ["update-index", "-z", "--index-info"], { env: commitEnv, input: entry });
            else await git(root, ["update-index", "--force-remove", "--", path], { env: commitEnv });
          }
        } else {
          await git(root, ["add", "-A", "--", ...changedPaths.slice(changedPaths.length - (file.oldPath ? 2 : 1))], { env: commitEnv });
        }
      }
      const generated = plan.changelog && i === groups.length - 1 ? plan.changelog : undefined;
      if (generated) {
        await checkChangelog(root, plan);
        const before = expectedStates.get(generated.file)!;
        const mode = /^file:(\d+):/.exec(before.toString("utf8"))?.[1] ?? "0";
        generatedState = Buffer.concat([Buffer.from(`file:${mode}:`), Buffer.from(generated.newContent)]);
        expectedStates.set(generated.file, generatedState);
        changelogWritten = true;
        await writeChangelogAtomic(join(root, generated.file), generated.newContent, generated.originalContent);
        await git(root, ["add", "--", generated.file], { env: commitEnv });
        changedPaths.push(generated.file);
        expectedWorktree = expectedDigest();
      }
      const intendedTree = lineOutput((await git(root, ["write-tree"], { env: commitEnv })).stdout);
      const message = group.message.subject + (group.message.body ? `\n\n${group.message.body}` : "");
      if ((await headOid(root)) !== expectedHead || !sameBytes(await optionalRead(realIndex), expectedIndex) ||
          await worktreeDigest(root, fixedPaths) !== expectedWorktree) throw new Error("Repository changed before committing");
      const parentBeforeCommit = expectedHead;
      const commit = await git(root, ["commit", "--cleanup=verbatim", "-m", message], { env: commitEnv, allowFailure: true });
      const nextHead = await headOid(root);
      if (nextHead === expectedHead || !nextHead) throw new Error(`Commit ${group.id} failed: ${commit.stderr.toString("utf8").trim() || commit.stdout.toString("utf8").trim()}`);
      const actualTree = lineOutput((await git(root, ["rev-parse", `${nextHead}^{tree}`])).stdout);
      const parents = lineOutput((await git(root, ["rev-list", "--parents", "-n", "1", nextHead])).stdout).split(" ").slice(1);
      if (JSON.stringify(parents) !== JSON.stringify(parentBeforeCommit ? [parentBeforeCommit] : [])) throw new Error("HEAD changed concurrently; history retained, group stopped");
      if (actualTree !== intendedTree) throw new Error("A commit hook or external process changed the previewed tree; history retained, group stopped");
      // The expected commit exists: record it before any fallible reconciliation; never reset it.
      result.succeeded.push({ oid: nextHead, groupId: group.id });
      if (generated) changelogCommitted = true;
      result.remainingGroups = groups.slice(i + 1).map(g => g.id);
      expectedHead = nextHead;
      for (const selector of group.selectors) if (selector.hunks !== "all") committedHunks.set(selector.path, [...(committedHunks.get(selector.path) ?? []), ...selector.hunks]);
      if (!sameBytes(await optionalRead(realIndex), expectedIndex)) throw new Error("Real index changed despite lock; committed history retained, index not overwritten");
      const reconcilePaths = snapshot.mode === "worktree" ? changedPaths : generated ? [generated.file] : [];
      if (reconcilePaths.length) await reconcileIndex(root, realIndex, reconcile, reconcilePaths, nextHead);
      expectedIndex = await optionalRead(realIndex);
      if (await worktreeDigest(root, fixedPaths) !== expectedWorktree) throw new Error("A commit hook or external process changed the worktree; changes preserved, remaining groups stopped");
      if (commit.code !== 0) throw new Error(`Git reported failure after creating commit ${nextHead}: ${commit.stderr.toString("utf8").trim()}`);
      active = undefined;
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    if (active && result.remainingGroups.includes(active)) result.failedGroup = active;
    try {
      if (realIndex && result.succeeded.length === 0) result.restoredIndex = sameBytes(await optionalRead(realIndex), originalIndex);
      if (plan.changelog && root) {
        const change = plan.changelog, absolute = join(root, change.file);
        // Only restore our unchanged generated regular file, never hook/user edits or symlinks.
        if (changelogWritten && !changelogCommitted && generatedState) {
          if ((await pathState(root, change.file)).equals(generatedState)) {
            if (change.originalContent === null) await unlink(absolute);
            else await writeChangelogAtomic(absolute, change.originalContent, change.newContent);
            result.changelogRestored = true;
          }
          else result.changelogRestored = sameBytes(await optionalRead(absolute), change.originalContent === null ? null : Buffer.from(change.originalContent));
        } else if (!changelogWritten) result.changelogRestored = sameBytes(await optionalRead(absolute), change.originalContent === null ? null : Buffer.from(change.originalContent));
      }
    } catch (restoreError) { appendError(result, "Restoration failed (history retained)", restoreError); }
  } finally {
    if (lock) {
      try { await lock.close(); if (realIndex) await rm(`${realIndex}.lock`, { force: true }); }
      catch (cleanupError) { appendError(result, "Index lock cleanup failed", cleanupError); }
    }
    if (temp) {
      try { await rm(temp, { recursive: true, force: true }); }
      catch (cleanupError) { appendError(result, "Private index cleanup failed", cleanupError); }
    }
  }
  return result;
}

/**
 * Explicit --push only: one attached branch to its configured upstream branch, never tags,
 * matching branches, recursive submodule pushes, mirrors or force refspecs. Submodule commits must
 * be available on a remote (check mode). Failure retains local history.
 */
export async function pushRepository(cwd: string): Promise<void> {
  const branchResult = await git(cwd, ["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true });
  if (branchResult.code !== 0) throw new Error("Push refused: HEAD is detached; check out a branch with a configured upstream");
  const branchRef = lineOutput(branchResult.stdout);
  if (!branchRef.startsWith("refs/heads/")) throw new Error("Push refused: HEAD is not an attached local branch");
  const branch = branchRef.slice("refs/heads/".length);
  const configured = async (key: string): Promise<string[]> => {
    const value = await git(cwd, ["config", "--null", "--get-all", key], { allowFailure: true });
    if (value.code === 1) return [];
    if (value.code !== 0) throw new Error(`Push refused: cannot read upstream configuration ${key}`);
    const values = value.stdout.toString("utf8").split("\0");
    if (values.at(-1) === "") values.pop();
    return values;
  };
  const remotes = await configured(`branch.${branch}.remote`);
  const merges = await configured(`branch.${branch}.merge`);
  if (!remotes.length || !merges.length) throw new Error(`Push refused: branch ${JSON.stringify(branch)} has no configured upstream`);
  if (remotes.length !== 1 || merges.length !== 1) throw new Error("Push refused: upstream must specify exactly one remote and one branch");
  const [remote] = remotes, [merge] = merges;
  if (remote === "." || !remote || remote.startsWith("-") || /[\x00-\x20\x7f]/.test(remote) ||
      (await git(cwd, ["check-ref-format", `refs/remotes/${remote}/pi-commit-check`], { allowFailure: true })).code !== 0) {
    throw new Error("Push refused: unsupported or unsafe upstream remote");
  }
  const knownRemotes = lineOutput((await git(cwd, ["remote"])).stdout).split("\n");
  if (!knownRemotes.includes(remote)) throw new Error("Push refused: configured upstream remote does not exist");
  if (!merge.startsWith("refs/heads/") ||
      (await git(cwd, ["check-ref-format", merge], { allowFailure: true })).code !== 0) {
    throw new Error("Push refused: upstream destination must be a valid refs/heads branch");
  }
  await git(cwd, [
    "-c", "push.default=nothing", "-c", "push.followTags=false", "-c", `remote.${remote}.mirror=false`,
    "-c", "push.recurseSubmodules=check", "push", "--no-force", "--no-follow-tags", "--recurse-submodules=check",
    "--", remote, `${branchRef}:${merge}`,
  ]);
}
