/*
 * Adapted from oh-my-pi at 2a7db746ff9774180e2f81cc1f3fdd8c925269be:
 * packages/coding-agent/src/commit/agentic/topo-sort.ts
 * packages/coding-agent/src/commit/agentic/lock-files.ts
 * packages/coding-agent/src/commit/agentic/tools/split-commit.ts
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
import type { CommitGroup, CommitPlan, PlanValidationError, PlanValidationResult, RepoSnapshot } from "../types.ts";

export const SUBJECT_MAX_CHARS = 72;
export const LOCK_FILE_MANIFESTS: Readonly<Record<string, readonly string[]>> = {
  "Cargo.lock": ["Cargo.toml"], "package-lock.json": ["package.json"],
  "yarn.lock": ["package.json"], "pnpm-lock.yaml": ["package.json"],
  "bun.lock": ["package.json"], "bun.lockb": ["package.json"],
  "go.sum": ["go.mod"], "poetry.lock": ["pyproject.toml"], "Pipfile.lock": ["Pipfile"],
  "uv.lock": ["pyproject.toml"], "composer.lock": ["composer.json"], "Gemfile.lock": ["Gemfile"],
  "flake.lock": ["flake.nix"], "pubspec.lock": ["pubspec.yaml"], "Podfile.lock": ["Podfile"],
  "mix.lock": ["mix.exs"], "gradle.lockfile": ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"],
};

/** Conservative on both POSIX and Windows; exact snapshot membership is checked separately. */
export function isSafeRepoPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.includes("\0") || /^[\\/]|^[a-z]:/i.test(value)) return false;
  return !value.replace(/\\/g, "/").split("/").some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === "string");
}
function groupShape(value: unknown): value is CommitGroup {
  if (!object(value) || !keys(value, ["id", "message", "selectors", "dependsOn", "changelogEntry"])) return false;
  if (typeof value.id !== "string" || !object(value.message) || !keys(value.message, ["subject", "body"])) return false;
  if (typeof value.message.subject !== "string" || (value.message.body !== undefined && typeof value.message.body !== "string")) return false;
  if (!strings(value.dependsOn) || (value.changelogEntry !== undefined && typeof value.changelogEntry !== "string")) return false;
  return Array.isArray(value.selectors) && value.selectors.every(selector =>
    object(selector) && keys(selector, ["path", "hunks"]) && typeof selector.path === "string" &&
    (selector.hunks === "all" || strings(selector.hunks)));
}

