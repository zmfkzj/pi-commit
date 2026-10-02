import type { CommitGroup, CommitPlan, ExecutionResult, RepoSnapshot } from "../types.js";

/** Escape terminal controls and bidi overrides from untrusted repository text. */
export function safeDisplay(value: string): string {
  return value.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Compact plan summary for --dry-run, the confirmation dialog and --yes. Deliberately contains no diff content. */
export function formatPreview(snapshot: RepoSnapshot, plan: CommitPlan, ordered: CommitGroup[], push = false): string {
  const quote = (value: string) => JSON.stringify(safeDisplay(value));
  const output = ["pi-commit plan", `Repository: ${quote(snapshot.root ?? "(unknown)")}`,
    `Mode: ${snapshot.mode} (${snapshot.mode === "staged" ? "ONLY staged changes; unstaged edits preserved" : "tracked + nonignored untracked changes; nothing staged while planning"})`,
    `Base: ${snapshot.headOid ?? "unborn HEAD"}`, `Coverage: ${snapshot.files.length} files; every change selected exactly once`,
    `Order: ${ordered.map(group => group.id).join(" -> ")}`];
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

export function formatExecution(result: ExecutionResult): string {
  const output = [result.error ? (result.succeeded.length ? "Partial success; stopped." : "Commit failed; stopped.") : "Commit plan completed."];
  for (const item of result.succeeded) output.push(`${item.groupId}: ${item.oid}`);
  if (result.failedGroup) output.push(`Failed group: ${result.failedGroup}`);
  if (result.error) output.push(`Error: ${safeDisplay(result.error)}`);
  if (result.remainingGroups.length) output.push(`Remaining: ${result.remainingGroups.join(", ")}`);
  if (result.restoredIndex) output.push("Original index restored.");
  if (result.changelogRestored) output.push("Generated changelog restored.");
  return output.join("\n");
}
