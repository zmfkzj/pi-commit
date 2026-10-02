import type { FileChange, Hunk } from "../types.js";

/** Git's C quoting, including octal UTF-8 bytes (JSON's \\u escapes are not accepted by Git). */
export function quoteGitPath(path: string): string {
  const bytes = Buffer.from(path, "utf8");
  let result = '"';
  for (const byte of bytes) {
    if (byte === 34 || byte === 92) result += `\\${String.fromCharCode(byte)}`;
    else if (byte < 32 || byte >= 127) result += `\\${byte.toString(8).padStart(3, "0")}`;
    else result += String.fromCharCode(byte);
  }
  return result + '"';
}

/**
 * Build against the current HEAD, not the original snapshot coordinates.
 * Earlier committed hunks shift the old coordinates; selected hunks shift this patch's new coordinates.
 * Original Git hunks have disjoint context, so selection order across groups is immaterial.
 */
export function buildHunkPatch(file: FileChange, selectedIds: string[], alreadyCommittedIds: string[] = []): string {
  if (!file.hunkSplittable || selectedIds.length === 0) throw new Error(`Not a splittable hunk selection: ${file.path}`);
  const byId = new Map(file.hunks.map(hunk => [hunk.id, hunk]));
  if (new Set(selectedIds).size !== selectedIds.length) throw new Error("Duplicate hunk selection");
  const selected: Hunk[] = selectedIds.map(id => { const hunk = byId.get(id); if (!hunk) throw new Error(`Unknown hunk ${id}`); return hunk; });
  const prior = alreadyCommittedIds.map(id => { const hunk = byId.get(id); if (!hunk) throw new Error(`Unknown previous hunk ${id}`); return hunk; });
  if (selectedIds.some(id => alreadyCommittedIds.includes(id))) throw new Error("Overlapping hunk selection");
  selected.sort((a, b) => a.oldStart - b.oldStart);
  let patch = `diff --git ${quoteGitPath(`a/${file.path}`)} ${quoteGitPath(`b/${file.path}`)}\n--- ${quoteGitPath(`a/${file.path}`)}\n+++ ${quoteGitPath(`b/${file.path}`)}\n`;
  let delta = 0;
  for (const hunk of selected) {
    const shifted = prior.filter(previous => previous.oldStart < hunk.oldStart)
      .reduce((sum, previous) => sum + previous.newLines - previous.oldLines, 0);
    const oldStart = hunk.oldStart + shifted;
    const newStart = oldStart + delta + (hunk.oldLines === 0 ? 1 : 0) - (hunk.newLines === 0 ? 1 : 0);
    const suffix = hunk.header.replace(/^@@ .*? @@/, "");
    patch += `@@ -${oldStart},${hunk.oldLines} +${newStart},${hunk.newLines} @@${suffix}\n${hunk.lines.join("\n")}\n`;
    delta += hunk.newLines - hunk.oldLines;
  }
  return patch;
}
