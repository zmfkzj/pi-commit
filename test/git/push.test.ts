import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pushRepository } from "../../src/git/index.js";
import { git, lineOutput } from "../../src/git/process.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix)); directories.push(directory); return directory;
}
async function configureAuthor(root: string): Promise<void> {
  await git(root, ["config", "user.name", "Push Test"]);
  await git(root, ["config", "user.email", "push-test@example.invalid"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["config", "tag.gpgsign", "false"]);
}
async function commit(root: string, filename: string, content: string): Promise<string> {
  await writeFile(join(root, filename), content);
  await git(root, ["add", "--", filename]);
  await git(root, ["commit", "-qm", `Update ${filename}`]);
  return lineOutput((await git(root, ["rev-parse", "HEAD"])).stdout);
}
async function fixture(upstream = true): Promise<{ root: string; remote: string; initial: string }> {
  const root = await temporary("pi-commit-push-local-"), remote = await temporary("pi-commit-push-bare-");
  await git(root, ["init", "-q", "--initial-branch=main"]);
  await git(remote, ["init", "-q", "--bare", "--initial-branch=upstream-main"]);
  await configureAuthor(root);
  const initial = await commit(root, "file", "initial\n");
  await git(root, ["remote", "add", "origin", remote]);
  if (upstream) await git(root, ["push", "-u", "origin", "HEAD:refs/heads/upstream-main"]);
  return { root, remote, initial };
}
async function refs(remote: string): Promise<string> {
  return lineOutput((await git(remote, ["for-each-ref", "--sort=refname", "--format=%(refname) %(objectname)"])).stdout);
}
async function ref(remote: string, name: string): Promise<string | null> {
  const result = await git(remote, ["rev-parse", "--verify", name], { allowFailure: true });
  return result.code === 0 ? lineOutput(result.stdout) : null;
}
async function otherBranch(root: string): Promise<string> {
  await git(root, ["checkout", "-qb", "side"]);
  const previous = await commit(root, "side", "remote side\n");
  await git(root, ["push", "origin", "side:refs/heads/side"]);
  await commit(root, "side", "new local side\n");
  await git(root, ["checkout", "-q", "main"]);
  return previous;
}

describe("explicit upstream-only non-force push", () => {
  test("normal fast-forward updates only configured upstream (different branch name)", async () => {
    const { root, remote } = await fixture();
    const next = await commit(root, "file", "new local commit\n");
    const beforeIndex = await readFile(join(root, ".git", "index"));
    await pushRepository(root);
    expect(await ref(remote, "refs/heads/upstream-main")).toBe(next);
    expect(await ref(remote, "refs/heads/main")).toBeNull();
    expect(await readFile(join(root, ".git", "index"))).toEqual(beforeIndex);
    expect(await readFile(join(root, "file"), "utf8")).toBe("new local commit\n");
  });
  test("HEAD switching after branch resolution still pushes the resolved branch ref", async () => {
    const { root, remote, initial } = await fixture(), next = await commit(root, "file", "main update\n");
    await git(root, ["branch", "side", initial]);
    const bin = await temporary("pi-commit-push-git-"), realGit = Bun.which("git")!;
    const wrapper = join(bin, "git"), argv = join(bin, "push-argv");
    await writeFile(wrapper, `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = push ]; then\n    "${realGit}" symbolic-ref HEAD refs/heads/side || exit 1\n    printf '%s\\n' "$@" > "${argv}"\n    break\n  fi\ndone\nexec "${realGit}" "$@"\n`);
    await chmod(wrapper, 0o755);
    const originalPath = process.env.PATH;
    try { process.env.PATH = `${bin}:${originalPath}`; await pushRepository(root); }
    finally { process.env.PATH = originalPath; }
    expect(await ref(root, "HEAD")).toBe(initial);
    expect(await ref(remote, "refs/heads/upstream-main")).toBe(next);
    const args = (await readFile(argv, "utf8")).trim().split("\n");
    expect(args.slice(-3)).toEqual(["--", "origin", "refs/heads/main:refs/heads/upstream-main"]);
    expect(args).not.toContain("HEAD:refs/heads/upstream-main");
  });
  test("submodule check refuses unpublished commits without pushing them; published commits succeed", async () => {
    const { root, remote } = await fixture(), source = await fixture();
    await git(root, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source.remote, "sub"]);
    await git(root, ["commit", "-qm", "Add published submodule"]);
    const published = await ref(root, "HEAD");
    await git(root, ["config", "push.recurseSubmodules", "no"]);
    await pushRepository(root);
    expect(await ref(remote, "refs/heads/upstream-main")).toBe(published);

    const sub = join(root, "sub"); await configureAuthor(sub);
    const unpublished = await commit(sub, "file", "unpublished submodule commit\n");
    await git(root, ["add", "--", "sub"]);
    await git(root, ["commit", "-qm", "Update submodule pointer"]);
    const next = await ref(root, "HEAD"), subRemoteBefore = await refs(source.remote);
    expect(lineOutput((await git(root, ["rev-parse", "HEAD:sub"])).stdout)).toBe(unpublished);
    expect(await ref(source.remote, `${unpublished}^{commit}`)).toBeNull();

    await expect(pushRepository(root)).rejects.toThrow("not be found on any remote");
    expect(await ref(remote, "refs/heads/upstream-main")).toBe(published);
    expect(await ref(root, "HEAD")).toBe(next);
    expect(await refs(source.remote)).toBe(subRemoteBefore);
    expect(await ref(source.remote, `${unpublished}^{commit}`)).toBeNull();

    await git(sub, ["push", "origin", "HEAD:refs/heads/upstream-main"]);
    await pushRepository(root);
    expect(await ref(remote, "refs/heads/upstream-main")).toBe(next);
    expect(await ref(source.remote, "refs/heads/upstream-main")).toBe(unpublished);
  });
  test("push.default=matching cannot push another branch's new commits", async () => {
    const { root, remote } = await fixture(); const sideBefore = await otherBranch(root);
    const mainNext = await commit(root, "file", "main update\n");
    await git(root, ["config", "push.default", "matching"]);
    await pushRepository(root);
    expect(await ref(remote, "refs/heads/side")).toBe(sideBefore);
    expect(await ref(remote, "refs/heads/upstream-main")).toBe(mainNext);
    expect(await ref(remote, "refs/heads/main")).toBeNull();
  });
  test("configured +wildcard and mirror cannot update/force another branch", async () => {
    const { root, remote } = await fixture(); const sideBefore = await otherBranch(root);
    await git(root, ["branch", "-f", "side", "main"]);
    await git(root, ["checkout", "-q", "side"]);
    await commit(root, "alternate-side", "diverged local side\n");
    await git(root, ["checkout", "-q", "main"]);
    const mainNext = await commit(root, "file", "main update\n");
    await git(root, ["config", "remote.origin.push", "+refs/heads/*:refs/heads/*"]);
    await git(root, ["config", "remote.origin.mirror", "true"]);
    await git(root, ["config", "push.default", "matching"]);
    await pushRepository(root);
    expect(await refs(remote)).toBe(`refs/heads/side ${sideBefore}\nrefs/heads/upstream-main ${mainNext}`);
    expect(lineOutput((await git(root, ["rev-parse", "HEAD"])).stdout)).toBe(mainNext);
  });
  test("diverged upstream rejects non-fast-forward despite force refspec config; all history retained", async () => {
    const { root, remote } = await fixture();
    const peer = await temporary("pi-commit-push-peer-");
    await git(root, ["clone", "-q", remote, peer]); await configureAuthor(peer);
    await commit(peer, "remote-only", "independent remote commit\n");
    await git(peer, ["push", "origin", "HEAD:refs/heads/upstream-main"]);
    await git(root, ["fetch", "origin"]); // Make the divergent remote parent known without changing local HEAD.
    const localNext = await commit(root, "local-only", "independent local commit\n");
    await git(root, ["config", "remote.origin.push", "+refs/heads/*:refs/heads/*"]);
    const remoteBefore = await refs(remote), localLog = (await git(root, ["log", "--format=%H"])).stdout;
    await expect(pushRepository(root)).rejects.toThrow("non-fast-forward");
    expect(await refs(remote)).toBe(remoteBefore);
    expect(lineOutput((await git(root, ["rev-parse", "HEAD"])).stdout)).toBe(localNext);
    expect((await git(root, ["log", "--format=%H"])).stdout).toEqual(localLog);
    expect(await readFile(join(root, "local-only"), "utf8")).toBe("independent local commit\n");
  });
  test("push.followTags=true cannot push a reachable annotated tag", async () => {
    const { root, remote } = await fixture(); const next = await commit(root, "file", "tagged local commit\n");
    await git(root, ["tag", "-a", "v-local-only", "-m", "Do not push this tag"]);
    await git(root, ["config", "push.followTags", "true"]);
    await git(root, ["config", "remote.origin.push", "+refs/tags/*:refs/tags/*"]);
    await pushRepository(root);
    expect(await ref(remote, "refs/heads/upstream-main")).toBe(next);
    expect(await ref(remote, "refs/tags/v-local-only")).toBeNull();
    expect(await ref(root, "refs/tags/v-local-only")).not.toBeNull();
  });
  test("missing upstream refuses without pushing or changing local commits", async () => {
    const { root, remote, initial } = await fixture(false), remoteBefore = await refs(remote);
    await expect(pushRepository(root)).rejects.toThrow("no configured upstream");
    expect(await refs(remote)).toBe(remoteBefore); expect(await ref(root, "HEAD")).toBe(initial);
  });
  test("detached HEAD refuses without pushing or changing local commits", async () => {
    const { root, remote, initial } = await fixture(); await git(root, ["checkout", "-q", "--detach", "HEAD"]);
    const remoteBefore = await refs(remote);
    await expect(pushRepository(root)).rejects.toThrow("HEAD is detached");
    expect(await refs(remote)).toBe(remoteBefore); expect(await ref(root, "HEAD")).toBe(initial);
  });
  test("upstream remote '.' is unsupported and cannot push into this repository", async () => {
    const { root, remote } = await fixture(); await git(root, ["config", "branch.main.remote", "."]);
    const localBefore = await refs(root), remoteBefore = await refs(remote);
    await expect(pushRepository(root)).rejects.toThrow("unsupported or unsafe upstream remote");
    expect(await refs(root)).toBe(localBefore); expect(await refs(remote)).toBe(remoteBefore);
  });
  test("ambiguous upstream and nonbranch merge destinations refuse", async () => {
    const { root, remote } = await fixture(), before = await refs(remote);
    await git(root, ["config", "--add", "branch.main.merge", "refs/heads/other"]);
    await expect(pushRepository(root)).rejects.toThrow("exactly one remote and one branch");
    await git(root, ["config", "--unset-all", "branch.main.merge"]);
    await git(root, ["config", "branch.main.merge", "refs/tags/danger"]);
    await expect(pushRepository(root)).rejects.toThrow("valid refs/heads branch");
    expect(await refs(remote)).toBe(before);
  });
});
