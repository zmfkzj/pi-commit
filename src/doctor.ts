import { fileURLToPath } from "node:url";
import {
  findExecutable,
  installNpmDependencies,
  npmDependencyItem,
  outputTail,
  runProcess,
  type DependencyItem,
  type DependencyProvider,
  type DependencyReport,
  type RunResult,
} from "./dependencies.js";

/** pi-commit's package directory (this file lives in src/). */
export const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
/** `git rev-parse --path-format=absolute` (snapshot/executor) needs Git 2.31. */
export const MIN_GIT_VERSION: readonly [number, number, number] = [2, 31, 0];
const PROBE_TIMEOUT_MS = 5_000;
const NOTE = "No npm runtime dependencies (Pi's own packages are peers). Needs Git, a Git identity to commit and a Pi model for planning.";

/** The part of the Pi command context the checks read. */
export interface DoctorContext {
  cwd: string;
  model?: { provider: string; id: string };
  modelRegistry?: { hasConfiguredAuth?(model: never): boolean };
}
export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  /** PATH directories to search for git instead of env.PATH (tests). */
  pathDirs?: string[];
  platform?: NodeJS.Platform;
  run?: typeof runProcess;
  packageDir?: string;
}

export function parseGitVersion(text: string): [number, number, number] | undefined {
  const match = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : undefined;
}
function atLeast(version: readonly number[], minimum: readonly number[]): boolean {
  for (let i = 0; i < minimum.length; i++) if ((version[i] ?? 0) !== minimum[i]) return (version[i] ?? 0) > minimum[i]!;
  return true;
}
const MIN = `${MIN_GIT_VERSION[0]}.${MIN_GIT_VERSION[1]}`;

export function gitInstallHint(platform: NodeJS.Platform): string {
  const how = platform === "darwin" ? "xcode-select --install (or brew install git)"
    : platform === "win32" ? "winget install --id Git.Git -e"
    : "your package manager, e.g. sudo apt install git / sudo dnf install git";
  return `Install Git ${MIN} or newer with ${how}, make sure \`git --version\` works in the shell that starts pi, then restart pi`;
}
export const IDENTITY_ACTION = 'Set it yourself (pi-commit never does): git config --global user.name "Your Name" && git config --global user.email "you@example.com" (inside a repository, omit --global for a per-repository identity)';

/** Git probe environment: no inherited repository overrides (as src/git/process.ts), no optional locks. */
function gitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete result[key];
  return result;
}

interface GitState { path?: string; item: DependencyItem; usable: boolean }

async function probeGit(options: Required<Pick<DoctorOptions, "env" | "platform" | "run">> & DoctorOptions): Promise<GitState> {
  const path = findExecutable("git", options.env, options.pathDirs);
  const action = gitInstallHint(options.platform);
  if (!path) return { usable: false, item: { name: "git", status: "error", detail: "git is not on PATH", action } };
  const result = await options.run(path, ["--version"], { env: gitEnv(options.env), timeoutMs: PROBE_TIMEOUT_MS });
  if (result.code !== 0) return { path, usable: false, item: { name: "git", status: "error", detail: `${path} --version failed: ${outputTail(result, 2)}`, action } };
  const version = parseGitVersion(result.stdout);
  if (!version) return { path, usable: true, item: { name: "git", status: "unverified", detail: `unrecognized version output from ${path}`, action: `Check that \`git --version\` reports ${MIN} or newer` } };
  const text = version.join(".");
  if (!atLeast(version, MIN_GIT_VERSION)) {
    return { path, usable: false, item: { name: "git", status: "error", detail: `Git ${text} at ${path}; pi-commit needs ${MIN} or newer (git rev-parse --path-format)`, action } };
  }
  return { path, usable: true, item: { name: "git", status: "ok", detail: `Git ${text} (${path})` } };
}

const succeeded = (result: RunResult) => result.code === 0;
async function configured(run: typeof runProcess, git: string, cwd: string, env: NodeJS.ProcessEnv, key: string): Promise<boolean> {
  return succeeded(await run(git, ["config", "--get", key], { cwd, env, timeoutMs: PROBE_TIMEOUT_MS }));
}

/** Whether Git can build the author and committer identity a commit in `cwd` needs (repository config included). */
async function identityItem(run: typeof runProcess, git: string, cwd: string, env: NodeJS.ProcessEnv): Promise<DependencyItem> {
  const probeEnv = gitEnv(env);
  const name = "git identity (user.name / user.email)";
  const [author, committer] = await Promise.all(["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"].map(variable => run(git, ["var", variable], { cwd, env: probeEnv, timeoutMs: PROBE_TIMEOUT_MS })));
  if (author!.timedOut || committer!.timedOut || author!.code === null || committer!.code === null) {
    return { name, status: "unverified", detail: `git var could not run in ${cwd}: ${outputTail(author!.code === null ? author! : committer!, 1)}`, action: "Check by hand: git var GIT_AUTHOR_IDENT && git var GIT_COMMITTER_IDENT" };
  }
  if (!succeeded(author!) || !succeeded(committer!)) {
    return { name, status: "error", detail: `Git cannot determine the ${!succeeded(author!) ? "author" : "committer"} identity for ${cwd}; commits would fail (dry runs still work)`, action: IDENTITY_ACTION };
  }
  const explicitName = await configured(run, git, cwd, probeEnv, "user.name") || (!!env.GIT_AUTHOR_NAME && !!env.GIT_COMMITTER_NAME);
  const explicitEmail = await configured(run, git, cwd, probeEnv, "user.email") || (!!env.GIT_AUTHOR_EMAIL && !!env.GIT_COMMITTER_EMAIL);
  if (explicitName && explicitEmail) return { name, status: "ok", detail: "user.name and user.email set" };
  const missing = [explicitName ? "" : "user.name", explicitEmail ? "" : "user.email"].filter(Boolean).join(" and ");
  return { name, status: "ok", detail: `${missing} not set; Git auto-detects it from the system`, action: IDENTITY_ACTION };
}

