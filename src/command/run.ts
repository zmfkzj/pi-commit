import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ModelAdapter, ExecutionResult, CommitPlan, RepoSnapshot } from "../types.js";
import { snapshotRepository, executePlan, recentCommits, pushRepository, checkPushTarget, repositoryRoot, headOid, currentBranch, initializedSubmodules, unpublishedSubmodules, DirtySubmoduleError, type PushTarget } from "../git/index.js";
import { git, lineOutput } from "../git/process.js";
import { planCommits, type EvidenceReport } from "../plan/planner.js";
import { validatePlan } from "../plan/validate.js";
import { createModelAdapter, planEvidenceBudgetBytes } from "../plan/model.js";
import { buildChangelogPreview, detectChangelog } from "../changelog/index.js";
import { HELP, parseCommitArgs, type CommitOptions } from "./args.js";
import { formatEvidenceNotice, formatExecution, formatPreview, formatPushFailure, formatRepositoriesPreview, repositoryLabel, repositoryTitle, safeDisplay, type RepositoryPlanView } from "../ui/format.js";

export type CommitContext = Pick<ExtensionCommandContext, "cwd" | "mode" | "hasUI" | "model" | "signal"> & {
  modelRegistry: Pick<ExtensionCommandContext["modelRegistry"], "find" | "streamSimple">;
  ui: Pick<ExtensionUIContext, "confirm">;
};
export interface CommandServices {
  /** Optional deterministic model injection for tests; never a production fallback. */
  adapter?: ModelAdapter;
  /** Optional pure planner injection for boundary tests; production uses planCommits. */
  planner?: typeof planCommits;
  output(text: string, level?: "info" | "warning" | "error"): void;
}
/** One repository of a --submodules run (`path` relative to the top-level repository, "" for it). */
export interface RepositoryRun extends RepositoryPlanView {
  root: string;
  /** Gitlink paths (relative to `root`) of submodules this run commits first. */
  pending: string[];
  execution?: ExecutionResult;
  pushed?: boolean;
}
export interface CommandResult {
  status: "help" | "empty" | "dry-run" | "cancelled" | "refused" | "executed" | "error";
  snapshot?: RepoSnapshot;
  plan?: CommitPlan;
  execution?: ExecutionResult;
  error?: string;
  pushed?: boolean;
  /** --submodules with changed submodules: every repository, children first (the top-level one last). */
  repositories?: RepositoryRun[];
}

export function resolveModel(ctx: CommitContext, selected?: string) {
  if (!selected) {
    if (!ctx.model) throw new Error("No current model; choose /model or pass --model provider/id.");
    return ctx.model;
  }
  const slash = selected.indexOf("/"), model = ctx.modelRegistry.find(selected.slice(0, slash), selected.slice(slash + 1));
  if (!model) throw new Error(`Unknown registered model: ${selected}`);
  return model;
}

