import { describe, expect, test } from "bun:test";
import { formatPreview } from "../../src/ui/format.js";
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
