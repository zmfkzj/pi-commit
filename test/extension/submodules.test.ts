import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelAdapter } from "../../src/types.js";
import { runCommitCommand, type CommitContext } from "../../src/command/run.js";
import { HELP } from "../../src/command/args.js";
import { git, lineOutput } from "../../src/git/process.js";

/**
 * /commit --submodules against real nested repositories: top -> sub -> sub/inner, each with its own local bare remote
 * and an attached `main` branch tracking it. Never touches the developer's repositories or Git configuration.
 */
const directories: string[] = [];
const savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-commit-submodules-config-")); directories.push(home);
  const config = join(home, "gitconfig");
  await writeFile(config, "[user]\n\tname = Submodule Test\n\temail = submodule-test@example.invalid\n[commit]\n\tgpgsign = false\n[protocol \"file\"]\n\tallow = always\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n");
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: "1" });
});
afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const fixtures: string[] = [];
afterEach(async () => { for (const directory of fixtures.splice(0)) await rm(directory, { recursive: true, force: true }); });

type Name = "top" | "sub" | "inner";
interface Fixture { base: string; repos: Record<Name, string>; remotes: Record<Name, string> }
const NAMES: Name[] = ["inner", "sub", "top"];

async function attach(root: string): Promise<void> {
  await git(root, ["checkout", "-q", "-B", "main", "origin/main"]);
  await git(root, ["branch", "-q", "--set-upstream-to=origin/main"]);
}
async function nested(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "pi-commit-submodules-")); fixtures.push(base);
  const remotes = { inner: join(base, "inner.git"), sub: join(base, "sub.git"), top: join(base, "top.git") };
  for (const remote of Object.values(remotes)) { await mkdir(remote); await git(remote, ["init", "-q", "--bare", "--initial-branch=main"]); }
  const seedInner = join(base, "seed-inner"), seedSub = join(base, "seed-sub"), top = join(base, "top");
  for (const dir of [seedInner, seedSub, top]) { await mkdir(dir); await git(dir, ["init", "-q", "--initial-branch=main"]); }
  await writeFile(join(seedInner, "inner.txt"), "inner base\n");
  await git(seedInner, ["add", "--all"]); await git(seedInner, ["commit", "-qm", "Inner base"]); await git(seedInner, ["push", "-q", remotes.inner, "main"]);
  await writeFile(join(seedSub, "sub.txt"), "sub base\n");
  await git(seedSub, ["submodule", "add", "-q", remotes.inner, "inner"]);
  await git(seedSub, ["add", "--all"]); await git(seedSub, ["commit", "-qm", "Sub base"]); await git(seedSub, ["push", "-q", remotes.sub, "main"]);
  await writeFile(join(top, "top.txt"), "top base\n");
  await git(top, ["submodule", "add", "-q", remotes.sub, "sub"]);
  await git(top, ["add", "--all"]); await git(top, ["commit", "-qm", "Top base"]);
  await git(top, ["remote", "add", "origin", remotes.top]); await git(top, ["push", "-q", "-u", "origin", "main"]);
  await git(top, ["submodule", "update", "-q", "--init", "--recursive"]);
  const repos = { top, sub: join(top, "sub"), inner: join(top, "sub", "inner") };
  await attach(repos.sub); await attach(repos.inner);
  return { base, repos, remotes };
}
const out = async (root: string, args: string[]) => lineOutput((await git(root, args)).stdout);
const head = (root: string) => out(root, ["rev-parse", "HEAD"]);
async function remoteRef(remote: string): Promise<string | null> {
  const result = await git(remote, ["rev-parse", "--verify", "--quiet", "refs/heads/main"], { allowFailure: true });
  return result.code === 0 ? lineOutput(result.stdout) : null;
}
/** HEAD, real index bytes, status, staged/unstaged diffs and untracked contents of every repository, plus remote refs. */
async function state(fixture: Fixture) {
  const result: Record<string, unknown> = {};
  for (const name of NAMES) {
    const root = fixture.repos[name];
    const index = await readFile(await out(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]));
    result[name] = { head: await head(root), index, status: await out(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
      unstaged: await out(root, ["diff"]), staged: await out(root, ["diff", "--cached"]), remote: await remoteRef(fixture.remotes[name]) };
  }
  return result;
}
async function hook(root: string, name: string, body: string): Promise<void> {
  const path = join(await out(root, ["rev-parse", "--path-format=absolute", "--git-path", "hooks"]), name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `#!/bin/sh\n${body}\n`); await chmod(path, 0o755);
}
/** One commit per repository; records which files each planning call saw, in call order. */
function model(options: { entries?: boolean; failOn?: string } = {}) {
  const planned: string[][] = [];
  const adapter: ModelAdapter = { async complete(messages) {
    const files = (JSON.parse(messages[1]!.content) as { git_overview: { files: { path: string }[] } }).git_overview.files.map(file => file.path);
    planned.push(files);
    if (options.failOn && files.includes(options.failOn)) throw new Error("planner unavailable");
    const groups = [{ id: "g1", message: { subject: `Commit ${[...files].sort().join(" ")}`.slice(0, 72) }, selectors: files.map(path => ({ path, hunks: "all" })), dependsOn: [],
      ...(options.entries ? { changelogEntry: `Changed: ${[...files].sort()[0]}` } : {}) }];
    return { text: JSON.stringify({ groups }) };
  } };
  return { adapter, planned };
}
function context(root: string, hasUI = false, confirm: CommitContext["ui"]["confirm"] = async () => true): CommitContext {
  return { cwd: root, mode: hasUI ? "tui" : "print", hasUI, model: undefined, signal: undefined,
    modelRegistry: { find: () => undefined, streamSimple: () => { throw new Error("Unexpected real model call"); } }, ui: { confirm } };
}
async function run(root: string, args: string, adapter: ModelAdapter, ctx = context(root)) {
  const outputs: string[] = [];
  const result = await runCommitCommand(args, ctx, { adapter, output: text => outputs.push(text) });
  return { result, output: outputs.join("\n"), outputs };
}
/** inner, sub and top each get an own-file edit. */
async function editAll(fixture: Fixture): Promise<void> {
  await writeFile(join(fixture.repos.inner, "inner.txt"), "inner changed\n");
  await writeFile(join(fixture.repos.sub, "sub.txt"), "sub changed\n");
  await writeFile(join(fixture.repos.top, "top.txt"), "top changed\n");
}

