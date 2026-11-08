import { lstat, readFile, readlink } from "node:fs/promises";
import { basename, join, posix } from "node:path";
import type { ChangeStatus, FileChange, Hunk, RepoSnapshot } from "../types.js";
import { LOCK_FILE_MANIFESTS } from "../plan/validate.js";
import { digest, git, lineOutput, nulPaths } from "./process.js";

const LOCKFILES = new Set(Object.keys(LOCK_FILE_MANIFESTS));
export function isLockfile(path: string): boolean { return LOCKFILES.has(basename(path)); }
export function safePath(path: string): boolean {
  return !!path && !path.includes("\0") && !path.startsWith("/") && !path.includes("\\") &&
    !/^[A-Za-z]:/.test(path) && !path.split("/").some(p => p === ".." || p === "." || p === "" || p.toLowerCase() === ".git") && posix.normalize(path) === path;
}

export function parseHunks(path: string, diff: string): Hunk[] {
  const lines = diff.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks: Hunk[] = [];
  for (const line of lines) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      hunks.push({ id: `${path}#${hunks.length + 1}`, header: line,
        oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1),
        newStart: Number(match[3]), newLines: Number(match[4] ?? 1), lines: [], contentHash: "" });
    } else if (hunks.length && /^[ +\\-]/.test(line)) hunks.at(-1)!.lines.push(line);
  }
  for (const hunk of hunks) hunk.contentHash = digest(hunk.header, hunk.lines.join("\n"));
  return hunks;
}

export async function repositoryRoot(cwd: string): Promise<string> {
  return lineOutput((await git(cwd, ["rev-parse", "--show-toplevel"])).stdout);
}
export async function headOid(root: string): Promise<string | null> {
  const result = await git(root, ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
  return result.code === 0 ? lineOutput(result.stdout) : null;
}
/** The attached branch name, or null for a detached HEAD. */
export async function currentBranch(root: string): Promise<string | null> {
  const result = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true });
  return result.code === 0 ? lineOutput(result.stdout) : null;
}

/**
 * Checked-out submodules of `root`: gitlink entries of its index whose directory is the top of its own work tree.
 * A missing or empty directory is an uninitialized submodule (Git resolves it back to `root`), which has no local
 * changes to commit; it is skipped, never initialized. Any other layout (symlinked path, foreign work tree) is refused.
 */
export async function initializedSubmodules(root: string): Promise<string[]> {
  const gitlinks = new Set<string>();
  for (const entry of nulPaths((await git(root, ["ls-files", "--stage", "-z"])).stdout)) {
    if (entry.startsWith("160000 ")) gitlinks.add(entry.slice(entry.indexOf("\t") + 1));
  }
  const paths: string[] = [];
  for (const path of [...gitlinks].sort()) {
    if (!safePath(path)) throw new Error(`Unsupported/unsafe submodule path ${JSON.stringify(path)}`);
    const directory = join(root, path);
    const stat = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (!stat?.isDirectory()) continue; // removed or replaced: an ordinary change of `root`
    const top = await git(directory, ["rev-parse", "--show-toplevel"], { allowFailure: true });
    const toplevel = top.code === 0 ? lineOutput(top.stdout) : undefined;
    if (toplevel === root) continue;
    if (toplevel !== directory) throw new Error(`Unsupported submodule checkout ${JSON.stringify(path)}: it is not its own work tree at that path`);
    paths.push(path);
  }
  return paths;
}