/** Read-only validation also catches unstaged changelog edits excluded by staged mode. */
async function prepareChangelog(snapshot: RepoSnapshot, plan: CommitPlan): Promise<void> {
  // Only this host-side merge may authorize generated content, never a planner-supplied write.
  plan.changelog = undefined;
  const entries = plan.groups.flatMap(group => group.changelogEntry ? [group.changelogEntry] : []);
  if (!entries.length) return;
  const root = snapshot.root!;
  const detected = await detectChangelog(root), file = detected?.file ?? "CHANGELOG.md";
  const status = await git(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--", file]);
  if (status.stdout.length || snapshot.files.some(change => change.path === file || change.oldPath === file)) {
    throw new Error(`Changelog ${JSON.stringify(file)} has user changes; use --no-changelog or first finish those edits.`);
  }
  // check-ignore consumes literal filenames, not pathspecs; Git rejects literal-pathspec mode here.
  const ignored = await git(root, ["check-ignore", "--quiet", "--", file], { allowFailure: true, env: { GIT_LITERAL_PATHSPECS: "0" } });
  if (ignored.code === 0) throw new Error(`Changelog ${JSON.stringify(file)} is ignored; use --no-changelog.`);
  if (ignored.code !== 1) throw new Error("Unable to check changelog ignore rules.");
  const change = buildChangelogPreview(file, detected?.content ?? null, entries);
  plan.changelog = change.newContent !== (change.originalContent ?? "") ? change : undefined;
}

type Model = ReturnType<typeof resolveModel>;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Planner -> host changelog merge -> validation. `target.plan` is set as soon as the planner returns. */
async function planRepository(snapshot: RepoSnapshot, adapter: ModelAdapter, model: Model | undefined, options: CommitOptions, ctx: CommitContext,
  services: CommandServices, target: { plan?: CommitPlan }, label?: string) {
  const history = await recentCommits(snapshot.root!);
  let evidence: EvidenceReport | undefined;
  // Oversized change sets are planned from condensed evidence; say so before the model call (--yes shows no preview).
  const onEvidence = (report: EvidenceReport) => { evidence = report; if (report.condensed) services.output(`${label ? `[${label}] ` : ""}${formatEvidenceNotice(report)}`, "warning"); };
  const plan = await (services.planner ?? planCommits)(snapshot, adapter, { context: options.context, recentCommits: history.split("\n").filter(Boolean), signal: ctx.signal, noChangelog: options.noChangelog, evidenceBudgetBytes: model ? planEvidenceBudgetBytes(model) : undefined, onEvidence });
  target.plan = plan;
  if (options.noChangelog) plan.changelog = undefined;
  else await prepareChangelog(snapshot, plan);
  const validation = validatePlan(plan, snapshot);
  if (!validation.valid) throw new Error(`Invalid plan: ${validation.errors.map(error => error.message).join("; ")}`);
  return { plan, ordered: validation.orderedGroups, evidence };
}

/** Plan -> plan summary -> affirmative authorization -> drift-guarded executor. */
export async function runCommitCommand(args: string, ctx: CommitContext, services: CommandServices): Promise<CommandResult> {
  let result: CommandResult = { status: "error" };
  try {
    const options = parseCommitArgs(args);
    if (options.help) { services.output(HELP); return { status: "help" }; }
    // Snapshot + model planning can take a while; show immediately that /commit started.
    services.output("pi-commit: analyzing changes and planning commits…");
    ctx.signal?.throwIfAborted();
    const model = services.adapter ? undefined : resolveModel(ctx, options.model);
    let snapshot: RepoSnapshot | undefined;
    if (options.submodules) {
      const repositories = await collectRepositories(await repositoryRoot(ctx.cwd), "");
      const pushes = options.push && repositories.length ? await planPushes(repositories) : undefined;
      if (repositories.length > 1 || pushes?.dependencies.length) {
        return await runRepositories(repositories, pushes, options, ctx, services, services.adapter ?? createModelAdapter(model!, ctx.modelRegistry), model, result);
      }
      // No submodule work: the ordinary single-repository run.
      snapshot = repositories[0]?.snapshot;
    }
    snapshot ??= await snapshotRepository(ctx.cwd).catch((error: unknown) => {
      // Committing a dirty submodule before its parent's pointer is the explicit --submodules workflow; say so.
      if (error instanceof DirtySubmoduleError && !options.submodules) {
        throw new Error(`${error.message}, or rerun with --submodules to commit it (and its changed nested submodules) before this repository records its new pointer`);
      }
      throw error;
    });
    result = { status: "error", snapshot };
    if (!snapshot.files.length) { services.output("No changes to commit."); return { ...result, status: "empty" }; }
    const adapter = services.adapter ?? createModelAdapter(model!, ctx.modelRegistry);
    const { plan, ordered, evidence } = await planRepository(snapshot, adapter, model, options, ctx, services, result);
    const preview = formatPreview(snapshot, plan, ordered, options.push, evidence);
    ctx.signal?.throwIfAborted();
    // The file-level plan summary is shown where it is reviewed (dry-run output, the confirmation dialog, the
    // refusal notice), but not posted to the transcript of a run that commits: its result stays message-centric.
    if (options.dryRun) { services.output(preview); services.output("Dry-run: no repository or remote writes."); return { ...result, status: "dry-run" }; }
    // --yes explicitly authorizes the validated plan, so it skips the dialog in every mode.
    if (!options.yes) {
      if (ctx.hasUI) {
        const confirmed = await ctx.ui.confirm("Execute this exact commit plan?", `${preview}\n\nCreate ${plan.groups.length} commit(s)${options.push ? " AND push" : ""}?`, { signal: ctx.signal });
        if (confirmed !== true) { services.output("Cancelled: no repository writes."); return { ...result, status: "cancelled" }; }
      } else {
        services.output(preview);
        services.output("Refused: no confirmation UI. Use --dry-run, or explicitly authorize writes with --yes.", "warning");
        return { ...result, status: "refused" };
      }
    }
    ctx.signal?.throwIfAborted();
    const execution = await executePlan(snapshot, plan, ordered);
    result = { ...result, status: "executed", execution };
    services.output(formatExecution(execution, ordered), execution.error ? "error" : "info");
    if (options.push && !execution.error && !execution.remainingGroups.length && execution.succeeded.length === plan.groups.length) {
      try { await pushRepository(snapshot.root!); result.pushed = true; services.output("Push completed."); }
      catch (pushError) { result.error = formatPushFailure(pushError, execution.succeeded.length); services.output(result.error, "error"); }
    }
    return result;
  } catch (error) {
    const message = safeDisplay(errorText(error));
    services.output(`pi-commit: ${message}`, "error");
    return { ...result, status: "error", error: message };
  }
}

interface CollectedRepository extends PushTarget {
  snapshot: RepoSnapshot;
  pending: string[];
  /** Checked-out submodules (gitlink paths relative to `root`). */
  submodules: string[];
}
interface PushPlan {
  /** Every repository to push, children first. */
  order: PushTarget[];
  /** Paths of the already-committed submodules in `order` (not committed by this run). */
  dependencies: string[];
}

/**
 * --submodules: every repository under `root` (recursively, through checked-out gitlinks) that has changes, children
 * before their parents. A submodule with changes makes its gitlink a pending change of its parent, so the top-level
 * repository comes last whenever anything below it changed. Read-only.
 */
async function collectRepositories(root: string, path: string): Promise<CollectedRepository[]> {
  const at = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); } catch (error) { throw new Error(`${repositoryLabel(path)}: ${errorText(error)}`); }
  };
  const collected: CollectedRepository[] = [], pending: string[] = [];
  const submodules = await at(() => initializedSubmodules(root));
  for (const child of submodules) {
    const nested = await collectRepositories(join(root, child), path ? `${path}/${child}` : child);
    if (nested.length) pending.push(child);
    collected.push(...nested);
  }
  const snapshot = await at(() => snapshotRepository(root, pending));
  if (snapshot.files.length) collected.push({ path, root, snapshot, pending, submodules });
  return collected;
}

