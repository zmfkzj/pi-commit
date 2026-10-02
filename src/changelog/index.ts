/*
 * Changelog detection/section/deduplication concepts adapted from oh-my-pi at
 * 2a7db746ff9774180e2f81cc1f3fdd8c925269be:
 * packages/coding-agent/src/commit/changelog/detect.ts
 * packages/coding-agent/src/commit/changelog/parse.ts
 * packages/coding-agent/src/commit/changelog/generate.ts
 * MIT License
 * Copyright (c) 2025 Mario Zechner
 * Copyright (c) 2025-2026 Can Bölük
 * Copyright (c) 2026 Stencil Labs, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
import type { ChangelogChange } from "../types.ts";
import { isSafeRepoPath } from "../plan/validate.js";

const CATEGORIES = ["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security", "Breaking Changes"];
interface Line { text: string; start: number; end: number }
function lines(content: string): Line[] {
  const result: Line[] = [];
  for (const match of content.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)) {
    if (!match[0].length) break;
    result.push({ text: match[1]!, start: match.index, end: match.index + match[0].length });
  }
  return result;
}
function key(entry: string): string {
  return entry.trim().replace(/^[-*][ \t]+/, "").replace(/[.]$/, "").replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}
function cleanEntries(entries: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const value of entries) {
    if (typeof value !== "string" || /[\x00-\x1f\x7f-\x9f]/.test(value) || value.length > 1000) throw new Error("Changelog entries must be single safe lines, at most 1000 characters.");
    let entry = value.trim().replace(/^[-*][ \t]+/, "");
    if (!entry) continue;
    const prefix = entry.match(/^([a-z ]+):[ \t]+(.+)$/i);
    const category = CATEGORIES.find(name => name.toLowerCase() === prefix?.[1]?.toLowerCase()) ?? "Changed";
    if (prefix && category.toLowerCase() === prefix[1]!.toLowerCase()) entry = prefix[2]!;
    const list = result.get(category) ?? [];
    list.push(entry); result.set(category, list);
  }
  return result;
}

/** Pure insertion-only Keep-a-Changelog merge. Existing bytes, ordering, newline
 * style, version history and prose are never rewritten. Dedupes Unreleased only.
 * Entries accept optional `Added: ...` / `Fixed: ...` category prefixes; default Changed. */
export function buildChangelogPreview(file: string, originalContent: string | null, entries: string[]): ChangelogChange {
  if (!isSafeRepoPath(file)) throw new Error("Unsafe changelog path.");
  const original = originalContent ?? "";
  const eol = original.match(/\r\n|\n|\r/)?.[0] ?? "\n";
  const sourceLines = lines(original);
  const startIndex = sourceLines.findIndex(line => /^##[ \t]+(?:\[Unreleased\]|Unreleased)(?=[ \t]|$)/i.test(line.text));
  const start = startIndex < 0 ? undefined : sourceLines[startIndex]!;
  const nextHeading = startIndex < 0 ? undefined : sourceLines.slice(startIndex + 1).find(line => /^##[ \t]+/.test(line.text));
  const sectionEnd = nextHeading?.start ?? original.length;
  const sectionLines = start ? sourceLines.filter(line => line.start >= start.end && line.start < sectionEnd) : [];
  const seen = new Set(sectionLines.filter(line => /^[ \t]*[-*][ \t]+/.test(line.text)).map(line => key(line.text)));
  const proposed = cleanEntries(entries);
  for (const [category, values] of proposed) {
    const fresh = values.filter(entry => { const id = key(entry); if (seen.has(id)) return false; seen.add(id); return true; });
    if (fresh.length) proposed.set(category, fresh); else proposed.delete(category);
  }
  if (!proposed.size) return { file, originalContent, newContent: original };
  const render = (category: string, values: string[]) => `### ${category}${eol}${eol}${values.map(value => `- ${value}${eol}`).join("")}${eol}`;
  if (!start) {
    const firstVersion = sourceLines.find(line => /^##[ \t]+/.test(line.text));
    const title = sourceLines.find(line => /^#[ \t]+/.test(line.text));
    const offset = firstVersion?.start ?? title?.end ?? 0;
    const prefix = offset && !/[\r\n]$/.test(original.slice(0, offset)) ? eol : "";
    const titleText = originalContent === null ? `# Changelog${eol}${eol}` : "";
    const insertion = `${prefix}${titleText}${offset && !firstVersion ? eol : ""}## [Unreleased]${eol}${eol}${[...proposed].map(([category, values]) => render(category, values)).join("")}`;
    return { file, originalContent, newContent: original.slice(0, offset) + insertion + original.slice(offset) };
  }
  const insertions: { offset: number; text: string }[] = [];
  let appended = "";
  for (const [category, values] of proposed) {
    const heading = sectionLines.find(line => line.text.trim().toLowerCase() === `### ${category}`.toLowerCase());
    if (heading) {
      const prefix = /[\r\n]$/.test(original.slice(0, heading.end)) ? "" : eol;
      insertions.push({ offset: heading.end, text: `${prefix}${eol}${values.map(value => `- ${value}${eol}`).join("")}` });
    } else appended += render(category, values);
  }
  if (appended) {
    const prefix = sectionEnd > 0 && !/[\r\n]$/.test(original.slice(0, sectionEnd)) ? eol : "";
    insertions.push({ offset: sectionEnd, text: `${prefix}${eol}${appended}` });
  }
  // Coalesce equal offsets in construction order: entries for an EOF category
  // must precede any newly appended category, not be inserted under it.
  const byOffset = new Map<number, string>();
  for (const insertion of insertions) byOffset.set(insertion.offset, (byOffset.get(insertion.offset) ?? "") + insertion.text);
  let newContent = original;
  for (const [offset, text] of [...byOffset].sort((a, b) => b[0] - a[0])) newContent = newContent.slice(0, offset) + text + newContent.slice(offset);
  return { file, originalContent, newContent };
}

/** Optional read-only helper. Rejects symlinks, directories and escape paths. */
export async function readChangelog(root: string, file: string): Promise<{ file: string; content: string } | null> {
  if (!isSafeRepoPath(file)) throw new Error("Unsafe changelog path.");
  const canonicalRoot = await realpath(root);
  const target = resolve(canonicalRoot, file);
  const rel = relative(canonicalRoot, target);
  if (!rel || rel.startsWith(`..${sep}`) || rel === "..") throw new Error("Changelog escapes the repository.");
  try {
    let current = canonicalRoot;
    const segments = rel.split(sep);
    for (let i = 0; i < segments.length; i++) {
      current = resolve(current, segments[i]!);
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (i < segments.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error("Changelog must be a regular file inside real directories, not a symlink.");
    }
    const bytes = await readFile(target);
    const content = bytes.toString("utf8");
    if (!Buffer.from(content, "utf8").equals(bytes)) throw new Error("Changelog is not valid UTF-8; refusing a lossy merge.");
    return { file, content };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** One root changelog, matching the single-target contract. No recursive scan or writes. */
export async function detectChangelog(root: string): Promise<{ file: string; content: string } | null> {
  const candidates = (await readdir(root)).filter(name => /^change[-_]?log\.md$/i.test(name)).sort((a, b) => a === "CHANGELOG.md" ? -1 : b === "CHANGELOG.md" ? 1 : a.localeCompare(b));
  for (const file of candidates) {
    const result = await readChangelog(root, file);
    if (result) return result;
  }
  return null;
}