/** All tracked/nonignored paths, including missing tracked files, without staging anything. */
export async function worktreePaths(root: string): Promise<string[]> {
  return [...new Set(nulPaths((await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).stdout))].sort();
}
export async function pathState(root: string, path: string): Promise<Buffer> {
  if (!safePath(path)) throw new Error(`Unsafe Git path: ${JSON.stringify(path)}`);
  try {
    let parent = root;
    for (const component of path.split("/").slice(0, -1)) {
      parent = join(parent, component);
      if ((await lstat(parent)).isSymbolicLink()) return Buffer.from(`blocked-parent-link:${parent}:${await readlink(parent)}`);
    }
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) return Buffer.from(`link:${await readlink(join(root, path))}`);
    if (stat.isDirectory()) {
      // Gitlinks are directories. Include nested dirtiness, not merely the recorded commit.
      const head = await git(join(root, path), ["rev-parse", "HEAD"], { allowFailure: true });
      const status = await git(join(root, path), ["status", "--porcelain=v2", "-z", "--untracked-files=all"], { allowFailure: true });
      return Buffer.from(`dir:${digest(head.stdout, status.stdout)}`);
    }
    if (!stat.isFile()) throw new Error(`Unsupported special file: ${JSON.stringify(path)}`);
    return Buffer.concat([Buffer.from(`file:${stat.mode & 0o111}:`), await readFile(join(root, path))]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.from("missing:");
    throw error;
  }
}
/** Suitable for between-commit drift checks: content never depends on HEAD or index tree. */
export async function worktreeDigest(root: string, fixedPaths: string[] = [], overrides: Map<string, Buffer> = new Map()): Promise<string> {
  const paths = [...new Set([...fixedPaths, ...await worktreePaths(root)])].sort();
  const parts: (string | Buffer)[] = [];
  for (const path of paths) parts.push(path, overrides.get(path) ?? await pathState(root, path));
  return digest(...parts);
}