/** The OIDs a repository's commits will record for already-committed submodules whose pointer changed (not pending). */
async function plannedPointers(repository: CollectedRepository): Promise<Map<string, string>> {
  const planned = new Map<string, string>();
  for (const file of repository.snapshot.files) {
    if (!repository.submodules.includes(file.path) || repository.pending.includes(file.path) || file.status === "deleted") continue;
    // Staged mode commits the staged pointer; worktree mode the submodule's HEAD.
    const oid = repository.snapshot.mode === "staged"
      ? /^160000 ([0-9a-f]+) /.exec((await git(repository.root, ["ls-files", "--stage", "--", file.path])).stdout.toString("utf8"))?.[1]
      : await headOid(join(repository.root, file.path));
    if (oid) planned.set(file.path, oid);
  }
  return planned;
}

/**
 * --submodules --push: each repository this run commits, preceded by the already-committed submodules (at any depth)
 * whose unpublished commits its push would reference, children first. Read-only; push readiness is checked later.
 */
async function planPushes(collected: CollectedRepository[]): Promise<PushPlan> {
  const skip = new Set(collected.map(repository => repository.root)), order: PushTarget[] = [], dependencies: string[] = [];
  for (const repository of collected) {
    let needed: PushTarget[];
    try { needed = await unpublishedSubmodules(repository.root, repository.path, await plannedPointers(repository), skip); }
    catch (error) { throw new Error(`${repositoryLabel(repository.path)}: ${errorText(error)}`); }
    order.push(...needed, { path: repository.path, root: repository.root });
    dependencies.push(...needed.map(target => target.path));
  }
  return { order, dependencies };
}

/**
 * --submodules with submodule work: plan, merge changelogs and validate EVERY repository first, then one plan summary
 * and one authorization, then commit children before parents (each with the ordinary drift-guarded executor) and,
 * with --push, push children before parents. Any failure stops before the remaining repositories.
 */
