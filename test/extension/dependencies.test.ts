import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommitExtension } from "../../src/index.js";
import { createDependencyProvider, IDENTITY_ACTION, PACKAGE_DIR, type DoctorContext } from "../../src/doctor.js";
import { DEPENDENCY_CHANNEL, formatDependencyReport, runProcess, type DependencyProvider, type DependencyReport } from "../../src/dependencies.js";
import { parseCommitArgs, parseSubcommand } from "../../src/command/args.js";
import { completeCommitArguments } from "../../src/command/completions.js";
import { git } from "../../src/git/process.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp(name: string): Promise<string> { const root = await mkdtemp(join(tmpdir(), `pi-commit-deps-${name}-`)); roots.push(root); return root; }

/** Isolated Git environment: no system/global config of the real user, identity only where a test sets it. */
async function isolatedEnv(extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const home = await temp("home");
  return { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "gitconfig"), GIT_CEILING_DIRECTORIES: tmpdir(), ...extra };
}
/** Forces Git to refuse auto-detected identities, so a missing user.name/user.email fails like on a fresh machine. */
const STRICT_IDENTITY = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.useConfigOnly", GIT_CONFIG_VALUE_0: "true" };
async function repo(identity = true): Promise<string> {
  const root = await temp("repo");
  await git(root, ["init", "-q"]);
  if (identity) { await git(root, ["config", "user.name", "Deps Test"]); await git(root, ["config", "user.email", "deps@example.invalid"]); }
  return root;
}
const model = { provider: "test", id: "planner" };
function ctx(cwd: string, overrides: Partial<DoctorContext> = {}): DoctorContext {
  return { cwd, model, modelRegistry: { hasConfiguredAuth: () => true }, ...overrides };
}
/** A runner that records every call and delegates to the real one. */
function recorder() {
  const calls: string[][] = [];
  const run: typeof runProcess = (command, args, options) => { calls.push([command, ...args]); return runProcess(command, args, options); };
  return { calls, run };
}
async function fakeGit(script: string): Promise<string> {
  const dir = await temp("bin");
  await writeFile(join(dir, "git"), `#!/bin/sh\n${script}\n`); await chmod(join(dir, "git"), 0o755);
  return dir;
}
const byName = (report: DependencyReport, prefix: string) => report.items.find(item => item.name.startsWith(prefix))!;