/** Does not normalize/repair input. Coverage and lockfile placement must be explicit in the preview. */
export function validatePlan(input: unknown, snapshot: RepoSnapshot): PlanValidationResult {
  const errors: PlanValidationError[] = [];
  const fail = (code: string, message: string, detail: Partial<PlanValidationError> = {}) => errors.push({ code, message, ...detail });
  if (!object(input) || !keys(input, ["groups", "changelog"]) || !Array.isArray(input.groups) || !input.groups.every(groupShape)) {
    fail("invalid_shape", "Plan must contain groups with id, message, selectors and dependsOn; unknown properties are forbidden.");
    return { valid: false, errors, orderedGroups: [] };
  }
  const plan = input as unknown as CommitPlan;
  if (!plan.groups.length || !snapshot.files.length) fail("empty_plan", "A plan and its snapshot must contain changes.");
  const files = new Map(snapshot.files.map(file => [file.path, file]));
  const units = new Map<string, number>();
  const unitKey = (path: string, hunk: string) => JSON.stringify([path, hunk]);
  for (const file of snapshot.files) {
    if (!isSafeRepoPath(file.path) || (file.oldPath !== undefined && !isSafeRepoPath(file.oldPath))) fail("unsafe_snapshot", "Snapshot contains an unsafe path.", { path: file.path });
    const ids = file.hunkSplittable && file.hunks.length ? file.hunks.map(hunk => hunk.id) : ["@whole-file"];
    if (new Set(ids).size !== ids.length) fail("invalid_snapshot", "Snapshot has duplicate hunk IDs.", { path: file.path });
    for (const id of ids) units.set(unitKey(file.path, id), 0);
  }
  const ids = new Set<string>();
  const fileOwners = new Map<string, Set<string>>();
  for (const group of plan.groups) {
    const detail = { groupId: group.id };
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(group.id)) fail("invalid_group_id", "Group IDs must be 1–64 ASCII letters, digits, underscores or hyphens.", detail);
    if (ids.has(group.id)) fail("duplicate_group", "Group IDs must be unique.", detail);
    ids.add(group.id);
    if (!group.message.subject.trim() || [...group.message.subject].length > SUBJECT_MAX_CHARS || /[\x00-\x1f\x7f-\x9f]/.test(group.message.subject)) fail("invalid_message", "Subject must be nonempty, at most 72 characters, and contain no control characters.", detail);
    if (group.message.body !== undefined && (group.message.body.length > 32768 || /[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(group.message.body))) fail("invalid_message", "Body may contain newlines but not other control characters (maximum 32768 characters).", detail);
    if (group.changelogEntry !== undefined && (!group.changelogEntry.trim() || group.changelogEntry.length > 1000 || /[\x00-\x1f\x7f-\x9f]/.test(group.changelogEntry))) fail("invalid_changelog_entry", "Changelog entry must be one nonempty line without control characters (maximum 1000 characters).", detail);
    if (!group.selectors.length) fail("empty_group", "Each group must select changes.", detail);
    if (new Set(group.dependsOn).size !== group.dependsOn.length) fail("duplicate_dependency", "Dependencies must be unique.", detail);
    for (const selector of group.selectors) {
      const selectedDetail = { ...detail, path: selector.path };
      if (!isSafeRepoPath(selector.path)) { fail("unsafe_path", "Selector must be a safe repository-relative path.", selectedDetail); continue; }
      const file = files.get(selector.path);
      if (!file) { fail("unknown_path", "Selector path is absent from the snapshot.", selectedDetail); continue; }
      const owners = fileOwners.get(file.path) ?? new Set<string>();
      owners.add(group.id); fileOwners.set(file.path, owners);
      if (selector.hunks !== "all" && (!file.hunkSplittable || !file.hunks.length || file.isLockfile)) {
        fail("whole_file_required", "This change must use hunks:'all' (lockfiles and unsafe-to-split files are whole-file only).", selectedDetail); continue;
      }
      const hunkIds = selector.hunks === "all"
        ? (file.hunkSplittable && file.hunks.length ? file.hunks.map(hunk => hunk.id) : ["@whole-file"])
        : selector.hunks;
      if (!hunkIds.length) fail("empty_selector", "A hunk selector must not be empty.", selectedDetail);
      for (const hunkId of hunkIds) {
        const key = unitKey(file.path, hunkId);
        const count = units.get(key);
        if (count === undefined) { fail("unknown_hunk", "Hunk ID is absent from this file's snapshot.", { ...selectedDetail, hunkId }); continue; }
        units.set(key, count + 1);
        if (count > 0) fail("overlap", "A file/hunk may be selected only once across the plan.", { ...selectedDetail, hunkId });
      }
    }
  }
  for (const [key, count] of units) {
    if (count === 0) {
      const [path, hunkId] = JSON.parse(key) as [string, string];
      fail("missing_coverage", "Every snapshot change must be covered exactly once.", { path, hunkId });
    }
  }
  for (const group of plan.groups) for (const dependency of group.dependsOn) {
    if (!ids.has(dependency)) fail("unknown_dependency", `Unknown dependency: ${dependency}`, { groupId: group.id });
    if (dependency === group.id) fail("self_dependency", "A group cannot depend on itself.", { groupId: group.id });
  }

  // Deterministic pairing: first sibling manifest in mapping order; otherwise the
  // first matching snapshot manifest in lexical path order. Splitting that manifest
  // across groups is ambiguous and rejected; do not silently relocate a lockfile.
  for (const lock of snapshot.files.filter(file => file.isLockfile)) {
    const slash = lock.path.lastIndexOf("/");
    const dir = lock.path.slice(0, slash + 1);
    const names = LOCK_FILE_MANIFESTS[lock.path.slice(slash + 1)] ?? [];
    let manifest: string | undefined;
    for (const name of names) { if (files.has(dir + name)) { manifest = dir + name; break; } }
    if (!manifest) for (const name of names) {
      manifest = snapshot.files.map(file => file.path).filter(path => path.split("/").at(-1) === name).sort()[0];
      if (manifest) break;
    }
    const ownerIds = fileOwners.get(lock.path) ?? new Set<string>();
    if (manifest) {
      const manifestOwners = fileOwners.get(manifest) ?? new Set<string>();
      if (manifestOwners.size !== 1 || ownerIds.size !== 1 || [...ownerIds][0] !== [...manifestOwners][0]) fail("lockfile_group", `Lockfile must share one group with manifest ${JSON.stringify(manifest)}; do not split the paired manifest across groups.`, { path: lock.path });
    } else {
      for (const group of plan.groups.filter(group => ownerIds.has(group.id))) {
        if (group.selectors.some(selector => !files.get(selector.path)?.isLockfile)) fail("lockfile_group", "An unpaired lockfile needs a dedicated dependency-only group (only lockfile selectors).", { path: lock.path, groupId: group.id });
      }
    }
  }
  if (plan.changelog !== undefined) {
    const change: unknown = plan.changelog;
    if (!object(change) || !keys(change, ["file", "originalContent", "newContent"]) || !isSafeRepoPath(change.file) || typeof change.newContent !== "string" || !(change.originalContent === null || typeof change.originalContent === "string")) fail("invalid_changelog", "Generated changelog must contain a safe file, originalContent (string|null), and newContent.");
    else if (snapshot.files.some(file => file.path === change.file || file.oldPath === change.file)) fail("changelog_overlap", "Generated changelog may not overwrite an already-changed snapshot file.", { path: change.file });
  }
  // Kahn's algorithm, always choose the earliest currently available original item.
  const pending = [...plan.groups];
  const done = new Set<string>();
  const orderedGroups: CommitGroup[] = [];
  while (pending.length) {
    const index = pending.findIndex(group => group.dependsOn.every(id => done.has(id)));
    if (index < 0) { if (!errors.some(error => error.code === "unknown_dependency")) fail("dependency_cycle", "Circular dependencies in commit plan."); break; }
    const group = pending.splice(index, 1)[0]!;
    done.add(group.id); orderedGroups.push(group);
  }
  return { valid: errors.length === 0, errors, orderedGroups: errors.length ? [] : orderedGroups };
}