async function runRepositories(collected: CollectedRepository[], pushes: PushPlan | undefined, options: CommitOptions, ctx: CommitContext, services: CommandServices,
  adapter: ModelAdapter, model: Model | undefined, result: CommandResult): Promise<CommandResult> {
  const runs: RepositoryRun[] = result.repositories = [];
  for (const repository of collected) {
    ctx.signal?.throwIfAborted();
    const label = repositoryLabel(repository.path), target: { plan?: CommitPlan } = {};
    try {
      const { plan, ordered, evidence } = await planRepository(repository.snapshot, adapter, model, options, ctx, services, target, label);
      runs.push({ path: repository.path, root: repository.root, snapshot: repository.snapshot, pending: repository.pending, plan, ordered, evidence, branch: await currentBranch(repository.root) });
    } catch (error) { throw new Error(`${label}: ${errorText(error)}`); }
  }
  const top = runs.at(-1)!;
  result.snapshot = top.snapshot; result.plan = top.plan;
  const pushOrder = pushes?.order ?? [];
  const preview = formatRepositoriesPreview(runs, options.push, pushes?.dependencies ?? [], pushOrder.map(target => target.path));
  ctx.signal?.throwIfAborted();
  if (options.dryRun) { services.output(preview); services.output("Dry-run: no repository or remote writes."); return { ...result, status: "dry-run" }; }
  // Across several repositories a push problem must not surface only after every repository has committed.
  if (options.push) for (const target of pushOrder) {
    try { await checkPushTarget(target.root); }
    catch (error) { throw new Error(`--push refused before any commit: ${repositoryLabel(target.path)}: ${errorText(error)}`); }
  }
  const commits = runs.reduce((sum, run) => sum + run.plan.groups.length, 0);
  if (!options.yes) {
    if (ctx.hasUI) {
      const question = `Create ${commits} commit(s) in ${runs.length} repositories${options.push ? ` AND push ${pushOrder.length} repositories` : ""}?`;
      const confirmed = await ctx.ui.confirm("Execute this exact commit plan?", `${preview}\n\n${question}`, { signal: ctx.signal });
      if (confirmed !== true) { services.output("Cancelled: no repository writes."); return { ...result, status: "cancelled" }; }
    } else {
      services.output(preview);
      services.output("Refused: no confirmation UI. Use --dry-run, or explicitly authorize writes with --yes.", "warning");
      return { ...result, status: "refused" };
    }
  }
  ctx.signal?.throwIfAborted();
  result.status = "executed";
  const heads = new Map<string, string>(), report: string[] = [];
  const quoted = (paths: string[]) => paths.map(child => JSON.stringify(safeDisplay(child))).join(", ");
  for (const [index, run] of runs.entries()) {
    const title = repositoryTitle(run.path);
    let failure: string | undefined;
    // A parent may only record the exact commits its submodules' executor runs produced.
    const moved: string[] = [];
    for (const child of run.pending) if (!heads.has(join(run.root, child)) || await headOid(join(run.root, child)) !== heads.get(join(run.root, child))) moved.push(child);
    if (moved.length) failure = `${title}: not committed: submodule HEAD changed after this run committed it (${quoted(moved)})`;
    else {
      const execution = run.execution = await executePlan(run.snapshot, run.plan, run.ordered);
      report.push(`${title}: ${formatExecution(execution, run.ordered)}`);
      if (execution.error || execution.remainingGroups.length || execution.succeeded.length !== run.plan.groups.length) {
        failure = `${title}: ${safeDisplay(execution.error ?? "not every planned commit was created")}`;
      } else {
        const head = execution.succeeded.at(-1)!.oid, wrong: string[] = [];
        heads.set(run.root, head);
        for (const child of run.pending) {
          const recorded = await git(run.root, ["rev-parse", "--verify", "--quiet", `${head}:${child}`], { allowFailure: true });
          if (lineOutput(recorded.stdout) !== heads.get(join(run.root, child))) wrong.push(child);
        }
        if (wrong.length) failure = `${title}: commit ${head} does not record this run's submodule commit for ${quoted(wrong)}; history retained`;
      }
    }
    if (failure) {
      const rest = runs.slice(index + 1).map(next => repositoryLabel(next.path));
      result.error = [`Stopped. ${failure}`, ...(rest.length ? [`Not committed: ${rest.join(", ")}`] : []), ...(options.push ? ["Nothing was pushed."] : [])].join("\n");
      services.output([...report, result.error].join("\n"), "error");
      return result;
    }
  }
  result.execution = top.execution;
  services.output(report.join("\n"));
  if (!options.push) return result;
  const created = runs.reduce((sum, run) => sum + (run.execution?.succeeded.length ?? 0), 0), pushed: string[] = [];
  for (const [index, target] of pushOrder.entries()) {
    try { await pushRepository(target.root); }
    catch (pushError) {
      const rest = pushOrder.slice(index + 1).map(next => repositoryLabel(next.path));
      result.error = [`${repositoryTitle(target.path)}: ${formatPushFailure(pushError, created)}`, pushed.length ? `Already pushed: ${pushed.join(", ")}` : "Nothing was pushed.",
        ...(rest.length ? [`Not pushed: ${rest.join(", ")}`] : [])].join("\n");
      services.output(result.error, "error");
      return result;
    }
    pushed.push(repositoryLabel(target.path));
    const run = runs.find(item => item.root === target.root);
    if (run) run.pushed = true;
  }
  result.pushed = true;
  services.output(`Push completed: ${pushed.join(", ")}.`);
  return result;
}
