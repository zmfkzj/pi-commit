import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelAdapter, ModelMessage } from "../../src/types.js";
import commitExtension from "../../src/index.js";
import { runCommitCommand, resolveModel, type CommitContext } from "../../src/command/run.js";
import { parseCommitArgs, tokenizeArgs } from "../../src/command/args.js";
import { changelogDiff, safeDisplay } from "../../src/ui/format.js";
import { git } from "../../src/git/process.js";
import { planCommits } from "../../src/plan/planner.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const base = Array.from({ length: 80 }, (_, i) => `line ${i + 1}\n`).join("");
const changed = base.replace("line 5\n", "fixed five\nextra line\n").replace("line 55\n", "fixed fifty-five\n");
const originalChangelog = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Existing behavior.\n\n## [1.0.0]\n\n- Released history.\n";
async function repo(changelog = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-commit-extension-test-")); roots.push(root);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Extension Test"]);
  await git(root, ["config", "user.email", "test@example.invalid"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await writeFile(join(root, "file.txt"), base);
  if (changelog) await writeFile(join(root, "CHANGELOG.md"), originalChangelog);
  await git(root, ["add", "--all"]); await git(root, ["commit", "-qm", "Initial"]);
  await writeFile(join(root, "file.txt"), changed);
  return root;
}
function mockModel(split = false, entries = false): ModelAdapter {
  return { async complete(messages: ModelMessage[]) {
    const views = JSON.parse(messages[1]!.content) as { git_overview: { files: Array<{ path: string; hunks: Array<{ id: string }> }> } };
    const files = views.git_overview.files;
    const groups = split ? files[0]!.hunks.map((hunk, index) => ({ id: `g${index + 1}`, message: { subject: `Fix part ${index + 1}`, body: `Detailed rationale ${index + 1}.` }, selectors: [{ path: files[0]!.path, hunks: [hunk.id] }], dependsOn: index ? ["g1"] : [], ...(entries ? { changelogEntry: `Fixed: Improve part ${index + 1}.` } : {}) }))
      : [{ id: "g1", message: { subject: "Fix behavior" }, selectors: files.map(file => ({ path: file.path, hunks: "all" })), dependsOn: [], ...(entries ? { changelogEntry: "Fixed: Improve behavior." } : {}) }];
    return { text: JSON.stringify({ groups }) };
  } };
}
function context(root: string, hasUI = true, confirm: () => Promise<boolean> = async () => true): CommitContext {
  return { cwd: root, mode: hasUI ? "tui" : "print", hasUI, model: undefined, signal: undefined,
    modelRegistry: { find: () => undefined, streamSimple: () => { throw new Error("Unexpected real model call"); } }, ui: { confirm } };
}
async function state(root: string) {
  const read = async (name: string) => readFile(join(root, name)).catch(() => null);
  return { index: await read(".git/index"), worktree: await read("file.txt"), changelog: await read("CHANGELOG.md"),
    head: (await git(root, ["rev-parse", "HEAD"])).stdout, cached: (await git(root, ["diff", "--cached"])).stdout,
    status: (await git(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"])).stdout };
}
async function run(root: string, args = "", adapter = mockModel(), ctx = context(root)) {
  const output: string[] = [];
  const result = await runCommitCommand(args, ctx, { adapter, output: text => output.push(text) });
  return { result, output: output.join("\n") };
}
async function runWithStaleChangelog(root: string, args: string, adapter: ModelAdapter) {
  const output: string[] = [];
  const result = await runCommitCommand(args, context(root, false), {
    adapter,
    planner: async (...parameters) => {
      const plan = await planCommits(...parameters);
      plan.changelog = { file: "CHANGELOG.md", originalContent: await readFile(join(root, "CHANGELOG.md"), "utf8").catch(() => null), newContent: "STALE-PLANNER-CONTENT\n" };
      return plan;
    },
    output: text => output.push(text),
  });
  return { result, output: output.join("\n") };
}
async function hook(root: string, content: string) {
  const path = join(root, ".git", "hooks", "pre-commit"); await writeFile(path, `#!/bin/sh\n${content}\n`); await chmod(path, 0o755);
}

describe("argument parser", () => {
  test("quotes, escapes and equals values", () => {
    expect(tokenizeArgs(`--context "fix a \\\"quoted\\\" bug" --model 'provider/org/model'`)).toEqual(["--context", 'fix a "quoted" bug', "--model", "provider/org/model"]);
    expect(parseCommitArgs(`--dry-run --context='hello world' --model=provider/id --no-changelog --push --yes`)).toEqual({ dryRun: true, context: "hello world", model: "provider/id", noChangelog: true, push: true, yes: true, help: false });
  });
  test("reject unknown/ambiguous arguments", () => {
    for (const args of ["--wat", "free text", "--model", "--model id", "--context", '--context "', "--yes=true", "--dry-run --dry-run", "--context --yes", "--context ''", "\\"]) expect(() => parseCommitArgs(args)).toThrow();
  });
  test("exact provider/id lookup preserves slash inside model id", () => {
    const ctx = context("/tmp"); let selected: string[] = [];
    ctx.modelRegistry.find = (provider, id) => { selected = [provider, id]; return undefined; };
    expect(() => resolveModel(ctx, "provider/org/id")).toThrow("Unknown"); expect(selected).toEqual(["provider", "org/id"]);
    expect(() => resolveModel(ctx)).toThrow("No current model");
  });
});

describe("pipeline safety with real temporary Git repositories", () => {
  test("worktree split dry-run previews all hunks and changelog; byte immutable even with --yes --push", async () => {
    const root = await repo(), before = await state(root);
    const { result, output } = await run(root, "--dry-run --yes --push", mockModel(true, true), context(root, true, async () => { throw new Error("Must not confirm dry-run"); }));
    expect(result.status).toBe("dry-run"); expect(await state(root)).toEqual(before);
    for (const text of ["Mode: worktree", "g1 -> g2", "file.txt#1", "file.txt#2", "fixed five", "fixed fifty-five", "Detailed rationale", "Dependencies: g1", "+- Improve part 1.", "EXPLICIT PUSH REQUEST"]) expect(output).toContain(text);
  });
  test("staged dry-run preserves unstaged edits and index bytes", async () => {
    const root = await repo(); await git(root, ["add", "--", "file.txt"]);
    await writeFile(join(root, "file.txt"), changed + "unstaged text\n");
    const before = await state(root), { result, output } = await run(root, "--dry-run");
    expect(result.status).toBe("dry-run"); expect(output).toContain("Mode: staged"); expect(output).not.toContain("+unstaged text"); expect(await state(root)).toEqual(before);
  });
  test("decline/escape zero writes and --yes does not bypass interactive confirmation", async () => {
    const root = await repo(), before = await state(root); let confirmations = 0;
    const ctx = context(root, true, async () => { confirmations++; return false; });
    const { result } = await run(root, "--yes", mockModel(false, true), ctx);
    expect(result.status).toBe("cancelled"); expect(confirmations).toBe(1); expect(await state(root)).toEqual(before);
  });
  test("noninteractive without --yes refuses after full preview", async () => {
    const root = await repo(), before = await state(root);
    const { result, output } = await run(root, "", mockModel(false, true), context(root, false));
    expect(result.status).toBe("refused"); expect(output).toContain("pi-commit preview"); expect(output).toContain("--yes"); expect(await state(root)).toEqual(before);
  });
  test("noninteractive --yes commits split SAME FILE and final changelog", async () => {
    const root = await repo(), { result, output } = await run(root, "--yes", mockModel(true, true), context(root, false));
    expect(result.status).toBe("executed"); expect(result.execution?.error).toBeUndefined(); expect(result.execution?.succeeded).toHaveLength(2);
    const first = result.execution!.succeeded[0]!.oid;
    const firstFile = (await git(root, ["show", `${first}:file.txt`])).stdout.toString();
    expect(firstFile).toContain("fixed five"); expect(firstFile).not.toContain("fixed fifty-five");
    expect((await git(root, ["show", `${first}:CHANGELOG.md`])).stdout.toString()).toBe(originalChangelog);
    const final = (await git(root, ["show", "HEAD:CHANGELOG.md"])).stdout.toString();
    expect(final).toContain("Improve part 1."); expect(final).toContain("Improve part 2."); expect(final).toContain("Released history.");
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe(changed);
    expect((await git(root, ["diff", "--cached"])).stdout.length).toBe(0); expect(result.pushed).toBeUndefined(); expect(output).toContain("Commit plan completed");
  });
  test("interactive single commit authorization contains complete preview", async () => {
    const root = await repo(); let message = "";
    const ctx = context(root); ctx.ui.confirm = async (_title, text) => { message = text; return true; };
    const { result } = await run(root, "--no-changelog", mockModel(), ctx);
    expect(result.execution?.succeeded).toHaveLength(1); expect(message).toContain("Fix behavior"); expect(message).toContain("fixed five"); expect(message).toContain("ALL");
  });
  test("model exception and malformed retry exhaustion produce no writes or fallback", async () => {
    const root = await repo(), before = await state(root);
    for (const adapter of [{ complete: async () => { throw new Error("provider failed secret"); } }, { complete: async () => ({ text: "not json" }) }]) {
      const { result, output } = await run(root, "--yes", adapter, context(root, false));
      expect(result.status).toBe("error"); expect(output).not.toContain("secret"); expect(await state(root)).toEqual(before);
    }
  });
  test("invalid coverage rejected before confirmation", async () => {
    const root = await repo(), before = await state(root);
    const adapter: ModelAdapter = { complete: async () => ({ text: JSON.stringify({ groups: [{ id: "g1", message: { subject: "Missing changes" }, selectors: [{ path: "file.txt", hunks: ["file.txt#1"] }], dependsOn: [] }] }) }) };
    const { result } = await run(root, "--yes", adapter, context(root, true, async () => { throw new Error("must not confirm"); }));
    expect(result.status).toBe("error"); expect(await state(root)).toEqual(before);
  });
  test("drift during confirmation aborts execution and preserves newly edited content", async () => {
    const root = await repo(), before = await state(root);
    const { result, output } = await run(root, "", mockModel(), context(root, true, async () => { await writeFile(join(root, "file.txt"), "new user edit\n"); return true; }));
    expect(result.execution?.succeeded).toHaveLength(0); expect(result.execution?.error).toContain("changed since preview"); expect(output).toContain("Commit failed");
    expect((await state(root)).index).toEqual(before.index); expect((await state(root)).head).toEqual(before.head); expect(await readFile(join(root, "file.txt"), "utf8")).toBe("new user edit\n");
  });
  test("aborted confirmation stops before executor", async () => {
    const root = await repo(), before = await state(root), controller = new AbortController();
    const ctx = context(root, true, async () => { controller.abort(); return true; }); ctx.signal = controller.signal;
    expect((await run(root, "", mockModel(), ctx)).result.status).toBe("error"); expect(await state(root)).toEqual(before);
  });
  test("first hook failure preserves original index/changelog/history", async () => {
    const root = await repo(), before = await state(root); await hook(root, "exit 1");
    const { result, output } = await run(root, "--yes", mockModel(false, true), context(root, false));
    expect(result.execution?.succeeded).toHaveLength(0); expect(result.execution?.restoredIndex).toBe(true); expect(result.execution?.changelogRestored).toBe(true);
    expect(await state(root)).toEqual(before); expect(output).toContain("Commit failed");
  });
  test("later hook failure reports partial success without fallback/reset", async () => {
    const root = await repo(); await hook(root, 'case "$(git log -1 --format=%s)" in "Fix part 1") exit 1;; esac');
    const { result, output } = await run(root, "--yes", mockModel(true, true), context(root, false));
    expect(result.execution?.succeeded).toHaveLength(1); expect(result.execution?.failedGroup).toBe("g2"); expect(result.execution?.remainingGroups).toEqual(["g2"]); expect(output).toContain("Partial success");
    expect((await git(root, ["rev-list", "--count", "HEAD"])).stdout.toString().trim()).toBe("2");
    expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toBe(originalChangelog); expect(await readFile(join(root, "file.txt"), "utf8")).toBe(changed);
  });
  test("existing unstaged changelog edits in staged mode cannot be auto-committed", async () => {
    const root = await repo(); await git(root, ["add", "--", "file.txt"]); await writeFile(join(root, "CHANGELOG.md"), originalChangelog + "private unfinished edit\n");
    const before = await state(root), { result, output } = await run(root, "--yes", mockModel(false, true), context(root, false));
    expect(result.status).toBe("error"); expect(output).toContain("--no-changelog"); expect(await state(root)).toEqual(before);
    const approved = await run(root, "--yes --no-changelog", mockModel(false, true), context(root, false));
    expect(approved.result.execution?.error).toBeUndefined(); expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toBe(originalChangelog + "private unfinished edit\n");
    expect((await git(root, ["show", "HEAD:CHANGELOG.md"])).stdout.toString()).toBe(originalChangelog);
  });
  test("--no-changelog clears stale planner writes and model entries before preview/execution", async () => {
    const root = await repo(false), before = await state(root);
    const dry = await runWithStaleChangelog(root, "--dry-run --no-changelog", mockModel(false, true));
    expect(dry.result.status).toBe("dry-run"); expect(dry.result.plan?.changelog).toBeUndefined();
    expect(dry.output).toContain("Generated changelog: none"); expect(dry.output).not.toContain("STALE-PLANNER-CONTENT"); expect(dry.output).not.toContain("Changelog entry:");
    expect(await state(root)).toEqual(before);
    const committed = await runWithStaleChangelog(root, "--yes --no-changelog", mockModel(false, true));
    expect(committed.result.execution?.succeeded).toHaveLength(1); expect(committed.result.execution?.error).toBeUndefined();
    expect(committed.result.plan?.changelog).toBeUndefined(); expect(committed.output).not.toContain("STALE-PLANNER-CONTENT");
    expect((await state(root)).changelog).toBeNull(); expect((await git(root, ["ls-tree", "HEAD", "--", "CHANGELOG.md"])).stdout.length).toBe(0);
  });
  test("no entries clears stale planner changelog without creating a file", async () => {
    const root = await repo(false);
    const { result, output } = await runWithStaleChangelog(root, "--yes", mockModel());
    expect(result.execution?.succeeded).toHaveLength(1); expect(result.execution?.error).toBeUndefined(); expect(result.plan?.changelog).toBeUndefined();
    expect(output).toContain("Generated changelog: none"); expect(output).not.toContain("STALE-PLANNER-CONTENT");
    expect((await state(root)).changelog).toBeNull(); expect((await git(root, ["ls-tree", "HEAD", "--", "CHANGELOG.md"])).stdout.length).toBe(0);
  });
  test("deduped no-content-change merge clears stale planner changelog", async () => {
    const root = await repo(), underlying = mockModel(false, true);
    const adapter: ModelAdapter = { complete: async (...parameters) => {
      const response = await underlying.complete(...parameters);
      return { text: response.text.replace("Improve behavior.", "Existing behavior.") };
    } };
    const { result, output } = await runWithStaleChangelog(root, "--yes", adapter);
    expect(result.execution?.succeeded).toHaveLength(1); expect(result.execution?.error).toBeUndefined(); expect(result.plan?.changelog).toBeUndefined();
    expect(output).toContain("Generated changelog: none"); expect(output).not.toContain("STALE-PLANNER-CONTENT");
    expect(await readFile(join(root, "CHANGELOG.md"), "utf8")).toBe(originalChangelog);
    expect((await git(root, ["show", "HEAD:CHANGELOG.md"])).stdout.toString()).toBe(originalChangelog);
  });
  test("new changelog preview does not create file, approved execution creates it", async () => {
    const root = await repo(false), before = await state(root);
    expect((await run(root, "--dry-run", mockModel(false, true))).result.plan?.changelog?.originalContent).toBeNull(); expect(await state(root)).toEqual(before);
    expect((await run(root, "--yes", mockModel(false, true), context(root, false))).result.execution?.error).toBeUndefined();
    expect((await git(root, ["show", "HEAD:CHANGELOG.md"])).stdout.toString()).toContain("## [Unreleased]");
  });
  test("ignored generated changelog is rejected before writes", async () => {
    const root = await repo(false); await writeFile(join(root, ".git", "info", "exclude"), "CHANGELOG.md\n"); const before = await state(root);
    const { result } = await run(root, "--yes", mockModel(false, true), context(root, false));
    expect(result.error).toContain("ignored"); expect(await state(root)).toEqual(before);
  });
  test("missing upstream push refusal preserves successful commits without history rollback", async () => {
    const root = await repo(); const { result, output } = await run(root, "--yes --push --no-changelog", mockModel(), context(root, false));
    expect(result.status).toBe("executed"); expect(result.execution?.succeeded).toHaveLength(1); expect(result.execution?.error).toBeUndefined();
    expect(result.error).toContain("Push failed or refused"); expect(result.pushed).toBeUndefined(); expect(output).toContain("local commits remain");
    expect((await git(root, ["rev-parse", "HEAD"])).stdout.toString().trim()).toBe(result.execution!.succeeded[0]!.oid);
    expect((await git(root, ["rev-list", "--count", "HEAD"])).stdout.toString().trim()).toBe("2");
    expect((await git(root, ["diff", "--cached"])).stdout.length).toBe(0);
  });
  test("detached HEAD push refusal is reported after committing without rollback", async () => {
    const root = await repo(); await git(root, ["checkout", "--detach", "-q"]);
    const { result, output } = await run(root, "--yes --push --no-changelog", mockModel(), context(root, false));
    expect(result.status).toBe("executed"); expect(result.execution?.succeeded).toHaveLength(1); expect(result.execution?.error).toBeUndefined();
    expect(result.error).toContain("Push failed or refused"); expect(output).toContain("local commits remain"); expect(result.pushed).toBeUndefined();
    expect((await git(root, ["rev-parse", "HEAD"])).stdout.toString().trim()).toBe(result.execution!.succeeded[0]!.oid);
    expect((await git(root, ["rev-list", "--count", "HEAD"])).stdout.toString().trim()).toBe("2");
    expect(await readFile(join(root, "file.txt"), "utf8")).toBe(changed);
  });
  test("empty repo change set skips model call", async () => {
    const root = await repo(); await writeFile(join(root, "file.txt"), base);
    const { result } = await run(root, "", { complete: async () => { throw new Error("should not call"); } }); expect(result.status).toBe("empty");
  });
});

describe("load and display", () => {
  test("default factory registers /commit against public ExtensionAPI", async () => {
    let name = "", command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
    commitExtension({ registerCommand: (key, definition) => { name = key; command = definition; } } as ExtensionAPI);
    expect(name).toBe("commit"); expect(command?.handler).toBeFunction();
  });
  test("actual public pi resource loader loads source-only extension under Node/jiti", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-commit-host-smoke-")); roots.push(root);
    const script = `import {DefaultResourceLoader,SettingsManager} from "@earendil-works/pi-coding-agent";
      const loader=new DefaultResourceLoader({cwd:process.argv[1],agentDir:process.argv[1]+"/agent",settingsManager:SettingsManager.inMemory(),additionalExtensionPaths:[process.cwd()+"/src/index.ts"],noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true});
      await loader.reload(); const result=loader.getExtensions(); if(result.errors.length) throw new Error(JSON.stringify(result.errors));
      if(!result.extensions.some(e=>e.commands.has("commit"))) throw new Error("No commit registration"); console.log("public pi loader: commit registered");`;
    const result = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
      const child = spawn("node", ["--input-type=module", "-e", script, root], { cwd: process.cwd(), env: { ...process.env, PI_OFFLINE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
      let text = ""; child.stdout.on("data", chunk => text += chunk); child.stderr.on("data", chunk => text += chunk); child.on("error", reject); child.on("close", code => resolve({ code, text }));
    });
    expect(result.text).toContain("public pi loader: commit registered"); expect(result.code).toBe(0);
  }, 30_000);
  test("terminal controls escaped and changelog diff exact additions", () => {
    expect(safeDisplay("hello\x1b[31m\u202eevil")).toBe("hello\\u001b[31m\\u202eevil");
    expect(changelogDiff({ file: "CHANGELOG.md", originalContent: "a\nb\n", newContent: "a\nnew\nb\n" })).toContain("+new");
    expect(changelogDiff({ file: "CHANGELOG.md", originalContent: null, newContent: "new" })).toContain("No newline at end of file");
  });
});
