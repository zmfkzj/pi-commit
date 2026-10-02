import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readlink, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitGroup, CommitPlan, RepoSnapshot, Selector } from "../../src/types.js";
import { executePlan, isLockfile, pushRepository, snapshotRepository } from "../../src/git/index.js";
import { git, lineOutput } from "../../src/git/process.js";

const repos: string[] = [];
afterEach(async () => { for (const path of repos.splice(0)) await rm(path, { recursive: true, force: true }); });
async function repo(initial: Record<string, string | Buffer> = { "file.txt": "base\n" }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-commit-git-test-")); repos.push(root);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  for (const [path, content] of Object.entries(initial)) await writeFile(join(root, path), content);
  if (Object.keys(initial).length) { await git(root, ["add", "--all"]); await git(root, ["commit", "-qm", "Initial"]); }
  return root;
}
function group(id: string, selectors: Selector[], dependsOn: string[] = []): CommitGroup {
  return { id, selectors, dependsOn, message: { subject: `Update ${id}` } };
}
function all(snapshot: RepoSnapshot): CommitPlan { return { groups: [group("all", snapshot.files.map(f => ({ path: f.path, hunks: "all" })))] }; }
async function index(root: string): Promise<Buffer | null> { try { return await readFile(join(root, ".git", "index")); } catch { return null; } }
async function show(root: string, path: string, ref = "HEAD"): Promise<string> { return (await git(root, ["show", `${ref}:${path}`])).stdout.toString("utf8"); }
async function hook(root: string, text: string): Promise<void> { const path = join(root, ".git", "hooks", "pre-commit"); await writeFile(path, `#!/bin/sh\n${text}\n`); await chmod(path, 0o755); }
const lines = () => Array.from({ length: 90 }, (_, i) => `line ${i + 1}\n`).join("");
const edited = () => lines().replace("line 5\n", "changed 5\ninsert a\ninsert b\n").replace("line 55\n", "changed 55\n");

