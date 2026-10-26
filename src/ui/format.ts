import type { CommitGroup, CommitPlan, ExecutionResult, RepoSnapshot } from "../types.js";
import type { EvidenceReport } from "../plan/planner.js";

const kb = (bytes: number): string => `${Math.max(1, Math.round(bytes / 1000))} KB`;

/** Shown before the model call of an oversized change set: what was planned from what, and that commits use full diffs. */
export function formatEvidenceNotice(report: EvidenceReport): string {
  return `pi-commit: the change set has ~${kb(report.fullBytes)} of planner evidence, over this model's ~${kb(report.budgetBytes)} budget, ` +
    `so all ${report.files} files and ${report.hunks} hunks are planned from condensed evidence (~${kb(report.sentBytes)} sent): ` +
    `every path, status and hunk ID is included, but ${report.truncatedItems} hunk(s)/file diff(s) show only their first ~${report.contentCapBytes ?? 0} bytes to the model. ` +
    "Commits still apply the full diffs; use --dry-run to review the plan first.";
}

/** One preview line for condensed planning; empty for normal evidence. */
export function evidencePreviewLine(report: EvidenceReport | undefined): string[] {
  if (!report?.condensed) return [];
  return [`Evidence: CONDENSED for the model (~${kb(report.sentBytes)} of ~${kb(report.fullBytes)}; ${report.truncatedItems} hunk(s)/file diff(s) cut to ~${report.contentCapBytes ?? 0} bytes); commits use the full diffs`];
}

/** Escape terminal controls and bidi overrides from untrusted repository text. */
export function safeDisplay(value: string): string {
  return value.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Compact plan summary for --dry-run, the confirmation dialog and --yes. Deliberately contains no diff content. */
export function formatPreview(snapshot: RepoSnapshot, plan: CommitPlan, ordered: CommitGroup[], push = false, evidence?: EvidenceReport): string {
  const quote = (value: string) => JSON.stringify(safeDisplay(value));
  const output = ["pi-commit plan", `Repository: ${quote(snapshot.root ?? "(unknown)")}`,
    `Mode: ${snapshot.mode} (${snapshot.mode === "staged" ? "ONLY staged changes; unstaged edits preserved" : "tracked + nonignored untracked changes; nothing staged while planning"})`,
    `Base: ${snapshot.headOid ?? "unborn HEAD"}`, `Coverage: ${snapshot.files.length} files; every change selected exactly once`,
    ...evidencePreviewLine(evidence), `Order: ${ordered.map(group => group.id).join(" -> ")}`];
  for (const [index, group] of ordered.entries()) {
    output.push("", `${index + 1}. ${group.id}: ${safeDisplay(group.message.subject)}`);
    if (group.message.body) output.push(safeDisplay(group.message.body));
    output.push(`Dependencies: ${group.dependsOn.join(", ") || "none"}`);
    if (group.changelogEntry) output.push(`Changelog entry: ${safeDisplay(group.changelogEntry)}`);
    for (const selector of group.selectors) {
      const file = snapshot.files.find(item => item.path === selector.path)!;
      output.push(`  ${quote(file.path)} [${file.status}${file.binary ? ", binary" : ""}${file.isLockfile ? ", lockfile" : ""}]`);
      if (file.oldPath) output.push(`  From: ${quote(file.oldPath)}`);
      const selection = selector.hunks === "all" ? "ALL (whole-file change)" : `${selector.hunks.length} of ${file.hunks.length} hunk(s): ${selector.hunks.map(quote).join(", ")}`;
      output.push(`  Selection: ${selection}`);
    }
  }
  if (plan.changelog) output.push("", `Generated changelog: ${quote(plan.changelog.file)} (included in ${ordered.at(-1)!.id})`);
  else output.push("", "Generated changelog: none");
  output.push("", push ? "EXPLICIT PUSH REQUEST: push current branch after ALL commits succeed (no force)." : "No push requested.",
    "Execution runs Git hooks/signing. A later failure keeps earlier successful commits; no fallback or history reset.");
  return output.join("\n");
}

/**
 * Result of executing a plan. Success is message-centric (short OID + commit subject per commit) and never lists
 * committed files; failures keep full OIDs, the failed/remaining groups and restore status for recovery.
 */
export function formatExecution(result: ExecutionResult, groups: CommitGroup[] = []): string {
  const subject = (id: string) => {
    const group = groups.find(item => item.id === id);
    return group ? safeDisplay(group.message.subject) : undefined;
  };
  if (!result.error) {
    const count = result.succeeded.length;
    const output = [`Committed ${count} commit${count === 1 ? "" : "s"}:`];
    for (const item of result.succeeded) output.push(`${item.oid.slice(0, 7)} ${subject(item.groupId) ?? item.groupId}`);
    return output.join("\n");
  }
  const output = [result.succeeded.length ? "Partial success; stopped." : "Commit failed; stopped."];
  for (const item of result.succeeded) output.push(`${item.groupId}: ${item.oid}${subject(item.groupId) ? ` ${subject(item.groupId)}` : ""}`);
  if (result.failedGroup) output.push(`Failed group: ${result.failedGroup}${subject(result.failedGroup) ? ` (${subject(result.failedGroup)})` : ""}`);
  output.push(`Error: ${safeDisplay(result.error)}`);
  if (result.remainingGroups.length) output.push(`Remaining: ${result.remainingGroups.join(", ")}`);
  if (result.restoredIndex) output.push("Original index restored.");
  if (result.changelogRestored) output.push("Generated changelog restored.");
  return output.join("\n");
}

const AUTH_FAILURE = /terminal prompts disabled|could not read (?:Username|Password)|Authentication failed|Invalid username or (?:password|token)|Permission denied \(publickey|Host key verification failed|could not read from remote repository|returned error: 40[13]|No such device or address/i;

/**
 * Push failure after successful commits: states that the commits exist locally, why the push failed (credentials in
 * URLs redacted, bounded, control characters escaped) and, for authentication failures, how to authenticate
 * non-interactively. pi never answers a credential prompt itself.
 */
export function formatPushFailure(error: unknown, committed: number): string {
  const raw = error instanceof Error ? error.message : String(error);
  const lines = raw.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@").split("\n").map(line => line.trim()).filter(Boolean);
  let reason = lines.slice(-6).join("\n");
  if (reason.length > 600) reason = `…${reason.slice(-600)}`;
  const output = [
    `Push failed or refused; local commits remain (${committed} commit${committed === 1 ? "" : "s"} created locally). No retry, force push or history rollback performed.`,
    `Reason: ${safeDisplay(reason || "unknown push error")}`,
  ];
  if (AUTH_FAILURE.test(raw)) {
    output.push("Authentication required: pi-commit never waits for a Git username/password/passphrase prompt. " +
      "Set up non-interactive auth (an HTTPS credential helper, e.g. `gh auth setup-git`, or an SSH remote with a key loaded in ssh-agent), then run `git push` in a shell.");
  }
  return output.join("\n");
}
