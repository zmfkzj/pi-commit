import { describe, expect, test } from "bun:test";
import { formatExecution, formatPreview } from "../../src/ui/format.js";
import type { CommitGroup, CommitPlan } from "../../src/types.js";
import { file, group, snapshot } from "../plan/fixtures.js";

describe("formatPreview plan summary", () => {
  const hunkFile = file("src/a.ts");
  hunkFile.hunks[0]!.lines = ["-old-line", "+added-line-unique"];
  hunkFile.hunks[1]!.lines = ["-removed-line-unique", "+second-added-line"];
  const renamed = file("src/new-name.ts", { status: "renamed", oldPath: "src/old-name.ts", hunkSplittable: false, hunks: [] });
  const lock = file("bun.lock", { isLockfile: true, hunkSplittable: false, hunks: [] });
  const binary = file("logo.png", { binary: true, hunkSplittable: false, hunks: [] });
  const files = [hunkFile, renamed, lock, binary];
  const snap = snapshot(files);
  snap.root = "/repo";
  for (const change of files) snap.diffByFile[change.path] = `diff --git a/${change.path} b/${change.path}\n+whole-file-diff-line-unique\n`;
  const groups: CommitGroup[] = [
    { ...group("g1", "src/a.ts", ["src/a.ts#2"]), message: { subject: "Fix parser", body: "Body text.\nSecond line." }, changelogEntry: "Fixed: Parser bug." },
    { ...group("g2", "src/a.ts", ["src/a.ts#1"], ["g1"]), message: { subject: "Evil\x1b[31m subject\u202e" } },
    { id: "g3", message: { subject: "Rename and deps" }, dependsOn: ["g2"], selectors: [{ path: "src/new-name.ts", hunks: "all" }, { path: "bun.lock", hunks: "all" }, { path: "logo.png", hunks: "all" }] },
  ];
  const plan: CommitPlan = { groups, changelog: { file: "CHANGELOG.md", originalContent: "# Changelog\n", newContent: "# Changelog\n\n- changelog-added-line-unique\n" } };
  const text = formatPreview(snap, plan, groups);

  test("lists header, groups, files, flags, renames, selection and changelog target", () => {
    for (const wanted of [
      "pi-commit plan", "Repository: \"/repo\"", "Mode: worktree", "Base: abc", "Coverage: 4 files", "Order: g1 -> g2 -> g3",
      "1. g1: Fix parser", "Body text.", "Second line.", "Dependencies: none", "Changelog entry: Fixed: Parser bug.", "2. g2:", "Dependencies: g1",
      "\"src/a.ts\" [modified]", "Selection: 1 of 2 hunk(s): \"src/a.ts#2\"", "Selection: 1 of 2 hunk(s): \"src/a.ts#1\"",
      "\"src/new-name.ts\" [renamed]", "From: \"src/old-name.ts\"", "\"bun.lock\" [modified, lockfile]", "\"logo.png\" [modified, binary]", "Selection: ALL (whole-file change)",
      "Generated changelog: \"CHANGELOG.md\" (included in g3)", "No push requested.", "Execution runs Git hooks/signing.",
    ]) expect(text).toContain(wanted);
  });

  test("contains no diff content: no hunk lines, whole-file diffs or changelog diff", () => {
    for (const unwanted of ["added-line-unique", "removed-line-unique", "second-added-line", "old-line", "whole-file-diff-line-unique", "changelog-added-line-unique", "diff --git", "@@", "--- ", "+++ ", "No newline at end of file"]) expect(text).not.toContain(unwanted);
    expect(text).not.toMatch(/^[+-]/m);
  });

  test("escapes terminal controls in untrusted text and states the push request", () => {
    expect(text).toContain("Evil\\u001b[31m subject\\u202e");
    expect(text).not.toContain("\x1b");
    expect(text).not.toContain("\u202e");
    expect(formatPreview(snap, { groups }, groups, true)).toContain("EXPLICIT PUSH REQUEST");
    expect(formatPreview(snap, { groups }, groups)).toContain("Generated changelog: none");
  });
});

describe("formatExecution result", () => {
  const groups: CommitGroup[] = [
    { ...group("g1", "src/a.ts", ["src/a.ts#1"]), message: { subject: "Fix parser", body: "Long body text." } },
    { ...group("g2", "src/b.ts", "all", ["g1"]), message: { subject: "Evil\x1b[31m subject" } },
  ];
  const oid1 = "1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", oid2 = "2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

  test("success lists only short OID and commit subject, never committed files", () => {
    const text = formatExecution({ succeeded: [{ groupId: "g1", oid: oid1 }, { groupId: "g2", oid: oid2 }], remainingGroups: [], restoredIndex: false, changelogRestored: false }, groups);
    expect(text).toBe("Committed 2 commits:\n1111111 Fix parser\n2222222 Evil\\u001b[31m subject");
    for (const unwanted of ["src/a.ts", "src/b.ts", "Long body text.", oid1, "g1", "g2"]) expect(text).not.toContain(unwanted);
    expect(formatExecution({ succeeded: [{ groupId: "g1", oid: oid1 }], remainingGroups: [], restoredIndex: false, changelogRestored: false }, groups)).toBe("Committed 1 commit:\n1111111 Fix parser");
  });

  test("failure keeps full OIDs, failed/remaining groups, error and restore status", () => {
    const partial = formatExecution({ succeeded: [{ groupId: "g1", oid: oid1 }], failedGroup: "g2", error: "hook failed", remainingGroups: ["g2"], restoredIndex: false, changelogRestored: false }, groups);
    expect(partial).toBe(`Partial success; stopped.\ng1: ${oid1} Fix parser\nFailed group: g2 (Evil\\u001b[31m subject)\nError: hook failed\nRemaining: g2`);
    const failed = formatExecution({ succeeded: [], failedGroup: "g1", error: "boom", remainingGroups: ["g1", "g2"], restoredIndex: true, changelogRestored: true }, groups);
    expect(failed).toBe("Commit failed; stopped.\nFailed group: g1 (Fix parser)\nError: boom\nRemaining: g1, g2\nOriginal index restored.\nGenerated changelog restored.");
  });
});