describe("/commit --submodules surfaces", () => {
  test("help documents --submodules and its push semantics", () => {
    expect(HELP).toContain("[--submodules]");
    expect(HELP).toMatch(/--submodules\s+Also commit changed descendant submodules \(recursively\)/);
    expect(HELP).toContain("Without --push nothing is pushed.");
  });
});

describe("/commit --submodules with nested submodules", () => {
  test("commits inner -> sub -> top in order; each parent records the new child commit; nothing is pushed without --push", async () => {
    const fixture = await nested(), { repos, remotes } = fixture; await editAll(fixture);
    const before = await state(fixture), planner = model();
    const { result, output, outputs } = await run(repos.top, "--submodules --yes", planner.adapter);
    expect(result.status).toBe("executed"); expect(result.error).toBeUndefined(); expect(result.pushed).toBeUndefined();
    expect(planner.planned).toEqual([["inner.txt"], ["inner", "sub.txt"], ["sub", "top.txt"]]);
    expect(result.repositories!.map(repository => repository.path)).toEqual(["sub/inner", "sub", ""]);
    const innerHead = await head(repos.inner), subHead = await head(repos.sub), topHead = await head(repos.top);
    expect(result.repositories!.map(repository => repository.execution!.succeeded.at(-1)!.oid)).toEqual([innerHead, subHead, topHead]);
    expect(await out(repos.sub, ["rev-parse", "HEAD:inner"])).toBe(innerHead);
    expect(await out(repos.top, ["rev-parse", "HEAD:sub"])).toBe(subHead);
    expect(await out(repos.inner, ["show", "HEAD:inner.txt"])).toBe("inner changed");
    expect(await out(repos.sub, ["show", "HEAD:sub.txt"])).toBe("sub changed");
    expect(await out(repos.top, ["show", "HEAD:top.txt"])).toBe("top changed");
    for (const name of NAMES) {
      expect(await out(repos[name], ["rev-list", "--count", "HEAD"])).toBe("2");
      expect(await out(repos[name], ["status", "--porcelain", "--untracked-files=all"])).toBe("");
      expect(await remoteRef(remotes[name])).toBe((before[name] as { remote: string }).remote);
      expect(await out(repos[name], ["symbolic-ref", "--short", "HEAD"])).toBe("main");
    }
    expect(outputs[0]).toBe("pi-commit: analyzing changes and planning commits…");
    for (const text of [`Submodule "sub/inner": Committed 1 commit:\n${innerHead.slice(0, 7)} Commit inner.txt`, `Submodule "sub": Committed 1 commit:\n${subHead.slice(0, 7)} Commit inner sub.txt`, `Top-level repository: Committed 1 commit:\n${topHead.slice(0, 7)} Commit sub top.txt`]) expect(output).toContain(text);
    expect(output).not.toContain("pi-commit plan"); expect(output).not.toContain("Push");
  });

  test("a change only in the nested submodule yields pointer-only commits in every ancestor", async () => {
    const { repos } = await nested();
    await writeFile(join(repos.inner, "new.txt"), "untracked in inner\n");
    const { result } = await run(repos.top, "--submodules --yes --no-changelog", model().adapter);
    expect(result.status).toBe("executed"); expect(result.error).toBeUndefined();
    const innerHead = await head(repos.inner), subHead = await head(repos.sub);
    expect(await out(repos.inner, ["show", "HEAD:new.txt"])).toBe("untracked in inner");
    expect(await out(repos.sub, ["rev-parse", "HEAD:inner"])).toBe(innerHead);
    expect(await out(repos.sub, ["show", "--name-only", "--format=", "HEAD"])).toBe("inner");
    expect(await out(repos.top, ["rev-parse", "HEAD:sub"])).toBe(subHead);
    expect(await out(repos.top, ["show", "--name-only", "--format=", "HEAD"])).toBe("sub");
    expect(await out(repos.top, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  });

  test("dry-run, cancel and refusal plan every repository but write nothing anywhere", async () => {
    const fixture = await nested(); await editAll(fixture);
    const before = await state(fixture);
    const dry = await run(fixture.repos.top, "--submodules --dry-run --yes --push", model().adapter, context(fixture.repos.top, true, async () => { throw new Error("must not confirm"); }));
    expect(dry.result.status).toBe("dry-run"); expect(await state(fixture)).toEqual(before);
    for (const text of ["pi-commit plan (--submodules): 3 commit(s) in 3 repositories", "Repository order: submodule \"sub/inner\" -> submodule \"sub\" -> top-level repository",
      "=== 1/3: Submodule \"sub/inner\" ===", "=== 3/3: Top-level repository ===", "Branch: \"main\"", "\"inner\" [modified, submodule pointer -> its new HEAD from this run]",
      "\"sub\" [modified, submodule pointer -> its new HEAD from this run]", "EXPLICIT PUSH REQUEST: after ALL commits in ALL repositories succeed", "Dry-run: no repository or remote writes."]) expect(dry.output).toContain(text);
    expect(dry.output).not.toContain("inner changed"); expect(dry.output).not.toMatch(/^(\+|-|@@|diff --git)/m);

    let dialog = "", confirmations = 0;
    const cancelled = await run(fixture.repos.top, "--submodules", model().adapter, context(fixture.repos.top, true, async (_title, text) => { confirmations++; dialog = text; return false; }));
    expect(cancelled.result.status).toBe("cancelled"); expect(confirmations).toBe(1); expect(await state(fixture)).toEqual(before);
    expect(dialog).toContain("No push requested: nothing is pushed in any repository."); expect(dialog).toEndWith("Create 3 commit(s) in 3 repositories?");

    const refused = await run(fixture.repos.top, "--submodules --push", model().adapter);
    expect(refused.result.status).toBe("refused"); expect(refused.output).toContain("pi-commit plan (--submodules)"); expect(refused.output).toContain("--yes");
    expect(await state(fixture)).toEqual(before);
  });

  test("staged parent and staged child: staged content plus the new child pointers are committed; unstaged/untracked work stays; no reverse-staged gitlinks", async () => {
    const { repos } = await nested();
    await writeFile(join(repos.inner, "inner.txt"), "inner changed\n");
    await writeFile(join(repos.sub, "sub.txt"), "sub staged\n"); await git(repos.sub, ["add", "--", "sub.txt"]);
    await writeFile(join(repos.sub, "sub.txt"), "sub staged\nsub unstaged\n");
    await writeFile(join(repos.top, "top.txt"), "top staged\n"); await git(repos.top, ["add", "--", "top.txt"]);
    await writeFile(join(repos.top, "top.txt"), "top staged\ntop unstaged\n"); await writeFile(join(repos.top, "untracked.txt"), "keep out\n");
    let dialog = "";
    const planner = model();
    const { result } = await run(repos.top, "--submodules", planner.adapter, context(repos.top, true, async (_title, text) => { dialog = text; return true; }));
    expect(result.status).toBe("executed"); expect(result.error).toBeUndefined();
    expect(planner.planned).toEqual([["inner.txt"], ["sub.txt", "inner"], ["top.txt", "sub"]]);
    expect(dialog).toContain("Mode: staged (ONLY staged changes; unstaged edits preserved)");
    expect(dialog).toContain("\"sub\" [modified, submodule pointer -> its new HEAD from this run]");
    const innerHead = await head(repos.inner), subHead = await head(repos.sub);
    expect(await out(repos.sub, ["show", "HEAD:sub.txt"])).toBe("sub staged");
    expect(await out(repos.sub, ["rev-parse", "HEAD:inner"])).toBe(innerHead);
    expect(await out(repos.top, ["show", "HEAD:top.txt"])).toBe("top staged");
    expect(await out(repos.top, ["rev-parse", "HEAD:sub"])).toBe(subHead);
    expect(await out(repos.top, ["show", "--name-only", "--format=", "HEAD"])).toBe("sub\ntop.txt");
    // Real indexes record the committed pointers (no staged reversal); unstaged and untracked work is untouched.
    for (const root of [repos.sub, repos.top]) expect(await out(root, ["diff", "--cached"])).toBe("");
    expect(await readFile(join(repos.sub, "sub.txt"), "utf8")).toBe("sub staged\nsub unstaged\n");
    expect(await readFile(join(repos.top, "top.txt"), "utf8")).toBe("top staged\ntop unstaged\n");
    // ` M sub` is only the submodule's kept unstaged edit: its recorded pointer equals the committed one.
    expect(await out(repos.top, ["status", "--porcelain", "--untracked-files=all"])).toBe(" M sub\n M top.txt\n?? untracked.txt");
    expect(await out(repos.top, ["ls-files", "--stage", "--", "sub"])).toBe(`160000 ${subHead} 0\tsub`);
    expect(await out(repos.top, ["diff", "--submodule=short", "--", "sub"])).toContain(`+Subproject commit ${subHead}-dirty`);
    expect(await out(repos.sub, ["status", "--porcelain", "--untracked-files=all"])).toBe(" M sub.txt");
  });

  test("--push pushes inner, sub and top (children first) to their upstreams", async () => {
    const fixture = await nested(), { repos, remotes } = fixture; await editAll(fixture);
    const { result, outputs } = await run(repos.top, "--submodules --push --yes --no-changelog", model().adapter);
    expect(result.status).toBe("executed"); expect(result.error).toBeUndefined(); expect(result.pushed).toBe(true);
    for (const name of NAMES) expect(await remoteRef(remotes[name])).toBe(await head(repos[name]));
    expect(result.repositories!.every(repository => repository.pushed)).toBe(true);
    expect(outputs.at(-1)).toBe("Push completed: submodule \"sub/inner\", submodule \"sub\", top-level repository.");
  });

  test("--push readiness is checked before any commit: a detached nested submodule refuses with no writes", async () => {
    const fixture = await nested(); await editAll(fixture);
    await git(fixture.repos.inner, ["checkout", "-q", "--detach"]);
    const before = await state(fixture);
    const { result, output } = await run(fixture.repos.top, "--submodules --push --yes", model().adapter);
    expect(result.status).toBe("error");
    expect(output).toContain("pi-commit: --push refused before any commit: submodule \"sub/inner\": Push refused: HEAD is detached");
    expect(await state(fixture)).toEqual(before);
  });

  test("detached submodules can still be committed without --push; the plan says so", async () => {
    const fixture = await nested(); await editAll(fixture);
    await git(fixture.repos.inner, ["checkout", "-q", "--detach"]);
    let dialog = "";
    const { result } = await run(fixture.repos.top, "--submodules", model().adapter, context(fixture.repos.top, true, async (_title, text) => { dialog = text; return true; }));
    expect(dialog).toContain("Branch: DETACHED HEAD");
    expect(result.status).toBe("executed"); expect(result.error).toBeUndefined();
    expect(await out(fixture.repos.sub, ["rev-parse", "HEAD:inner"])).toBe(await head(fixture.repos.inner));
  });

  test("a rejected child push stops before its ancestors; earlier pushes and all local commits are kept and reported", async () => {
    const fixture = await nested(), { repos, remotes } = fixture; await editAll(fixture);
    // Someone else advanced the sub remote: sub's push is a non-fast-forward.
    const peer = join(fixture.base, "peer-sub"); await git(fixture.base, ["clone", "-q", remotes.sub, peer]);
    await writeFile(join(peer, "peer.txt"), "peer\n"); await git(peer, ["add", "--all"]); await git(peer, ["commit", "-qm", "Peer"]); await git(peer, ["push", "-q", "origin", "main"]);
    const subRemote = await remoteRef(remotes.sub), topRemote = await remoteRef(remotes.top);
    const { result, outputs } = await run(repos.top, "--submodules --push --yes --no-changelog", model().adapter);
    expect(result.status).toBe("executed"); expect(result.pushed).toBeUndefined();
    expect(result.repositories!.map(repository => repository.execution?.succeeded.length)).toEqual([1, 1, 1]);
    expect(await remoteRef(remotes.inner)).toBe(await head(repos.inner));
    expect(await remoteRef(remotes.sub)).toBe(subRemote); expect(await remoteRef(remotes.top)).toBe(topRemote);
    expect(result.error).toStartWith("Submodule \"sub\": Push failed or refused; local commits remain (3 commits created locally).");
    expect(result.error).toContain("Already pushed: submodule \"sub/inner\""); expect(result.error).toContain("Not pushed: top-level repository");
    expect(outputs.at(-1)).toBe(result.error!);
    expect(await out(repos.top, ["rev-parse", "HEAD:sub"])).toBe(await head(repos.sub));
  });

  test("a failing child commit hook stops before the parents; nothing is pushed", async () => {
    const fixture = await nested(), { repos } = fixture; await editAll(fixture);
    await hook(repos.inner, "pre-commit", "exit 1");
    const before = await state(fixture);
    const { result, output } = await run(repos.top, "--submodules --push --yes", model().adapter);
    expect(result.status).toBe("executed"); expect(result.pushed).toBeUndefined();
    expect(result.repositories![0]!.execution!.succeeded).toHaveLength(0);
    expect(result.repositories![1]!.execution).toBeUndefined(); expect(result.repositories![2]!.execution).toBeUndefined();
    expect(result.error).toContain("Stopped. Submodule \"sub/inner\": Commit g1 failed");
    expect(result.error).toContain("Not committed: submodule \"sub\", top-level repository"); expect(result.error).toContain("Nothing was pushed.");
    expect(output).toContain("Submodule \"sub/inner\": Commit failed; stopped.");
    expect(await state(fixture)).toEqual(before);
  });

  test("a child hook that edits a parent file trips the parent's drift guard; the child commits stay and are reported", async () => {
    const fixture = await nested(), { repos } = fixture; await editAll(fixture);
    const topBefore = await head(repos.top);
    await hook(repos.inner, "pre-commit", `printf 'hook edit\\n' >> '${join(repos.top, "top.txt")}'`);
    const { result, output } = await run(repos.top, "--submodules --yes", model().adapter);
    expect(result.status).toBe("executed");
    expect(result.repositories!.map(repository => repository.execution?.succeeded.length)).toEqual([1, 1, 0]);
    expect(result.error).toContain("Stopped. Top-level repository: Repository changed since preview");
    expect(output).toContain("Submodule \"sub\": Committed 1 commit:");
    expect(await head(repos.top)).toBe(topBefore);
    expect(await readFile(join(repos.top, "top.txt"), "utf8")).toBe("top changed\nhook edit\n");
  });

  test("a submodule HEAD moved while the parent commits is detected; the parent records only this run's commit", async () => {
    const fixture = await nested(), { repos } = fixture; await editAll(fixture);
    await hook(repos.top, "pre-commit", `cd '${repos.sub}' && env -u GIT_INDEX_FILE -u GIT_DIR -u GIT_WORK_TREE git commit -q --allow-empty -m 'Moved by hook'`);
    const { result } = await run(repos.top, "--submodules --yes", model().adapter);
    expect(result.status).toBe("executed"); expect(result.error).toContain("Stopped. Top-level repository:");
    const runCommit = result.repositories![1]!.execution!.succeeded.at(-1)!.oid;
    expect(await out(repos.sub, ["log", "-1", "--format=%s"])).toBe("Moved by hook");
    expect(await out(repos.top, ["rev-parse", "HEAD:sub"])).toBe(runCommit);
  });

  test("a child planning failure is reported with its repository before any write", async () => {
    const fixture = await nested(); await editAll(fixture);
    const before = await state(fixture);
    const { result, output } = await run(fixture.repos.top, "--submodules --yes", model({ failOn: "sub.txt" }).adapter);
    expect(result.status).toBe("error"); expect(output).toContain("pi-commit: submodule \"sub\":");
    expect(await state(fixture)).toEqual(before);
  });

  test("default changelog generation applies per repository", async () => {
    const fixture = await nested(), { repos } = fixture; await editAll(fixture);
    const { result } = await run(repos.top, "--submodules --yes", model({ entries: true }).adapter);
    expect(result.status).toBe("executed"); expect(result.error).toBeUndefined();
    expect(await out(repos.inner, ["show", "HEAD:CHANGELOG.md"])).toContain("- inner.txt");
    expect(await out(repos.sub, ["show", "HEAD:CHANGELOG.md"])).toContain("- inner");
    expect(await out(repos.top, ["show", "HEAD:CHANGELOG.md"])).toContain("- sub");
    for (const name of NAMES) expect(await out(repos[name], ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  });

  test("an already-committed, unpublished clean submodule is pushed before the parent that commits its new pointer", async () => {
    const { repos, remotes } = await nested();
    await writeFile(join(repos.sub, "sub.txt"), "committed by hand\n"); await git(repos.sub, ["commit", "-qam", "Manual sub commit"]);
    const subHead = await head(repos.sub);
    let dialog = "";
    const { result } = await run(repos.top, "--submodules --push", model().adapter, context(repos.top, true, async (_title, text) => { dialog = text; return true; }));
    expect(dialog).toContain("Also pushed first (already committed, not yet on a remote, and referenced by the commits being pushed): submodule \"sub\"");
    expect(dialog).toContain("Push order: submodule \"sub\" -> top-level repository");
    expect(dialog).toEndWith("Create 1 commit(s) in 1 repositories AND push 2 repositories?");
    expect(result.status).toBe("executed"); expect(result.error).toBeUndefined(); expect(result.pushed).toBe(true);
    expect(await out(repos.sub, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(await remoteRef(remotes.sub)).toBe(subHead);
    expect(await out(repos.top, ["rev-parse", "HEAD:sub"])).toBe(subHead);
    expect(await remoteRef(remotes.top)).toBe(await head(repos.top));
  });
});

/** inner gets an unpushed commit by hand and sub an unpushed commit recording it; both stay clean. */
async function commitDescendantsByHand(repos: Fixture["repos"]): Promise<{ innerHead: string; subHead: string }> {
  await writeFile(join(repos.inner, "inner.txt"), "inner by hand\n"); await git(repos.inner, ["commit", "-qam", "Manual inner commit"]);
  await git(repos.sub, ["add", "--", "inner"]); await git(repos.sub, ["commit", "-qm", "Manual sub pointer commit"]);
  const innerHead = await head(repos.inner), subHead = await head(repos.sub);
  expect(await out(repos.sub, ["rev-parse", "HEAD:inner"])).toBe(innerHead);
  return { innerHead, subHead };
}

describe("/commit --submodules --push publishes already-committed descendants at any depth", () => {
  test("clean unpublished commits two levels down are pushed children first before the parent that records them", async () => {
    const fixture = await nested(), { repos, remotes } = fixture;
    const { innerHead, subHead } = await commitDescendantsByHand(repos);
    const before = await state(fixture);
    const plain = await run(repos.top, "--submodules --dry-run", model().adapter);
    expect(plain.output).toContain("No push requested."); expect(plain.output).not.toContain("Push order");
    const dry = await run(repos.top, "--submodules --push --dry-run", model().adapter);
    expect(dry.output).toContain("Also pushed first (already committed, not yet on a remote, and referenced by the commits being pushed): submodule \"sub/inner\", submodule \"sub\"");
    expect(dry.output).toContain("Push order: submodule \"sub/inner\" -> submodule \"sub\" -> top-level repository");
    expect(await state(fixture)).toEqual(before);
    let dialog = "";
    const { result, outputs } = await run(repos.top, "--submodules --push --no-changelog", model().adapter, context(repos.top, true, async (_title, text) => { dialog = text; return true; }));
    expect(dialog).toEndWith("Create 1 commit(s) in 1 repositories AND push 3 repositories?");
    expect(result.status).toBe("executed"); expect(result.error).toBeUndefined(); expect(result.pushed).toBe(true);
    expect(result.repositories!.map(repository => repository.path)).toEqual([""]);
    expect(await remoteRef(remotes.inner)).toBe(innerHead); expect(await remoteRef(remotes.sub)).toBe(subHead);
    expect(await out(repos.top, ["rev-parse", "HEAD:sub"])).toBe(subHead);
    expect(await remoteRef(remotes.top)).toBe(await head(repos.top));
    for (const name of ["inner", "sub"] as const) expect(await out(repos[name], ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(outputs.at(-1)).toBe("Push completed: submodule \"sub/inner\", submodule \"sub\", top-level repository.");
  });

  test("descendant commits referenced by an existing unpushed parent commit are published with it", async () => {
    const fixture = await nested(), { repos, remotes } = fixture;
    const { innerHead, subHead } = await commitDescendantsByHand(repos);
    await git(repos.top, ["add", "--", "sub"]); await git(repos.top, ["commit", "-qm", "Manual top pointer commit"]);
    await writeFile(join(repos.top, "top.txt"), "top changed\n");
    const { result, outputs } = await run(repos.top, "--submodules --push --yes --no-changelog", model().adapter);
    expect(result.status).toBe("executed"); expect(result.error).toBeUndefined(); expect(result.pushed).toBe(true);
    expect(result.repositories!.map(repository => repository.path)).toEqual([""]);
    expect(await out(repos.top, ["show", "HEAD:top.txt"])).toBe("top changed");
    expect(await remoteRef(remotes.inner)).toBe(innerHead); expect(await remoteRef(remotes.sub)).toBe(subHead);
    expect(await remoteRef(remotes.top)).toBe(await head(repos.top));
    expect(outputs.at(-1)).toBe("Push completed: submodule \"sub/inner\", submodule \"sub\", top-level repository.");
  });

  test("a submodule committed in this run first publishes the nested commit its earlier local commit references", async () => {
    const fixture = await nested(), { repos, remotes } = fixture;
    const { innerHead } = await commitDescendantsByHand(repos);
    await writeFile(join(repos.sub, "sub.txt"), "sub changed\n");
    const { result, outputs } = await run(repos.top, "--submodules --push --yes --no-changelog", model().adapter);
    expect(result.status).toBe("executed"); expect(result.error).toBeUndefined(); expect(result.pushed).toBe(true);
    expect(result.repositories!.map(repository => repository.path)).toEqual(["sub", ""]);
    const subHead = await head(repos.sub);
    expect(await out(repos.sub, ["rev-list", "--count", "HEAD"])).toBe("3"); expect(await out(repos.inner, ["rev-list", "--count", "HEAD"])).toBe("2");
    expect(await remoteRef(remotes.inner)).toBe(innerHead); expect(await remoteRef(remotes.sub)).toBe(subHead);
    expect(await out(repos.top, ["rev-parse", "HEAD:sub"])).toBe(subHead);
    expect(await remoteRef(remotes.top)).toBe(await head(repos.top));
    expect(outputs.at(-1)).toBe("Push completed: submodule \"sub/inner\", submodule \"sub\", top-level repository.");
  });

  test("a deep dependency that cannot be pushed (detached, then no upstream) is refused before any commit", async () => {
    const fixture = await nested(), { repos } = fixture;
    await writeFile(join(repos.inner, "inner.txt"), "inner by hand\n"); await git(repos.inner, ["commit", "-qam", "Manual inner commit"]);
    await git(repos.inner, ["checkout", "-q", "--detach"]);
    await git(repos.sub, ["add", "--", "inner"]); await git(repos.sub, ["commit", "-qm", "Manual sub pointer commit"]);
    const before = await state(fixture);
    const detached = await run(repos.top, "--submodules --push --yes", model().adapter);
    expect(detached.result.status).toBe("error");
    expect(detached.output).toContain("pi-commit: --push refused before any commit: submodule \"sub/inner\": Push refused: HEAD is detached");
    expect(await state(fixture)).toEqual(before);
    await git(repos.inner, ["checkout", "-q", "main"]); await git(repos.inner, ["branch", "-q", "--unset-upstream"]);
    const reattached = await state(fixture);
    const noUpstream = await run(repos.top, "--submodules --push --yes", model().adapter);
    expect(noUpstream.result.status).toBe("error");
    expect(noUpstream.output).toContain("pi-commit: --push refused before any commit: submodule \"sub/inner\": Push refused: branch \"main\" has no configured upstream");
    expect(await state(fixture)).toEqual(reattached);
  });

  test("without a top-level upstream, publishing descendants is refused before any commit; cancel and no-confirm write nothing", async () => {
    const fixture = await nested(), { repos } = fixture;
    await commitDescendantsByHand(repos);
    await git(repos.top, ["branch", "-q", "--unset-upstream"]);
    const before = await state(fixture);
    const dry = await run(repos.top, "--submodules --push --dry-run", model().adapter);
    expect(dry.result.status).toBe("dry-run"); expect(dry.output).toContain("Push order: submodule \"sub/inner\" -> submodule \"sub\" -> top-level repository");
    const refused = await run(repos.top, "--submodules --push --yes", model().adapter);
    expect(refused.result.status).toBe("error");
    expect(refused.output).toContain("pi-commit: --push refused before any commit: top-level repository: Push refused: branch \"main\" has no configured upstream");
    expect(await state(fixture)).toEqual(before);
    // With a valid upstream again: cancel and the no-UI refusal write nothing either.
    await git(repos.top, ["branch", "-q", "--set-upstream-to=origin/main"]);
    const restored = await state(fixture);
    const cancelled = await run(repos.top, "--submodules --push", model().adapter, context(repos.top, true, async () => false));
    expect(cancelled.result.status).toBe("cancelled");
    const noUI = await run(repos.top, "--submodules --push", model().adapter);
    expect(noUI.result.status).toBe("refused"); expect(noUI.output).toContain("Also pushed first");
    expect(await state(fixture)).toEqual(restored);
  });

  test("a rejected deep publication stops before its ancestors; local commits are kept and reported", async () => {
    const fixture = await nested(), { repos, remotes } = fixture;
    const { innerHead, subHead } = await commitDescendantsByHand(repos);
    // Someone else advanced the inner remote: inner's push is a non-fast-forward.
    const peer = join(fixture.base, "peer-inner"); await git(fixture.base, ["clone", "-q", remotes.inner, peer]);
    await writeFile(join(peer, "peer.txt"), "peer\n"); await git(peer, ["add", "--all"]); await git(peer, ["commit", "-qm", "Peer"]); await git(peer, ["push", "-q", "origin", "main"]);
    const remotesBefore = { inner: await remoteRef(remotes.inner), sub: await remoteRef(remotes.sub), top: await remoteRef(remotes.top) };
    const { result, outputs } = await run(repos.top, "--submodules --push --yes --no-changelog", model().adapter);
    expect(result.status).toBe("executed"); expect(result.pushed).toBeUndefined();
    expect(result.repositories!.map(repository => repository.execution?.succeeded.length)).toEqual([1]);
    expect(await remoteRef(remotes.inner)).toBe(remotesBefore.inner); expect(await remoteRef(remotes.sub)).toBe(remotesBefore.sub);
    expect(await remoteRef(remotes.top)).toBe(remotesBefore.top);
    expect(result.error).toStartWith("Submodule \"sub/inner\": Push failed or refused; local commits remain (1 commit created locally).");
    expect(result.error).toContain("Nothing was pushed."); expect(result.error).toContain("Not pushed: submodule \"sub\", top-level repository");
    expect(outputs.at(-1)).toBe(result.error!);
    expect(await head(repos.inner)).toBe(innerHead); expect(await out(repos.top, ["rev-parse", "HEAD:sub"])).toBe(subHead);
  });

  test("staged mode follows the staged pointer: a published staged commit does not publish a newer unstaged checkout HEAD", async () => {
    const fixture = await nested(), { repos, remotes } = fixture;
    const peer = join(fixture.base, "peer-sub"); await git(fixture.base, ["clone", "-q", remotes.sub, peer]);
    await writeFile(join(peer, "peer.txt"), "peer\n"); await git(peer, ["add", "--all"]); await git(peer, ["commit", "-qm", "Peer"]); await git(peer, ["push", "-q", "origin", "main"]);
    const published = (await remoteRef(remotes.sub))!;
    await git(repos.sub, ["fetch", "-q", "origin"]); await git(repos.sub, ["merge", "-q", "--ff-only", "origin/main"]);
    await git(repos.top, ["add", "--", "sub"]);
    // A newer, unpublished commit on the submodule's tracked branch that the staged pointer does not reference.
    await writeFile(join(repos.sub, "sub.txt"), "newer local\n"); await git(repos.sub, ["commit", "-qam", "Newer local commit"]);
    const newer = await head(repos.sub);
    const { result, outputs } = await run(repos.top, "--submodules --push --yes --no-changelog", model().adapter);
    expect(result.status).toBe("executed"); expect(result.error).toBeUndefined(); expect(result.pushed).toBe(true);
    expect(result.snapshot!.mode).toBe("staged"); expect(result.repositories).toBeUndefined();
    expect(await out(repos.top, ["rev-parse", "HEAD:sub"])).toBe(published);
    expect(await remoteRef(remotes.sub)).toBe(published); expect(await head(repos.sub)).toBe(newer);
    expect(await remoteRef(remotes.top)).toBe(await head(repos.top));
    expect(outputs.at(-1)).toBe("Push completed.");
  });

  test("an already-published submodule commit is not pushed or push-checked, even on a detached HEAD", async () => {
    const fixture = await nested(), { repos, remotes } = fixture;
    const peer = join(fixture.base, "peer-sub"); await git(fixture.base, ["clone", "-q", remotes.sub, peer]);
    await writeFile(join(peer, "peer.txt"), "peer\n"); await git(peer, ["add", "--all"]); await git(peer, ["commit", "-qm", "Peer"]); await git(peer, ["push", "-q", "origin", "main"]);
    const published = await remoteRef(remotes.sub);
    // Like `git submodule update --remote`: the submodule is detached at a commit already on its remote.
    await git(repos.sub, ["fetch", "-q", "origin"]); await git(repos.sub, ["checkout", "-q", "--detach", "origin/main"]);
    const { result, outputs } = await run(repos.top, "--submodules --push --yes --no-changelog", model().adapter);
    expect(result.status).toBe("executed"); expect(result.error).toBeUndefined(); expect(result.pushed).toBe(true);
    expect(result.repositories).toBeUndefined();
    expect(await out(repos.top, ["rev-parse", "HEAD:sub"])).toBe(published!);
    expect(await remoteRef(remotes.top)).toBe(await head(repos.top)); expect(await remoteRef(remotes.sub)).toBe(published);
    expect(outputs.at(-1)).toBe("Push completed.");
  });
});

describe("without --submodules (unchanged behavior)", () => {
  test("a dirty-only submodule is still refused and nothing is written", async () => {
    const fixture = await nested(); await writeFile(join(fixture.repos.inner, "inner.txt"), "inner changed\n");
    const before = await state(fixture);
    const { result, output } = await run(fixture.repos.top, "--yes", model().adapter);
    expect(result.status).toBe("error"); expect(output).toContain("Dirty submodule \"sub\" has no new commit");
    expect(await state(fixture)).toEqual(before);
  });
  test("--submodules with no submodule work is the ordinary single-repository run", async () => {
    const fixture = await nested(); await writeFile(join(fixture.repos.top, "top.txt"), "top changed\n");
    const plain = await run(fixture.repos.top, "--dry-run", model().adapter);
    const flagged = await run(fixture.repos.top, "--dry-run --submodules", model().adapter);
    expect(flagged.result.repositories).toBeUndefined(); expect(flagged.outputs).toEqual(plain.outputs);
    expect(flagged.output).toContain("pi-commit plan\nRepository:");
  });
});