describe("pi-commit dependency provider", () => {
  test("healthy check: git, identity, work tree and model are ok; no npm dependencies is stated", async () => {
    const root = await repo();
    const provider = createDependencyProvider({ env: await isolatedEnv() });
    const report = await provider.check(ctx(root));
    expect(report.items.map(item => [item.name, item.status])).toEqual([
      ["git", "ok"], ["git identity (user.name / user.email)", "ok"], ["git work tree (current directory)", "ok"], ["planning model", "ok"],
    ]);
    expect(byName(report, "git identity").detail).toBe("user.name and user.email set");
    expect(byName(report, "planning model").detail).toBe("test/planner (credentials set)");
    expect(report.note).toContain("No npm runtime dependencies");
    expect(report.items.some(item => item.name.startsWith("npm"))).toBe(false);
    expect(formatDependencyReport("pi-commit", report, "check")).toMatchObject({ level: "info" });
    expect(formatDependencyReport("pi-commit", report, "check").text.split("\n")[0]).toBe("pi-commit doctor: healthy");
    expect(PACKAGE_DIR.endsWith("pi-commit/") || PACKAGE_DIR.endsWith("pi-commit")).toBe(true);
  });

  test("missing git is an error with an install action; install reports it as manual", async () => {
    const empty = await temp("empty-path");
    const provider = createDependencyProvider({ env: await isolatedEnv(), pathDirs: [empty], platform: "linux" });
    const report = await provider.check(ctx(empty));
    expect(byName(report, "git")).toMatchObject({ status: "error", detail: "git is not on PATH" });
    expect(byName(report, "git").action).toContain("Install Git 2.31 or newer");
    expect(byName(report, "git").action).toContain("sudo apt install git");
    expect(byName(report, "git identity")).toMatchObject({ status: "unverified" });
    expect(byName(report, "git identity").action).toContain("git var GIT_AUTHOR_IDENT");
    expect(formatDependencyReport("pi-commit", report, "check")).toMatchObject({ level: "error" });
    const installed = await provider.install(ctx(empty));
    expect(byName(installed, "git").status).toBe("manual");
    expect(byName(installed, "git").action).toContain("Install Git 2.31 or newer");
    expect(formatDependencyReport("pi-commit", installed, "install").text).toStartWith("pi-commit install-deps: manual action required");
    const darwin = await createDependencyProvider({ env: {}, pathDirs: [empty], platform: "darwin" }).check(ctx(empty));
    expect(byName(darwin, "git").action).toContain("xcode-select --install");
  });

  test("too old and broken git are errors with actions", async () => {
    const old = await fakeGit('echo "git version 2.30.9"');
    const oldReport = await createDependencyProvider({ env: await isolatedEnv(), pathDirs: [old] }).check(ctx(old));
    expect(byName(oldReport, "git")).toMatchObject({ status: "error" });
    expect(byName(oldReport, "git").detail).toContain("Git 2.30.9");
    expect(byName(oldReport, "git").action).toContain("Install Git 2.31 or newer");
    const broken = await fakeGit('echo "fatal: broken install" >&2; exit 3');
    const brokenReport = await createDependencyProvider({ env: await isolatedEnv(), pathDirs: [broken] }).check(ctx(broken));
    expect(byName(brokenReport, "git").status).toBe("error");
    expect(byName(brokenReport, "git").detail).toContain("fatal: broken install");
    expect(byName(brokenReport, "git").action).toContain("git --version");
    const weird = await fakeGit('echo "something else"');
    expect(byName(await createDependencyProvider({ env: await isolatedEnv(), pathDirs: [weird] }).check(ctx(weird)), "git")).toMatchObject({ status: "unverified", action: expect.stringContaining("git --version") });
  });

  test("missing identity is an error; install only reports the manual commands and never writes config", async () => {
    const root = await repo(false);
    const env = await isolatedEnv(STRICT_IDENTITY);
    const provider = createDependencyProvider({ env });
    const report = await provider.check(ctx(root));
    expect(byName(report, "git identity")).toMatchObject({ status: "error", action: IDENTITY_ACTION });
    expect(IDENTITY_ACTION).toContain('git config --global user.name "Your Name"');
    expect(IDENTITY_ACTION).toContain('git config --global user.email "you@example.com"');
    const installed = await provider.install(ctx(root));
    expect(byName(installed, "git identity")).toMatchObject({ status: "manual", action: IDENTITY_ACTION });
    for (const key of ["user.name", "user.email"]) {
      expect((await runProcess("git", ["config", "--get", key], { cwd: root, env })).code).toBe(1);
    }
  });

  test("auto-detected identity is ok but suggests setting it; environment identity counts as set", async () => {
    const root = await repo(false);
    const auto = await createDependencyProvider({ env: await isolatedEnv({ EMAIL: "auto@example.invalid", GIT_AUTHOR_NAME: "A", GIT_COMMITTER_NAME: "A" }) }).check(ctx(root));
    expect(byName(auto, "git identity")).toMatchObject({ status: "ok", detail: "user.email not set; Git auto-detects it from the system", action: IDENTITY_ACTION });
    const fromEnv = await createDependencyProvider({ env: await isolatedEnv({ ...STRICT_IDENTITY, GIT_AUTHOR_NAME: "A", GIT_COMMITTER_NAME: "A", GIT_AUTHOR_EMAIL: "a@example.invalid", GIT_COMMITTER_EMAIL: "a@example.invalid" }) }).check(ctx(root));
    expect(byName(fromEnv, "git identity")).toMatchObject({ status: "ok", detail: "user.name and user.email set" });
    expect(JSON.stringify(fromEnv)).not.toContain("a@example.invalid");
  });

  test("outside a work tree is unverified for the current directory, not a package error", async () => {
    const dir = await temp("plain");
    const env = await isolatedEnv();
    await writeFile(env.GIT_CONFIG_GLOBAL!, "[user]\n\tname = Global\n\temail = global@example.invalid\n");
    const report = await createDependencyProvider({ env }).check(ctx(dir));
    expect(byName(report, "git work tree")).toMatchObject({ status: "unverified" });
    expect(byName(report, "git work tree").detail).toContain("not inside a Git work tree");
    expect(byName(report, "git work tree").action).toContain(`git -C "${dir}" rev-parse --show-toplevel`);
    expect(byName(report, "git identity").status).toBe("ok");
    expect(formatDependencyReport("pi-commit", report, "check")).toMatchObject({ level: "warning" });
    expect(formatDependencyReport("pi-commit", report, "check").text).toStartWith("pi-commit doctor: unverified");
  });

  test("model: none selected or without credentials is an error with an action; never prints credentials", async () => {
    const root = await repo();
    const provider = createDependencyProvider({ env: await isolatedEnv() });
    const none = await provider.check(ctx(root, { model: undefined }));
    expect(byName(none, "planning model")).toMatchObject({ status: "error" });
    expect(byName(none, "planning model").action).toContain("/model");
    const noAuth = await provider.check(ctx(root, { modelRegistry: { hasConfiguredAuth: () => false } }));
    expect(byName(noAuth, "planning model")).toMatchObject({ status: "error", detail: "test/planner: credentials not set" });
    expect(byName(noAuth, "planning model").action).toContain("/login");
    expect(byName(await provider.install(ctx(root, { model: undefined })), "planning model").status).toBe("manual");
    const unknown = await provider.check(ctx(root, { modelRegistry: {} }));
    expect(byName(unknown, "planning model")).toMatchObject({ status: "unverified", action: expect.stringContaining("--dry-run") });
  });

  test("install is idempotent (ok, already available, twice) and concurrent calls share one run", async () => {
    const root = await repo();
    const provider = createDependencyProvider({ env: await isolatedEnv() });
    const first = provider.install(ctx(root));
    expect(provider.install(ctx(root))).toBe(first);
    for (const report of [await first, await provider.install(ctx(root))]) {
      expect(report.items.map(item => item.status)).toEqual(["ok", "ok", "ok"]);
      for (const item of report.items) expect(item.detail).toStartWith("already available");
      expect(formatDependencyReport("pi-commit", report, "install").text).toStartWith("pi-commit install-deps: already available");
    }
  });

  test("check only runs read-only git probes", async () => {
    const root = await repo(false);
    const { calls, run } = recorder();
    await createDependencyProvider({ env: await isolatedEnv(STRICT_IDENTITY), run }).check(ctx(root));
    await createDependencyProvider({ env: await isolatedEnv(), run }).check(ctx(root));
    expect(calls.length).toBeGreaterThan(0);
    for (const [command, ...args] of calls) {
      expect(command).toEndWith("git");
      expect(["--version", "var", "config", "rev-parse"]).toContain(args[0]!);
      if (args[0] === "config") expect(args[1]).toBe("--get");
    }
  });

  test("answers a synchronous request on the umbrella channel from load on", () => {
    const handlers = new Map<string, (data: unknown) => void>();
    const events = { on(channel: string, handler: (data: unknown) => void) { handlers.set(channel, handler); return () => handlers.delete(channel); }, emit() {} };
    const api = { events, registerCommand() {}, registerMessageRenderer() {}, sendMessage() {} };
    registerCommitExtension(api as unknown as ExtensionAPI, createDependencyProvider());
    const provided: DependencyProvider[] = [];
    handlers.get(DEPENDENCY_CHANNEL)!({ version: 1, provide: (provider: DependencyProvider) => provided.push(provider) });
    expect(provided.map(provider => [provider.id, provider.label, provider.command])).toEqual([["pi-commit", "pi-commit", "/commit"]]);
  });
});

