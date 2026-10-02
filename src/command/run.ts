import type { ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ModelAdapter, ExecutionResult, CommitPlan, RepoSnapshot } from "../types.js";
import { snapshotRepository, executePlan, recentCommits, pushRepository } from "../git/index.js";
import { git } from "../git/process.js";
import { planCommits } from "../plan/planner.js";
import { validatePlan } from "../plan/validate.js";
import { createModelAdapter } from "../plan/model.js";
import { buildChangelogPreview, detectChangelog } from "../changelog/index.js";
import { HELP, parseCommitArgs } from "./args.js";
import { formatExecution, formatPreview, safeDisplay } from "../ui/format.js";

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
export interface CommandResult {
  status: "help" | "empty" | "dry-run" | "cancelled" | "refused" | "executed" | "error";
  snapshot?: RepoSnapshot;
  plan?: CommitPlan;
  execution?: ExecutionResult;
  error?: string;
  pushed?: boolean;
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
    const snapshot = await snapshotRepository(ctx.cwd);
    result = { status: "error", snapshot };
    if (!snapshot.files.length) { services.output("No changes to commit."); return { ...result, status: "empty" }; }
    const adapter = services.adapter ?? createModelAdapter(model!, ctx.modelRegistry);
    const history = await recentCommits(snapshot.root!);
    const plan = await (services.planner ?? planCommits)(snapshot, adapter, { context: options.context, recentCommits: history.split("\n").filter(Boolean), signal: ctx.signal, noChangelog: options.noChangelog });
    result.plan = plan;
    if (options.noChangelog) plan.changelog = undefined;
    else await prepareChangelog(snapshot, plan);
    const validation = validatePlan(plan, snapshot);
    if (!validation.valid) throw new Error(`Invalid plan: ${validation.errors.map(error => error.message).join("; ")}`);
    const preview = formatPreview(snapshot, plan, validation.orderedGroups, options.push);
    services.output(preview);
    ctx.signal?.throwIfAborted();
    if (options.dryRun) { services.output("Dry-run: no repository or remote writes."); return { ...result, status: "dry-run" }; }
    // --yes explicitly authorizes the already-displayed plan summary, so it skips the dialog in every mode.
    if (!options.yes) {
      if (ctx.hasUI) {
        const confirmed = await ctx.ui.confirm("Execute this exact commit plan?", `${preview}\n\nCreate ${plan.groups.length} commit(s)${options.push ? " AND push" : ""}?`, { signal: ctx.signal });
        if (confirmed !== true) { services.output("Cancelled: no repository writes."); return { ...result, status: "cancelled" }; }
      } else {
        services.output("Refused: no confirmation UI. Use --dry-run, or explicitly authorize writes with --yes.", "warning");
        return { ...result, status: "refused" };
      }
    }
    ctx.signal?.throwIfAborted();
    const execution = await executePlan(snapshot, plan, validation.orderedGroups);
    result = { ...result, status: "executed", execution };
    services.output(formatExecution(execution), execution.error ? "error" : "info");
    if (options.push && !execution.error && !execution.remainingGroups.length && execution.succeeded.length === plan.groups.length) {
      try { await pushRepository(snapshot.root!); result.pushed = true; services.output("Push completed."); }
      catch { result.error = "Push failed or refused; local commits remain. No retry, force push or history rollback performed."; services.output(result.error, "error"); }
    }
    return result;
  } catch (error) {
    const message = safeDisplay(error instanceof Error ? error.message : String(error));
    services.output(`pi-commit: ${message}`, "error");
    return { ...result, status: "error", error: message };
  }
}