describe("read-only snapshot", () => {
  test("empty index plans tracked and nonignored untracked without staging; bytes immutable", async () => {
    const root = await repo();
    await writeFile(join(root, "file.txt"), "changed\n");
    await writeFile(join(root, "new.txt"), "new\n");
    await writeFile(join(root, ".gitignore"), "ignored\n");
    await writeFile(join(root, "ignored"), "secret\n");
    const before = await index(root), head = (await git(root, ["rev-parse", "HEAD"])).stdout;
    const snapshot = await snapshotRepository(root);
    expect(snapshot.mode).toBe("worktree");
    expect(snapshot.files.map(f => f.path).sort()).toEqual([".gitignore", "file.txt", "new.txt"]);
    expect(snapshot.files.find(f => f.path === "new.txt")?.untracked).toBe(true);
    expect(await index(root)).toEqual(before);
    expect((await git(root, ["diff", "--cached"])).stdout.length).toBe(0);
    expect((await git(root, ["rev-parse", "HEAD"])).stdout).toEqual(head);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("changed\n");
    expect((await snapshotRepository(root)).fingerprint).toBe(snapshot.fingerprint);
  });
  test("unborn HEAD with no index", async () => {
    const root = await repo({}); await writeFile(join(root, "new.txt"), "new\n");
    const snapshot = await snapshotRepository(root);
    expect(snapshot.headOid).toBeNull(); expect(await index(root)).toBeNull();
    const result = await executePlan(snapshot, all(snapshot));
    expect(result.error).toBeUndefined(); expect(result.succeeded).toHaveLength(1);
    expect(await show(root, "new.txt")).toBe("new\n");
  });
  test("lockfile catalog", () => {
    for (const name of ["package-lock.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "poetry.lock", "go.sum", "Gemfile.lock", "composer.lock"]) expect(isLockfile(`nested/${name}`)).toBe(true);
    expect(isLockfile("lock-not-real.txt")).toBe(false);
  });
});

describe("temporary-index execution", () => {
  test("staged-only content committed; unstaged edits and index bytes preserved", async () => {
    const root = await repo();
    await writeFile(join(root, "file.txt"), "staged\n"); await git(root, ["add", "--", "file.txt"]);
    await writeFile(join(root, "file.txt"), "staged\nunstaged\n"); await writeFile(join(root, "excluded.txt"), "excluded\n");
    const before = await index(root), snapshot = await snapshotRepository(root);
    expect(snapshot.mode).toBe("staged"); expect(snapshot.files.map(f => f.path)).toEqual(["file.txt"]);
    const result = await executePlan(snapshot, all(snapshot));
    expect(result.error).toBeUndefined(); expect(result.succeeded).toHaveLength(1);
    expect(await show(root, "file.txt")).toBe("staged\n");
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("staged\nunstaged\n");
    expect(await index(root)).toEqual(before);
    expect((await git(root, ["diff", "--cached"])).stdout.length).toBe(0);
    expect(await readFile(join(root, "excluded.txt"), "utf8")).toBe("excluded\n");
  });
  for (const mode of ["staged", "worktree"] as const) for (const reverse of [false, true]) {
    test(`same file across sequential groups (${mode}, reverse=${reverse}) offsets preserved`, async () => {
      const root = await repo({ "same.txt": lines() });
      await writeFile(join(root, "same.txt"), edited());
      if (mode === "staged") { await git(root, ["add", "--", "same.txt"]); await writeFile(join(root, "same.txt"), edited().replace("line 85\n", "excluded unstaged 85\n")); }
      const snapshot = await snapshotRepository(root), file = snapshot.files[0];
      expect(file.hunkSplittable).toBe(true); expect(file.hunks).toHaveLength(2);
      const hunks = reverse ? [...file.hunks].reverse() : file.hunks;
      const plan = { groups: hunks.map((hunk, i) => group(`g${i}`, [{ path: file.path, hunks: [hunk.id] }], i ? ["g0"] : [])) };
      const result = await executePlan(snapshot, plan);
      expect(result.error).toBeUndefined(); expect(result.succeeded).toHaveLength(2);
      expect(await show(root, "same.txt")).toBe(edited());
      const first = await show(root, "same.txt", result.succeeded[0].oid);
      expect(first.includes("changed 5\n")).toBe(!reverse); expect(first.includes("changed 55\n")).toBe(reverse);
      expect(await readFile(join(root, "same.txt"), "utf8")).toBe(mode === "staged" ? edited().replace("line 85\n", "excluded unstaged 85\n") : edited());
      expect((await git(root, ["diff", "--cached"])).stdout.length).toBe(0);
    });
  }
  test("new/deleted/renamed/binary and quoted UTF8/newline paths use whole-file selectors", async () => {
    const odd = 'space "한글\nname.txt';
    const root = await repo({ "delete.txt": "delete\n", "rename.txt": "rename\n", "binary.dat": Buffer.from([0, 1, 2]), [odd]: "old\n" });
    await unlink(join(root, "delete.txt")); await rename(join(root, "rename.txt"), join(root, "renamed.txt"));
    await writeFile(join(root, "binary.dat"), Buffer.from([0, 2, 3])); await writeFile(join(root, odd), "new\n"); await writeFile(join(root, "added.txt"), "added\n");
    await git(root, ["add", "--all"]);
    const snapshot = await snapshotRepository(root);
    expect(snapshot.files.find(f => f.path === "renamed.txt")?.status).toBe("renamed");
    expect(snapshot.files.find(f => f.path === "binary.dat")?.binary).toBe(true);
    for (const file of snapshot.files.filter(f => f.path !== odd)) expect(file.hunkSplittable).toBe(false);
    const result = await executePlan(snapshot, all(snapshot));
    expect(result.error).toBeUndefined(); expect(await show(root, odd)).toBe("new\n");
    expect((await git(root, ["show", "HEAD:binary.dat"])).stdout).toEqual(Buffer.from([0, 2, 3]));
    expect((await git(root, ["status", "--porcelain"])).stdout.length).toBe(0);
  });
  test("quoted UTF8/newline path supports partial hunks", async () => {
    const odd = 'space "한글\nname.txt', root = await repo({ [odd]: lines() });
    await writeFile(join(root, odd), edited()); const snapshot = await snapshotRepository(root);
    const plan = { groups: snapshot.files[0].hunks.map((h, i) => group(`g${i}`, [{ path: odd, hunks: [h.id] }])) };
    const result = await executePlan(snapshot, plan);
    expect(result.error).toBeUndefined(); expect(await show(root, odd)).toBe(edited());
  });
  test("worktree added/deleted/binary changes commit without leftover staged changes", async () => {
    const root = await repo({ "gone.txt": "gone\n", "blob": Buffer.from([0, 1]) });
    await unlink(join(root, "gone.txt")); await writeFile(join(root, "blob"), Buffer.from([0, 8])); await writeFile(join(root, "fresh"), Buffer.from([0, 7]));
    const snapshot = await snapshotRepository(root), result = await executePlan(snapshot, all(snapshot));
    expect(result.error).toBeUndefined(); expect(snapshot.mode).toBe("worktree");
    expect((await git(root, ["status", "--porcelain"])).stdout.length).toBe(0);
  });
  test("dependency order determines commit history", async () => {
    const root = await repo({ "a": "a\n", "b": "b\n" });
    await writeFile(join(root, "a"), "A\n"); await writeFile(join(root, "b"), "B\n");
    const snapshot = await snapshotRepository(root);
    const result = await executePlan(snapshot, { groups: [group("later", [{ path: "b", hunks: "all" }], ["first"]), group("first", [{ path: "a", hunks: "all" }])] });
    expect(result.error).toBeUndefined(); expect(result.succeeded.map(g => g.groupId)).toEqual(["first", "later"]);
  });
  test("lockfile and its manifest commit together", async () => {
    const root = await repo({ "package.json": "{}\n", "package-lock.json": "{}\n" });
    await writeFile(join(root, "package.json"), '{"version":"1"}\n'); await writeFile(join(root, "package-lock.json"), '{"version":"1"}\n');
    const snapshot = await snapshotRepository(root); expect(snapshot.files.find(f => f.isLockfile)?.path).toBe("package-lock.json");
    expect((await executePlan(snapshot, all(snapshot))).error).toBeUndefined();
  });
});

describe("failure safety", () => {
  test("drift rejects before any write", async () => {
    const root = await repo(); await writeFile(join(root, "file.txt"), "planned\n");
    const snapshot = await snapshotRepository(root), before = await index(root), head = (await git(root, ["rev-parse", "HEAD"])).stdout;
    await writeFile(join(root, "file.txt"), "drift\n");
    const result = await executePlan(snapshot, all(snapshot));
    expect(result.error).toContain("changed since preview"); expect(result.succeeded).toHaveLength(0);
    expect(await index(root)).toEqual(before); expect((await git(root, ["rev-parse", "HEAD"])).stdout).toEqual(head);
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("drift\n");
  });
  test("invalid coverage/overlap/cycle rejected without staging", async () => {
    const root = await repo(); await writeFile(join(root, "file.txt"), "changed\n");
    const snapshot = await snapshotRepository(root), before = await index(root);
    for (const plan of [ { groups: [] }, { groups: [group("x", [{ path: "file.txt", hunks: "all" }]), group("y", [{ path: "file.txt", hunks: "all" }])] }, { groups: [group("x", [{ path: "file.txt", hunks: "all" }], ["x"])] } ]) {
      expect((await executePlan(snapshot, plan)).error).toContain("Invalid commit plan"); expect(await index(root)).toEqual(before);
    }
  });
  test("first hook failure restores exact index and generated changelog", async () => {
    const root = await repo({ "file.txt": "base\n", "CHANGELOG.md": "original\n" });
    await writeFile(join(root, "file.txt"), "changed\n"); await git(root, ["add", "--", "file.txt"]);
    const snapshot = await snapshotRepository(root), before = await index(root), head = (await git(root, ["rev-parse", "HEAD"])).stdout;
    await hook(root, "exit 1");
    const plan = all(snapshot); plan.changelog = { file: "CHANGELOG.md", originalContent: "original\n", newContent: "generated\noriginal\n" };
    const result = await executePlan(snapshot, plan);
    expect(result.succeeded).toHaveLength(0); expect(result.failedGroup).toBe("all"); expect(result.restoredIndex).toBe(true); expect(result.changelogRestored).toBe(true);
    expect(await index(root)).toEqual(before); expect((await git(root, ["rev-parse", "HEAD"])).stdout).toEqual(head);
    expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toBe("original\n");
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe("changed\n");
  });
  test("failure restores newly generated changelog by removing only our file", async () => {
    const root = await repo(); await writeFile(join(root, "file.txt"), "changed\n"); await hook(root, "exit 1");
    const snapshot = await snapshotRepository(root), plan = all(snapshot);
    plan.changelog = { file: "CHANGELOG.md", originalContent: null, newContent: "generated\n" };
    const result = await executePlan(snapshot, plan);
    expect(result.changelogRestored).toBe(true); await expect(readFile(join(root, "CHANGELOG.md"))).rejects.toThrow();
  });
  for (const mode of ["staged", "worktree"] as const) test(`later hook failure reports permanent partial success (${mode})`, async () => {
    const root = await repo({ "a": "base a\n", "b": "base b\n", "CHANGELOG.md": "original\n" });
    await writeFile(join(root, "a"), "changed a\n"); await writeFile(join(root, "b"), "changed b\n");
    if (mode === "staged") await git(root, ["add", "--", "a", "b"]);
    await hook(root, 'count=$(git rev-list --count HEAD)\nif [ "$count" -gt 1 ]; then exit 1; fi');
    const snapshot = await snapshotRepository(root), plan: CommitPlan = { groups: [group("first", [{ path: "a", hunks: "all" }]), group("second", [{ path: "b", hunks: "all" }], ["first"])], changelog: { file: "CHANGELOG.md", originalContent: "original\n", newContent: "generated\n" } };
    const result = await executePlan(snapshot, plan);
    expect(result.succeeded.map(c => c.groupId)).toEqual(["first"]); expect(result.failedGroup).toBe("second"); expect(result.remainingGroups).toEqual(["second"]);
    expect(lineOutput((await git(root, ["rev-list", "--count", "HEAD"])).stdout)).toBe("2");
    expect(await show(root, "a")).toBe("changed a\n"); expect(await show(root, "b")).toBe("base b\n");
    expect(await readFile(join(root, "b"), "utf8")).toBe("changed b\n"); expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toBe("original\n");
    const staged = lineOutput((await git(root, ["diff", "--cached", "--name-only"])).stdout);
    expect(staged).toBe(mode === "staged" ? "b" : "");
  });
  test("successful changelog is staged in the final group and leaves index clean", async () => {
    const root = await repo(); await writeFile(join(root, "file.txt"), "changed\n");
    const snapshot = await snapshotRepository(root), plan = all(snapshot);
    plan.changelog = { file: "CHANGELOG.md", originalContent: null, newContent: "# Changelog\n\n## [Unreleased]\n- Update\n" };
    const result = await executePlan(snapshot, plan);
    expect(result.error).toBeUndefined(); expect(await show(root, "CHANGELOG.md")).toBe(plan.changelog.newContent);
    expect((await git(root, ["status", "--porcelain"])).stdout.length).toBe(0);
  });
});


describe("conservative edge cases", () => {
  test("mode-only and typechange/symlink are whole-file-only", async () => {
    const root = await repo({ "executable": "hello\n", "typechange": "old\n" });
    await chmod(join(root, "executable"), 0o755); await unlink(join(root, "typechange"));
    await symlink("executable", join(root, "typechange")); await symlink("executable", join(root, "new-link"));
    const snapshot = await snapshotRepository(root);
    expect(snapshot.files.find(f => f.path === "typechange")?.status).toBe("typechange");
    expect(snapshot.files.every(f => !f.hunkSplittable)).toBe(true);
    const result = await executePlan(snapshot, all(snapshot)); expect(result.error).toBeUndefined();
    const entries = (await git(root, ["ls-tree", "HEAD"])).stdout.toString();
    expect(entries).toContain("100755 blob"); expect(entries).toContain("120000 blob");
    expect(await readlink(join(root, "typechange"))).toBe("executable");
  });
  test("opaque non-UTF8 content never roundtrips through text patches", async () => {
    const root = await repo({ "opaque": Buffer.from([0xff, 0x0a, 0x61]) });
    const bytes = Buffer.from([0xff, 0x0a, 0x62]); await writeFile(join(root, "opaque"), bytes);
    const snapshot = await snapshotRepository(root); expect(snapshot.files[0].binary).toBe(true); expect(snapshot.files[0].hunkSplittable).toBe(false);
    expect((await executePlan(snapshot, all(snapshot))).error).toBeUndefined();
    expect((await git(root, ["show", "HEAD:opaque"])).stdout).toEqual(bytes);
  });
  test("CRLF and no-final-newline split hunks preserve exact bytes", async () => {
    const original = lines().replaceAll("\n", "\r\n").slice(0, -2), changed = edited().replaceAll("\n", "\r\n").slice(0, -2);
    const root = await repo({ "crlf": original }); await writeFile(join(root, "crlf"), changed);
    await git(root, ["config", "diff.context", "0"]);
    const snapshot = await snapshotRepository(root);
    const plan = { groups: snapshot.files[0].hunks.map((h, i) => group(`g${i}`, [{ path: "crlf", hunks: [h.id] }])) };
    expect((await executePlan(snapshot, plan)).error).toBeUndefined(); expect(await show(root, "crlf")).toBe(changed);
  });
  test("split-index repository leaves staged source intact", async () => {
    const root = await repo(); await git(root, ["update-index", "--split-index"]);
    await writeFile(join(root, "file.txt"), "changed\n"); await git(root, ["add", "--", "file.txt"]);
    const before = await index(root), snapshot = await snapshotRepository(root);
    expect(await index(root)).toEqual(before); expect((await executePlan(snapshot, all(snapshot))).error).toBeUndefined();
    expect(await index(root)).toEqual(before); expect(await show(root, "file.txt")).toBe("changed\n");
  });
  test("unrelated tracked worktree drift and index flag drift both reject", async () => {
    const root = await repo({ "file.txt": "base\n", "unrelated": "base\n" }); await writeFile(join(root, "file.txt"), "changed\n");
    let snapshot = await snapshotRepository(root); await writeFile(join(root, "unrelated"), "external edit\n");
    expect((await executePlan(snapshot, all(snapshot))).error).toContain("changed since preview");
    await writeFile(join(root, "unrelated"), "base\n"); snapshot = await snapshotRepository(root);
    await git(root, ["update-index", "--assume-unchanged", "unrelated"]);
    expect((await executePlan(snapshot, all(snapshot))).error).toContain("changed since preview");
  });
  test("rename source resembling conflict porcelain is treated as a path", async () => {
    const root = await repo({ "u source": "rename me\n", "__proto__": "old\n" });
    await rename(join(root, "u source"), join(root, "renamed")); await writeFile(join(root, "__proto__"), "new\n"); await git(root, ["add", "--all"]);
    const snapshot = await snapshotRepository(root); expect(snapshot.files.find(f => f.path === "renamed")?.oldPath).toBe("u source");
    expect(snapshot.diffByFile["__proto__"]).toContain("+new"); expect((await executePlan(snapshot, all(snapshot))).error).toBeUndefined();
  });
  test("failed hook's changelog edits are never overwritten by restoration", async () => {
    const root = await repo({ "file.txt": "base\n", "CHANGELOG.md": "original\n" }); await writeFile(join(root, "file.txt"), "changed\n");
    await hook(root, "printf 'hook edit\\n' > CHANGELOG.md\nexit 1");
    const snapshot = await snapshotRepository(root), plan = all(snapshot); plan.changelog = { file: "CHANGELOG.md", originalContent: "original\n", newContent: "generated\n" };
    const result = await executePlan(snapshot, plan); expect(result.succeeded).toHaveLength(0); expect(result.changelogRestored).toBe(false);
    expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toBe("hook edit\n");
  });
  test("failed hook replacing changelog with a symlink cannot redirect restoration", async () => {
    const root = await repo({ "file.txt": "base\n", "CHANGELOG.md": "original\n", "target": "generated\n" }); await writeFile(join(root, "file.txt"), "changed\n");
    await hook(root, "rm CHANGELOG.md\nln -s target CHANGELOG.md\nexit 1");
    const snapshot = await snapshotRepository(root), plan = all(snapshot); plan.changelog = { file: "CHANGELOG.md", originalContent: "original\n", newContent: "generated\n" };
    const result = await executePlan(snapshot, plan); expect(result.changelogRestored).toBe(false);
    expect(await readlink(join(root, "CHANGELOG.md"))).toBe("target"); expect(await readFile(join(root, "target"), "utf8")).toBe("generated\n");
  });
  test("later same-file hunk failure leaves remaining staged hunk intact", async () => {
    const root = await repo({ "same": lines() }); await writeFile(join(root, "same"), edited()); await git(root, ["add", "--", "same"]);
    await writeFile(join(root, "same"), edited().replace("line 85\n", "unstaged 85\n"));
    await hook(root, 'if [ "$(git rev-list --count HEAD)" -gt 1 ]; then exit 1; fi');
    const snapshot = await snapshotRepository(root), plan = { groups: snapshot.files[0].hunks.map((h, i) => group(`g${i}`, [{ path: "same", hunks: [h.id] }])) };
    const result = await executePlan(snapshot, plan); expect(result.succeeded).toHaveLength(1); expect(result.remainingGroups).toEqual(["g1"]);
    const staged = (await git(root, ["diff", "--cached"])).stdout.toString(); expect(staged).toContain("+changed 55"); expect(staged).not.toContain("+changed 5\n");
    expect(await readFile(join(root, "same"), "utf8")).toContain("unstaged 85\n");
  });
  test("explicit push only to a disposable local bare remote", async () => {
    const root = await repo(), remote = await mkdtemp(join(tmpdir(), "pi-commit-bare-test-")); repos.push(remote);
    await git(remote, ["init", "--bare", "-q"]); await git(root, ["remote", "add", "origin", remote]); await git(root, ["push", "-u", "origin", "HEAD"]);
    await writeFile(join(root, "file.txt"), "changed\n"); const snapshot = await snapshotRepository(root);
    const result = await executePlan(snapshot, all(snapshot)); expect(result.error).toBeUndefined();
    await pushRepository(root); expect(lineOutput((await git(remote, ["rev-parse", "HEAD"])).stdout)).toBe(result.succeeded[0].oid);
  });
});


test("submodule gitlinks are whole-file-only; dirty inner edits remain untouched", async () => {
  const source = await repo(), root = await repo();
  await git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub"]);
  await git(root, ["commit", "-qm", "Add submodule"]);
  const sub = join(root, "sub"); await git(sub, ["config", "user.name", "Test User"]); await git(sub, ["config", "user.email", "test@example.invalid"]); await git(sub, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(sub, "file.txt"), "inner changed\n"); await git(sub, ["add", "--", "file.txt"]); await git(sub, ["commit", "-qm", "Inner change"]);
  await writeFile(join(sub, "file.txt"), "inner changed\ninner unstaged\n");
  const snapshot = await snapshotRepository(root); expect(snapshot.files).toHaveLength(1); expect(snapshot.files[0].hunkSplittable).toBe(false);
  const result = await executePlan(snapshot, all(snapshot)); expect(result.error).toBeUndefined();
  expect(await readFile(join(sub, "file.txt"), "utf8")).toBe("inner changed\ninner unstaged\n");
  await expect(snapshotRepository(root)).rejects.toThrow("Dirty submodule");
});


for (const scenario of ["empty insertion", "content deletion", "deletion shifts", "last line without newline"] as const) test(`hunk boundary arithmetic: ${scenario}`, async () => {
  const original = scenario === "empty insertion" ? "" : scenario === "content deletion" ? "content\n" : lines().trimEnd();
  const changed = scenario === "empty insertion" ? "inserted\n" : scenario === "content deletion" ? "" : scenario === "deletion shifts" ? original.replace("line 5\nline 6\n", "").replace("line 55\n", "changed 55\n") : original.replace("line 5\n", "changed 5\ninserted\n").replace(/line 90$/, "changed 90");
  const root = await repo({ "boundary": original }); await writeFile(join(root, "boundary"), changed);
  const snapshot = await snapshotRepository(root);
  const plan = { groups: snapshot.files[0].hunks.map((h, i) => group(`g${i}`, [{ path: "boundary", hunks: [h.id] }])) };
  const result = await executePlan(snapshot, plan); expect(result.error).toBeUndefined(); expect(await show(root, "boundary")).toBe(changed);
});