describe("/commit doctor and install-deps", () => {
  const report: DependencyReport = { note: "fake", items: [{ name: "git", status: "ok" }, { name: "planning model", status: "error", detail: "none", action: "/model" }] };
  function load() {
    const calls: string[] = [], sent: Array<{ content: string; details: { level: string } }> = [], notified: Array<[string, string]> = [], statuses: Array<string | undefined> = [];
    const provider: DependencyProvider<DoctorContext> = { id: "pi-commit", label: "pi-commit", command: "/commit",
      async check() { calls.push("check"); return report; }, async install() { calls.push("install"); return report; } };
    let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
    const api = { registerCommand: (_: string, definition: typeof command) => { command = definition; }, registerMessageRenderer() {}, sendMessage: (message: never) => sent.push(message) };
    registerCommitExtension(api as unknown as ExtensionAPI, provider);
    const context = { cwd: process.cwd(), mode: "tui", hasUI: true, ui: { notify: (text: string, level: string) => notified.push([text, level]), setStatus: (_: string, text: string | undefined) => statuses.push(text) } };
    return { run: (args: string) => command!.handler(args, context as never), calls, sent, notified, statuses };
  }

  test("doctor and install-deps post the formatted report through the /commit output channel", async () => {
    const loaded = load();
    await loaded.run("doctor");
    await loaded.run("  install-deps ");
    expect(loaded.calls).toEqual(["check", "install"]);
    const check = formatDependencyReport("pi-commit", report, "check"), install = formatDependencyReport("pi-commit", report, "install");
    expect(loaded.sent.map(message => [message.content, message.details.level])).toEqual([[check.text, "error"], [install.text, "error"]]);
    expect(loaded.notified).toEqual([[check.text, "error"], [install.text, "error"]]);
    expect(check.text).toContain("-> /model");
    expect(loaded.statuses.at(-1)).toBeUndefined();
  });

  test("subcommands take no arguments; existing input parses as before", async () => {
    const loaded = load();
    await loaded.run("doctor --dry-run");
    expect(loaded.calls).toEqual([]);
    expect(loaded.sent[0]!.content).toBe("pi-commit: /commit doctor takes no arguments.");
    expect(parseSubcommand("--context doctor --dry-run")).toBeUndefined();
    expect(parseSubcommand("--dry-run")).toBeUndefined();
    expect(parseSubcommand('--context "unclosed')).toBeUndefined();
    expect(parseSubcommand('"doctor"')).toBe("doctor");
    expect(parseCommitArgs("--context doctor --dry-run")).toMatchObject({ dryRun: true, context: "doctor" });
    expect(() => parseCommitArgs("doctor")).toThrow("Unknown /commit option: doctor");
    await loaded.run("--help");
    expect(loaded.sent.at(-1)!.content).toContain("/commit doctor | /commit install-deps");
    expect(loaded.calls).toEqual([]);
  });

  test("completions offer the subcommands only as the first word", () => {
    const values = (prefix: string) => completeCommitArguments(prefix)?.map(item => item.value) ?? null;
    expect(values("")!.slice(-2)).toEqual(["doctor", "install-deps"]);
    expect(values("d")).toEqual(["doctor"]);
    expect(values("  i")).toEqual(["  install-deps"]);
    expect(values("doctor")).toBeNull();
    expect(values("doctor ")).toBeNull();
    expect(values("doctor --")).toBeNull();
    expect(values("--dry-run d")).toBeNull();
    expect(values("--dry-run ")).not.toContain("--dry-run doctor");
  });
});
