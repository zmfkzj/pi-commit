import type { CommitGroup, CommitPlan, FileChange, Hunk, RepoSnapshot } from "../../src/types.js";
export function file(path: string, options: Partial<FileChange> = {}): FileChange {
  const hunks: Hunk[] = [1, 2].map(n => ({ id: `${path}#${n}`, header: `@@ -${n * 10},1 +${n * 10},1 @@`, oldStart: n * 10, oldLines: 1, newStart: n * 10, newLines: 1, lines: ["-old", "+new"], contentHash: `hash${n}` }));
  return { path, status: "modified", binary: false, isLockfile: false, untracked: false, origin: "unstaged", hunkSplittable: true, hunks, ...options };
}
export function snapshot(files = [file("src/a.ts")]): RepoSnapshot {
  return { files, mode: "worktree", headOid: "abc", fingerprint: "hash", diffByFile: Object.fromEntries(files.map(file => [file.path, `diff ${file.path}\n-old\n+new`])) };
}
export function group(id = "g1", path = "src/a.ts", hunks: "all" | string[] = "all", dependsOn: string[] = []): CommitGroup {
  return { id, message: { subject: "Fix parser" }, selectors: [{ path, hunks }], dependsOn };
}
export function plan(groups = [group()]): CommitPlan { return { groups }; }
