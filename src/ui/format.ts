import type { ChangelogChange, CommitGroup, CommitPlan, ExecutionResult, RepoSnapshot } from "../types.js";

/** Escape terminal controls and bidi overrides from untrusted repository text. */
export function safeDisplay(value: string): string {
  return value.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Exact unified replacement block; common lines are retained as 3-line context. */
export function changelogDiff(change: ChangelogChange): string {
  const before = change.originalContent ?? "", after = change.newContent;
  const lines = (content: string) => content ? content.match(/[^\n]*\n|[^\n]+$/g)! : [];
  const old = lines(before), fresh = lines(after);
  let prefix = 0, suffix = 0;
  while (prefix < old.length && prefix < fresh.length && old[prefix] === fresh[prefix]) prefix++;
  while (suffix < old.length - prefix && suffix < fresh.length - prefix && old[old.length - 1 - suffix] === fresh[fresh.length - 1 - suffix]) suffix++;
  if (before === after) return "(no changelog changes)";
  const start = Math.max(0, prefix - 3), oldEnd = Math.min(old.length, old.length - suffix + 3), newEnd = Math.min(fresh.length, fresh.length - suffix + 3);
  const render = (line: string, mark: string) => `${mark}${safeDisplay(line.replace(/\n$/, ""))}${line.endsWith("\n") ? "" : "\n\\ No newline at end of file"}`;
  return [
    `--- ${change.originalContent === null ? "/dev/null" : JSON.stringify(`a/${change.file}`)}`,
    `+++ ${JSON.stringify(`b/${change.file}`)}`,
    `@@ -${old.length ? start + 1 : 0},${oldEnd - start} +${fresh.length ? start + 1 : 0},${newEnd - start} @@`,
    ...old.slice(start, prefix).map(line => render(line, " ")),
    ...old.slice(prefix, old.length - suffix).map(line => render(line, "-")),
    ...fresh.slice(prefix, fresh.length - suffix).map(line => render(line, "+")),
    ...fresh.slice(fresh.length - suffix, newEnd).map(line => render(line, " ")),
  ].join("\n");
}

export function formatPreview(snapshot: RepoSnapshot, plan: CommitPlan, ordered: CommitGroup[], push = false): string {
  const output = ["pi-commit preview", `Repository: ${JSON.stringify(snapshot.root ?? "(unknown)")}`,
    `Mode: ${snapshot.mode} (${snapshot.mode === "staged" ? "ONLY staged changes; unstaged edits preserved" : "tracked + nonignored untracked changes; nothing staged for preview"})`,
    `Base: ${snapshot.headOid ?? "unborn HEAD"}`, `Coverage: ${snapshot.files.length} files; every change selected exactly once`,
    `Order: ${ordered.map(group => group.id).join(" -> ")}`];
  for (const [index, group] of ordered.entries()) {
    output.push("", `${index + 1}. ${group.id}: ${safeDisplay(group.message.subject)}`);
    if (group.message.body) output.push(safeDisplay(group.message.body));
    output.push(`Dependencies: ${group.dependsOn.join(", ") || "none"}`);
    if (group.changelogEntry) output.push(`Changelog entry: ${safeDisplay(group.changelogEntry)}`);
    for (const selector of group.selectors) {
      const file = snapshot.files.find(item => item.path === selector.path)!;
      output.push(`  ${JSON.stringify(file.path)} [${file.status}${file.binary ? ", binary" : ""}${file.isLockfile ? ", lockfile" : ""}]`);
      if (file.oldPath) output.push(`  From: ${JSON.stringify(file.oldPath)}`);
      output.push(`  Selection: ${selector.hunks === "all" ? "ALL (whole-file change)" : selector.hunks.map(id => JSON.stringify(id)).join(", ")}`);
      if (selector.hunks === "all") {
        output.push(safeDisplay(snapshot.diffByFile[file.path] || "(whole-file binary/mode/content change)"));
      } else for (const id of selector.hunks) {
        const hunk = file.hunks.find(item => item.id === id)!;
        output.push(`  ${JSON.stringify(id)} ${safeDisplay(hunk.header)}`, ...hunk.lines.map(safeDisplay));
      }
    }
  }
  if (plan.changelog) output.push("", `Generated changelog: ${JSON.stringify(plan.changelog.file)} (included in ${ordered.at(-1)!.id})`, changelogDiff(plan.changelog));
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