/** A per-use condition: /commit runs inside a Git work tree. Not an error of the package. */
async function workTreeItem(run: typeof runProcess, git: string, cwd: string, env: NodeJS.ProcessEnv): Promise<DependencyItem> {
  const name = "git work tree (current directory)";
  const result = await run(git, ["rev-parse", "--show-toplevel"], { cwd, env: gitEnv(env), timeoutMs: PROBE_TIMEOUT_MS });
  if (succeeded(result) && result.stdout.trim()) return { name, status: "ok", detail: result.stdout.trim() };
  if (/dubious ownership/.test(result.stderr)) {
    return { name, status: "unverified", detail: `${cwd}: Git refuses this repository (dubious ownership)`, action: `If you trust it: git config --global --add safe.directory <repository root shown by git>; check with: git -C "${cwd}" rev-parse --show-toplevel` };
  }
  return { name, status: "unverified", detail: `${cwd} is not inside a Git work tree; /commit only works inside one`, action: `Run /commit from a Git repository; check with: git -C "${cwd}" rev-parse --show-toplevel` };
}

const MODEL_ACTION = "Select a model with /model (or pass --model provider/id to /commit) and configure its credentials (/login or the provider's API key)";
/** Read-only: whether a planning model is selected and has credentials configured. Credentials are never shown. */
export function modelItem(ctx: DoctorContext): DependencyItem {
  const name = "planning model";
  if (!ctx.model) return { name, status: "error", detail: "no current model; commit planning needs one", action: MODEL_ACTION };
  const label = `${ctx.model.provider}/${ctx.model.id}`;
  const hasAuth = ctx.modelRegistry?.hasConfiguredAuth;
  if (typeof hasAuth !== "function") return { name, status: "unverified", detail: `${label}; credentials not checked`, action: "Run /commit --dry-run to verify the model answers" };
  let auth: boolean;
  try { auth = hasAuth.call(ctx.modelRegistry, ctx.model as never); }
  catch { return { name, status: "unverified", detail: `${label}; credential check failed`, action: "Run /commit --dry-run to verify the model answers" }; }
  if (!auth) return { name, status: "error", detail: `${label}: credentials not set`, action: `Configure credentials for ${ctx.model.provider} (/login or its API key environment variable), or pass --model with a configured provider/id` };
  return { name, status: "ok", detail: `${label} (credentials set)` };
}

/** Requirement errors become manual install steps: nothing here is installed automatically. */
function asManual(item: DependencyItem): DependencyItem {
  if (item.status === "error") return { ...item, status: "manual" };
  if (item.status === "ok") return { ...item, detail: `already available: ${item.detail}` };
  return item;
}

export function createDependencyProvider(options: DoctorOptions = {}): DependencyProvider<DoctorContext> {
  const settings = { env: options.env ?? process.env, platform: options.platform ?? process.platform, run: options.run ?? runProcess, pathDirs: options.pathDirs };
  const packageDir = options.packageDir ?? PACKAGE_DIR;
  let installing: Promise<DependencyReport> | undefined;

  async function requirements(ctx: DoctorContext, withWorkTree: boolean): Promise<DependencyItem[]> {
    const git = await probeGit(settings);
    const items = [git.item];
    if (git.usable && git.path) {
      items.push(await identityItem(settings.run, git.path, ctx.cwd, settings.env));
      if (withWorkTree) items.push(await workTreeItem(settings.run, git.path, ctx.cwd, settings.env));
    } else {
      items.push({ name: "git identity (user.name / user.email)", status: "unverified", detail: "not checked: Git is unavailable", action: "After installing Git: git var GIT_AUTHOR_IDENT && git var GIT_COMMITTER_IDENT" });
    }
    items.push(modelItem(ctx));
    return items;
  }

  return {
    id: "pi-commit",
    label: "pi-commit",
    command: "/commit",
    async check(ctx) {
      return { note: NOTE, items: [...await requirements(ctx, true), ...npmDependencyItem(packageDir, "/commit")] };
    },
    install(ctx) {
      installing ??= (async () => {
        try {
          const npm = await installNpmDependencies(packageDir, { env: settings.env });
          return { note: `${NOTE} Nothing is installed automatically: Git, the identity and model credentials are manual steps.`, items: [...(await requirements(ctx, false)).map(asManual), ...npm] };
        } finally { installing = undefined; }
      })();
      return installing;
    },
  };
}