interface NamedChange { path: string; oldPath?: string; status: ChangeStatus }
function namedChanges(bytes: Buffer): NamedChange[] {
  const fields = nulPaths(bytes), files: NamedChange[] = [];
  for (let i = 0; i < fields.length;) {
    const raw = fields[i++];
    const status = ({ A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied", T: "typechange" } as const)[raw[0] as "A"];
    if (!status) throw new Error(`Unsupported Git change ${raw} (resolve conflicts first)`);
    const first = fields[i++];
    if (raw[0] === "R" || raw[0] === "C") files.push({ status, oldPath: first, path: fields[i++] });
    else files.push({ status, path: first });
  }
  return files;
}

/**
 * Pure inspection: status uses GIT_OPTIONAL_LOCKS=0; never git add or write-tree on the real index.
 * `pendingSubmodules` (--submodules) are gitlink paths of submodules that this run commits first. Each is always a
 * whole-file change (also in staged mode, also when only dirty) whose pointer is taken from the submodule's HEAD at
 * execution, and only their state is left out of the fingerprint: HEAD, index bytes and every other path still count.
 */
export async function snapshotRepository(cwd: string, pendingSubmodules: readonly string[] = []): Promise<RepoSnapshot> {
  const root = await repositoryRoot(cwd);
  const status = (await git(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])).stdout;
  const records = nulPaths(status);
  for (let i = 0; i < records.length; i++) {
    if (records[i].startsWith("u ")) throw new Error("Resolve Git index conflicts before /commit");
    if (records[i].startsWith("2 ")) i++; // Rename source paths are data, not porcelain records.
  }
  const head = await headOid(root);
  const flags = ["-z", "--no-color", "--no-ext-diff", "--no-textconv", "--full-index", "--binary", "--unified=3", "--inter-hunk-context=0", "--ignore-submodules=none", "--submodule=short", "-M"];
  const staged = (await git(root, ["diff", "--cached", ...flags])).stdout;
  const unstaged = (await git(root, ["diff", ...flags])).stdout;
  const indexEntries = (await git(root, ["ls-files", "--stage", "-z"])).stdout;
  const indexPath = lineOutput((await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).stdout);
  let indexBytes: Buffer = Buffer.alloc(0);
  try { indexBytes = await readFile(indexPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const mode = staged.length > 0 ? "staged" : "worktree";
  const source = mode === "staged" ? ["--cached"] : [];
  const pending = new Set(pendingSubmodules);
  const names = namedChanges((await git(root, ["diff", ...source, "--name-status", "-z", "--no-ext-diff", "--no-textconv", "--ignore-submodules=none", "-M"])).stdout);
  const untracked = nulPaths((await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout);
  if (mode === "worktree") for (const path of untracked) names.push({ path, status: "added" });
  for (const path of pending) if (!names.some(change => change.path === path)) names.push({ path, status: "modified" });
  const files: FileChange[] = [], diffByFile: Record<string, string> = Object.create(null);
  for (const change of names) {
    if (!safePath(change.path) || (change.oldPath && !safePath(change.oldPath))) throw new Error(`Unsupported/unsafe Git path ${JSON.stringify(change.path)}`);
    const isUntracked = mode === "worktree" && untracked.includes(change.path);
    // A pending pointer comes from the worktree (the submodule's HEAD), even in staged mode.
    const changeSource = pending.has(change.path) ? [] : source;
    const result = isUntracked
      ? await git(root, ["diff", "--no-index", ...flags, "--", "/dev/null", change.path], { allowFailure: true })
      : await git(root, ["diff", ...changeSource, ...flags, "--", ...(change.oldPath ? [change.oldPath] : []), change.path]);
    if (isUntracked && result.code > 1) throw new Error(result.stderr.toString("utf8"));
    const diff = result.stdout.toString("utf8");
    let opaqueEncoding = false;
    try { new TextDecoder("utf-8", { fatal: true }).decode(result.stdout); } catch { opaqueEncoding = true; }
    const binary = opaqueEncoding || /(?:^GIT binary patch$|^Binary files )/m.test(diff);
    const submodule = /^(?:index .*160000|(?:old|new|new file|deleted file) mode 160000)/m.test(diff) || /^[-+]Subproject commit /m.test(diff);
    if (mode === "worktree" && submodule && !pending.has(change.path)) {
      const previous = /^-Subproject commit ([0-9a-f]+)/m.exec(diff)?.[1];
      const next = /^\+Subproject commit ([0-9a-f]+)/m.exec(diff)?.[1];
      if (previous && previous === next) throw new Error(`Dirty submodule ${JSON.stringify(change.path)} has no new commit; commit inside the submodule first`);
    }
    const hunks = binary || submodule ? [] : parseHunks(change.path, diff);
    files.push({ ...change, binary, isLockfile: isLockfile(change.path), untracked: isUntracked,
      origin: mode === "staged" && !pending.has(change.path) ? "staged" : "unstaged",
      hunkSplittable: change.status === "modified" && !binary && !submodule && hunks.length > 0 && !/^old mode /m.test(diff), hunks });
    diffByFile[change.path] = diff;
  }
  if (!pending.size) {
    const wtHash = await worktreeDigest(root);
    return { root, mode, files, headOid: head, diffByFile, fingerprint: digest(head ?? "unborn", indexBytes, indexEntries, staged, unstaged, status, wtHash) };
  }
  // Committing a pending submodule changes only its own status/diff/worktree state here; exclude exactly those paths.
  const excluded = ["--", ".", ...[...pending].map(path => `:(exclude,literal)${path}`)];
  const magic = { env: { GIT_LITERAL_PATHSPECS: "0" } };
  const otherStatus = (await git(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all", ...excluded], magic)).stdout;
  const otherUnstaged = (await git(root, ["diff", ...flags, ...excluded], magic)).stdout;
  const wtHash = await worktreeDigest(root, [], new Map([...pending].map(path => [path, Buffer.from("pending-submodule")])));
  return { root, mode, files, headOid: head, diffByFile, pendingSubmodules: [...pending].sort(),
    fingerprint: digest(head ?? "unborn", indexBytes, indexEntries, staged, otherUnstaged, otherStatus, wtHash, "pending", ...[...pending].sort()) };
}

export async function recentCommits(cwd: string, limit = 10): Promise<string> {
  const root = await repositoryRoot(cwd);
  if (!(await headOid(root))) return "(no previous commits)";
  return lineOutput((await git(root, ["log", `-${Math.max(1, Math.min(50, limit))}`, "--format=%h %s"])).stdout);
}
