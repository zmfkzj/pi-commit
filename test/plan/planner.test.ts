import { describe, expect, test } from "bun:test";
import type { FileChange, ModelAdapter, ModelMessage, ModelResponse, RepoSnapshot } from "../../src/types.js";
import { planCommits, type EvidenceReport } from "../../src/plan/planner.js";
import { parseHunks } from "../../src/git/snapshot.js";
import { file, group, plan, snapshot } from "./fixtures.js";

function mock(responses: (ModelResponse | Error)[]): { adapter: ModelAdapter; calls: ModelMessage[][] } {
  const calls: ModelMessage[][] = [];
  return { calls, adapter: { async complete(messages) { calls.push(structuredClone(messages)); const result = responses.shift(); if (result instanceof Error) throw result; if (!result) throw new Error("Mock exhausted"); return result; } } };
}
const valid = (): ModelResponse => ({ text: JSON.stringify(plan()) });

describe("bounded model-backed strict JSON planner", () => {
  test("valid single and split plans", async () => {
    const single = mock([valid()]);
    expect(await planCommits(snapshot(), single.adapter)).toEqual(plan());
    const splitPlan = plan([group("g2", "src/a.ts", ["src/a.ts#2"], ["g1"]), group("g1", "src/a.ts", ["src/a.ts#1"])]);
    const split = mock([{ text: JSON.stringify(splitPlan) }]);
    expect((await planCommits(snapshot(), split.adapter)).groups.map(group => group.id)).toEqual(["g1", "g2"]);
  });
  test("malformed JSON then retry success with validation feedback", async () => {
    const { adapter, calls } = mock([{ text: "```json\n{}\n```" }, valid()]);
    expect((await planCommits(snapshot(), adapter)).groups).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.at(-1)!.content).toContain("Malformed strict JSON");
  });
  test("incomplete plan rejected and retried", async () => {
    const { adapter, calls } = mock([{ text: JSON.stringify(plan([group("g1", "src/a.ts", ["src/a.ts#1"])])) }, valid()]);
    await planCommits(snapshot(), adapter);
    expect(calls[1]!.at(-1)!.content).toContain("missing_coverage");
  });
  test("malformed tool output then retry success", async () => {
    const { adapter } = mock([{ text: "", toolCalls: [{ id: "bad", name: "git_write", arguments: {} }] }, valid()]);
    expect(await planCommits(snapshot(), adapter)).toEqual(plan());
  });
  test("final structured tool proposal strictly validated", async () => {
    const { adapter } = mock([{ text: "", toolCalls: [{ id: "ok", name: "propose_commit", arguments: plan() }] }]);
    expect(await planCommits(snapshot(), adapter)).toEqual(plan());
  });
  test("retry exhaustion errors, never manufactures fallback", async () => {
    const { adapter, calls } = mock([{ text: "bad" }, { text: "bad" }, { text: "bad" }]);
    await expect(planCommits(snapshot(), adapter)).rejects.toThrow("failed after 3 attempts");
    expect(calls).toHaveLength(3);
  });
  test("model exception immediate failure, sensitive exception not echoed", async () => {
    const { adapter, calls } = mock([new Error("secret-api-key"), valid()]);
    await expect(planCommits(snapshot(), adapter)).rejects.toThrow("model request failed");
    expect(calls).toHaveLength(1);
  });
  test("user context, diffs and recent commits included in read-only evidence", async () => {
    const { adapter, calls } = mock([valid()]);
    await planCommits(snapshot(), adapter, { context: "fix issue 42", recentCommits: ["fix: old style"] });
    const input = JSON.parse(calls[0]![1]!.content);
    expect(input.user_context).toBe("fix issue 42");
    expect(input.git_overview.files[0].hunks[0].id).toBe("src/a.ts#1");
    expect(input.git_hunk[0].path).toBe("src/a.ts");
    expect(input.git_hunk[0].hunks[0].lines).toContain("+new");
    expect(input.git_file_diff["src/a.ts"]).toContain("hunk-splittable");
    expect(input.recent_commits).toEqual(["fix: old style"]);
  });
  test("no model-controlled changelog file writes", async () => {
    const { adapter, calls } = mock([{ text: JSON.stringify({ ...plan(), changelog: { file: "CHANGELOG.md", newContent: "invented", originalContent: null } }) }, valid()]);
    await planCommits(snapshot(), adapter);
    expect(calls[1]!.at(-1)!.content).toContain("never file writes");
  });
  test("no-changelog removes proposed entries", async () => {
    const { adapter } = mock([{ text: JSON.stringify(plan([{ ...group(), changelogEntry: "Fixed parser" }])) }]);
    expect((await planCommits(snapshot(), adapter, { noChangelog: true })).groups[0]!.changelogEntry).toBeUndefined();
  });
  test("already-aborted signal performs no model call", async () => {
    const controller = new AbortController(); controller.abort();
    const { adapter, calls } = mock([valid()]);
    await expect(planCommits(snapshot(), adapter, { signal: controller.signal })).rejects.toThrow("cancelled or timed out");
    expect(calls).toHaveLength(0);
  });
  test("deadline enforced even if a model ignores cancellation", async () => {
    const adapter: ModelAdapter = { complete: () => new Promise(() => {}) };
    await expect(planCommits(snapshot(), adapter, { timeoutMs: 10 })).rejects.toThrow("cancelled or timed out");
  });
  test("caller abort during completion terminates promptly", async () => {
    const controller = new AbortController();
    const adapter: ModelAdapter = { complete: () => new Promise(() => {}) };
    const pending = planCommits(snapshot(), adapter, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled or timed out");
  });
  test("invalid limits and empty snapshot rejected before model calls", async () => {
    const { adapter, calls } = mock([valid()]);
    await expect(planCommits(snapshot(), adapter, { maxAttempts: 0 })).rejects.toThrow("maxAttempts");
    await expect(planCommits(snapshot(), adapter, { timeoutMs: 0 })).rejects.toThrow("timeoutMs");
    for (const evidenceBudgetBytes of [0, 1.5, 1_000_001, Number.NaN]) await expect(planCommits(snapshot(), adapter, { evidenceBudgetBytes })).rejects.toThrow("evidenceBudgetBytes");
    await expect(planCommits(snapshot([]), adapter)).rejects.toThrow("No changes");
    expect(calls).toHaveLength(0);
  });
  test("hunk-splittable content is sent once, in git_hunk, with only the diff header in git_file_diff", async () => {
    const a = file("src/a.ts");
    const snap = snapshot([a]);
    snap.diffByFile["src/a.ts"] = "diff --git a/src/a.ts b/src/a.ts\nindex 1..2 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -10,1 +10,1 @@\n-old-unique-line\n+new-unique-line\n";
    a.hunks[0]!.lines = ["-old-unique-line", "+new-unique-line"];
    const { adapter, calls } = mock([valid()]);
    await planCommits(snap, adapter);
    const content = calls[0]![1]!.content;
    expect(content.split("new-unique-line")).toHaveLength(2); // exactly one occurrence overall
    const input = JSON.parse(content);
    expect(input.git_hunk[0].hunks[0].lines).toEqual(["-old-unique-line", "+new-unique-line"]);
    expect(input.git_file_diff["src/a.ts"]).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(input.git_file_diff["src/a.ts"]).toContain("[hunk-splittable: content in git_hunk]");
    expect(input.git_file_diff["src/a.ts"]).not.toContain("@@");
    expect(input.git_file_diff["src/a.ts"]).not.toContain("unique-line");
    expect(snap.diffByFile["src/a.ts"]).toContain("+new-unique-line"); // previews/execution keep the full diff
  });
  test("large whole-file-only diffs are truncated with a marker; small ones stay complete", async () => {
    const big = file("src/big.ts", { status: "added", hunkSplittable: false, hunks: [] });
    const small = file("src/small.ts", { status: "added", hunkSplittable: false, hunks: [] });
    const snap = snapshot([big, small]);
    const bigLines = Array.from({ length: 500 }, (_, index) => `+line-${index}`);
    const bigDiff = `diff --git a/src/big.ts b/src/big.ts\nnew file mode 100644\n@@ -0,0 +1,500 @@\n${bigLines.join("\n")}\n`;
    const smallDiff = "diff --git a/src/small.ts b/src/small.ts\nnew file mode 100644\n@@ -0,0 +1,2 @@\n+one\n+two\n";
    snap.diffByFile["src/big.ts"] = bigDiff;
    snap.diffByFile["src/small.ts"] = smallDiff;
    const wholeFilePlan = plan([group("g1", "src/big.ts"), group("g2", "src/small.ts")]);
    const { adapter, calls } = mock([{ text: JSON.stringify(wholeFilePlan) }]);
    expect(await planCommits(snap, adapter)).toEqual(wholeFilePlan);
    const input = JSON.parse(calls[0]![1]!.content);
    const shown: string = input.git_file_diff["src/big.ts"];
    expect(shown).toContain("+line-0");
    expect(shown).not.toContain("+line-499");
    expect(shown).toContain(`[whole-file-only: truncated, showing first 80 of 503 lines, ${Buffer.byteLength(bigDiff, "utf8")} bytes total; must be selected with hunks:"all"]`);
    expect(input.git_file_diff["src/small.ts"]).toBe(smallDiff);
    expect(input.git_hunk).toEqual([]);
    expect(snap.diffByFile["src/big.ts"]).toBe(bigDiff); // execution/preview data is untouched
  });
  test("whole-file-only diff with very long lines is bounded by bytes", async () => {
    const minified = file("dist/app.min.js", { status: "added", hunkSplittable: false, hunks: [] });
    const snap = snapshot([minified]);
    snap.diffByFile["dist/app.min.js"] = `diff --git a/dist/app.min.js b/dist/app.min.js\n+${"y".repeat(200_000)}\n`;
    const { adapter, calls } = mock([{ text: JSON.stringify(plan([group("g1", "dist/app.min.js")])) }]);
    await planCommits(snap, adapter);
    const shown: string = JSON.parse(calls[0]![1]!.content).git_file_diff["dist/app.min.js"];
    expect(Buffer.byteLength(shown, "utf8")).toBeLessThan(9_000);
    expect(shown).toContain("[whole-file-only: truncated, showing first 2 of 2 lines,");
  });
  test("whole-file-only truncation is bounded in UTF-8 bytes and cuts only at code-point boundaries", async () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    const cases: [string, string][] = [["hangul", "가".repeat(20_000)], ["emoji", "😀".repeat(5_000)], ["cjk-2byte-mix", "é語😀".repeat(4_000)]];
    for (const [name, text] of cases) {
      for (const shift of [0, 1, 2, 3]) { // vary alignment so the byte budget lands inside every position of a multi-byte sequence
        const path = `src/${name}-${shift}.txt`;
        const wide = file(path, { status: "added", hunkSplittable: false, hunks: [] });
        const snap = snapshot([wide]);
        const fullDiff = `diff --git a/${path} b/${path}\n+${"a".repeat(shift)}${text}\n`;
        snap.diffByFile[path] = fullDiff;
        const { adapter, calls } = mock([{ text: JSON.stringify(plan([group("g1", path)])) }]);
        await planCommits(snap, adapter);
        const shown: string = JSON.parse(calls[0]![1]!.content).git_file_diff[path];
        const marker = shown.indexOf("\n[whole-file-only: truncated");
        expect(marker).toBeGreaterThan(0);
        const head = shown.slice(0, marker + 1); // everything before the marker text, including its separating newline
        expect(Buffer.byteLength(head, "utf8")).toBeLessThanOrEqual(8 * 1024);
        expect(Buffer.byteLength(head, "utf8")).toBeGreaterThan(8 * 1024 - 4); // not over-truncated: at most one code point of slack
        expect(shown).not.toContain("\uFFFD");
        expect(lone.test(shown)).toBe(false);
        expect(shown).toContain(`[whole-file-only: truncated, showing first 2 of 2 lines, ${Buffer.byteLength(fullDiff, "utf8")} bytes total;`);
        expect(snap.diffByFile[path]).toBe(fullDiff);
      }
    }
  });
  test("binary and lockfile placeholders are preserved", async () => {
    const bin = file("img.png", { status: "added", binary: true, hunkSplittable: false, hunks: [] });
    const lock = file("bun.lock", { isLockfile: true });
    const { adapter, calls } = mock([{ text: JSON.stringify(plan([group("g1", "img.png"), group("g2", "bun.lock")])) }]);
    await planCommits(snapshot([bin, lock]), adapter);
    const input = JSON.parse(calls[0]![1]!.content);
    expect(input.git_file_diff["img.png"]).toBe("[machine-generated/binary: whole-file selection only]");
    expect(input.git_file_diff["bun.lock"]).toBe("[machine-generated/binary: whole-file selection only]");
    expect(input.git_hunk).toEqual([]);
  });
  test("evidence limit error (metadata alone over budget) lists the largest files without leaking content", async () => {
    const sizes: [string, number][] = [["src/f1.ts", 300_000], ["src/f2.ts", 250_000], ["src/f3.ts", 200_000], ["src/f4.ts", 150_000], ["src/f5.ts", 100_000], ["src/tiny.ts", 50_000]];
    const files = sizes.map(([path, size]) => {
      const change = file(path); change.hunks = [{ ...change.hunks[0]!, lines: [`+secret-${"z".repeat(size)}`] }];
      return change;
    });
    const { adapter, calls } = mock([valid()]);
    const error = await planCommits(snapshot(files.reverse()), adapter, { evidenceBudgetBytes: 500 }).then(() => undefined, (caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = error!.message;
    expect(message).toContain("evidence limit");
    const order = ["src/f1.ts", "src/f2.ts", "src/f3.ts", "src/f4.ts", "src/f5.ts"].map(path => message.indexOf(path));
    expect(order.every(index => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(message).toMatch(/src\/f1\.ts \(~\d+ KB\)/);
    expect(message).not.toContain("src/tiny.ts");
    expect(message).toContain("and 1 more");
    expect(message).toContain("git add");
    expect(message).toContain(".gitignore");
    expect(message).not.toContain("secret");
    expect(message).not.toContain("zzzz");
    expect(calls).toHaveLength(0);
  });
});

/** A replay of the reported orche shape: 456 new untracked files plus 21 modified files (~2.6 MB of normal evidence). */
function largeChangeSet(newFiles = 456, modified = 21): RepoSnapshot {
  const files: FileChange[] = [], diffByFile: Record<string, string> = {};
  for (let i = 0; i < newFiles; i++) {
    const path = `fixtures/advisor-bench/case-${String(i).padStart(3, "0")}/witness.json`;
    const body = Array.from({ length: 75 }, (_, line) => `+  "line-${line}": "value ${i}-${line} \\"quoted\\" 가나다",`).join("\n");
    const diff = `diff --git a/${path} b/${path}\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,75 @@\n${body}\n`;
    diffByFile[path] = diff;
    files.push({ path, status: "added", binary: false, isLockfile: false, untracked: true, origin: "unstaged", hunkSplittable: false, hunks: parseHunks(path, diff) });
  }
  for (let i = 0; i < modified; i++) {
    const path = `src/module-${i}.ts`;
    const change = file(path);
    change.hunks = Array.from({ length: 6 }, (_, n) => ({ ...change.hunks[0]!, id: `${path}#${n + 1}`, header: `@@ -${n * 100},20 +${n * 100},20 @@ function f${n}()`, lines: Array.from({ length: 30 }, (_, line) => `${line % 2 ? "+" : "-"}  const value${line} = compute(${n}, ${line}); // tab\t"q"`) }));
    diffByFile[path] = `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n${change.hunks.map(hunk => [hunk.header, ...hunk.lines].join("\n")).join("\n")}\n`;
    files.push(change);
  }
  return { files, mode: "worktree", headOid: "abc", fingerprint: "hash", diffByFile };
}
/** A deterministic model that plans from the evidence it was shown: one group per modified file, one for all new files. */
function evidenceModel(): { adapter: ModelAdapter; calls: ModelMessage[][] } {
  const calls: ModelMessage[][] = [];
  return { calls, adapter: { async complete(messages) {
    calls.push(messages.map(message => ({ ...message })));
    const files = (JSON.parse(messages[1]!.content) as { git_overview: { files: { path: string; status: string }[] } }).git_overview.files;
    const added = files.filter(entry => entry.status === "added").map(entry => ({ path: entry.path, hunks: "all" }));
    const groups = files.filter(entry => entry.status === "modified").map((entry, index) => ({ id: `m${index}`, message: { subject: `Update ${entry.path}` }, selectors: [{ path: entry.path, hunks: "all" }], dependsOn: [] }));
    if (added.length) groups.push({ id: "fixtures", message: { subject: "Add fixtures" }, selectors: added, dependsOn: [] });
    return { text: JSON.stringify({ groups }) };
  } } };
}
const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("change sets above the 1 MB evidence budget are planned from condensed evidence", () => {
  test("reported shape (477 files, ~2.6 MB): one model call, every path and hunk ID listed, bounded and disclosed", async () => {
    const snap = largeChangeSet(), before = structuredClone(snap);
    const reports: EvidenceReport[] = [];
    const { adapter, calls } = evidenceModel();
    const result = await planCommits(snap, adapter, { onEvidence: report => reports.push(report) });
    expect(calls).toHaveLength(1);
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report.fullBytes).toBeGreaterThan(2_400_000);
    expect(report).toMatchObject({ condensed: true, budgetBytes: 1_000_000, files: 477, hunks: 456 + 21 * 6 });
    expect(report.sentBytes).toBeLessThanOrEqual(1_000_000);
    expect(report.sentBytes).toBeGreaterThan(900_000); // the budget is used, not wasted
    expect(report.truncatedItems).toBeGreaterThan(0);
    const content = calls[0]![1]!.content;
    expect(Buffer.byteLength(content, "utf8")).toBe(report.sentBytes);
    const input = JSON.parse(content);
    expect(input.git_overview.files.map((entry: { path: string }) => entry.path)).toEqual(snap.files.map(entry => entry.path));
    expect(input.git_overview.files.flatMap((entry: { hunks: { id: string }[] }) => entry.hunks.map(hunk => hunk.id))).toEqual(snap.files.flatMap(entry => entry.hunks.map(hunk => hunk.id)));
    expect(Object.keys(input.git_file_diff)).toEqual(snap.files.map(entry => entry.path));
    expect(input.git_hunk.flatMap((entry: { hunks: { id: string }[] }) => entry.hunks.map(hunk => hunk.id))).toHaveLength(21 * 6);
    expect(input.git_file_diff["fixtures/advisor-bench/case-000/witness.json"]).toContain("[whole-file-only: truncated");
    expect(calls[0]![0]!.content).toContain("CONDENSED");
    expect(calls[0]![0]!.content).toContain(`about ${report.contentCapBytes} bytes`);
    expect(content).not.toContain("\uFFFD");
    expect(lone.test(content)).toBe(false);
    expect(result.groups).toHaveLength(22);
    expect(result.groups.flatMap(group => group.selectors.map(selector => selector.path)).sort()).toEqual(snap.files.map(entry => entry.path).sort());
    expect(snap).toEqual(before); // execution data (full diffs and hunks) is never mutated
  });
  test("normal evidence: exactly at the budget is sent unchanged; one byte over is condensed", async () => {
    const sized = (padding: number) => { const snap = snapshot(); snap.files[0]!.hunks[0]!.lines = [`+${"x".repeat(padding)}`]; return snap; };
    const measure = async (snap: RepoSnapshot) => { const reports: EvidenceReport[] = []; const { adapter, calls } = mock([valid()]); await planCommits(snap, adapter, { onEvidence: report => reports.push(report) }); return { report: reports[0]!, calls }; };
    const probe = (await measure(sized(500_000))).report.fullBytes;
    const exact = await measure(sized(500_000 + 1_000_000 - probe));
    expect(exact.report).toMatchObject({ condensed: false, fullBytes: 1_000_000, sentBytes: 1_000_000, truncatedItems: 0 });
    expect(exact.report.contentCapBytes).toBeUndefined();
    expect(exact.calls[0]![0]!.content).not.toContain("CONDENSED");
    expect(JSON.parse(exact.calls[0]![1]!.content).git_hunk[0].hunks[0]).not.toHaveProperty("truncated");
    const over = await measure(sized(500_000 + 1_000_001 - probe));
    expect(over.report).toMatchObject({ condensed: true, fullBytes: 1_000_001, truncatedItems: 1 });
    expect(over.report.sentBytes).toBeLessThanOrEqual(1_000_000);
    const hunk = JSON.parse(over.calls[0]![1]!.content).git_hunk[0].hunks[0];
    expect(hunk.truncated).toEqual({ totalLines: 1, totalBytes: 500_000 + 1_000_001 - probe + 2 });
    expect(over.calls[0]![0]!.content).toContain("CONDENSED");
  });
  test("one enormous multi-byte/escaped line is cut at a code-point boundary and stays within budget", async () => {
    const snap = snapshot();
    snap.files[0]!.hunks[0]!.lines = [`+${"가\"\\😀é\n".repeat(250_000)}`];
    const reports: EvidenceReport[] = [];
    const { adapter, calls } = mock([valid()]);
    expect(await planCommits(snap, adapter, { onEvidence: report => reports.push(report) })).toEqual(plan());
    const content = calls[0]![1]!.content;
    expect(Buffer.byteLength(content, "utf8")).toBeLessThanOrEqual(1_000_000);
    expect(reports[0]!.condensed).toBe(true);
    expect(content).not.toContain("\uFFFD");
    expect(lone.test(content)).toBe(false);
    const shown: string = JSON.parse(content).git_hunk[0].hunks[0].lines[0];
    expect(shown.startsWith("+가\"\\😀é")).toBe(true);
    expect(shown.length).toBeGreaterThan(1000);
  });
  test("metadata alone over the 1 MB budget (20,000 files) is rejected before any model call", async () => {
    const files = Array.from({ length: 20_000 }, (_, i) => file(`packages/generated/some-long-directory-name/file-${i}.ts`, { status: "added", hunkSplittable: false, hunks: [] }));
    const { adapter, calls } = mock([valid()]);
    await expect(planCommits(snapshot(files), adapter)).rejects.toThrow("even when condensed to paths, statuses and hunk headers (20000 files");
    expect(calls).toHaveLength(0);
  });
  test("oversized user context counts toward the budget and is never cut", async () => {
    const { adapter, calls } = mock([valid()]);
    await expect(planCommits(snapshot(), adapter, { context: "c".repeat(1_000_000) })).rejects.toThrow("evidence limit");
    expect(calls).toHaveLength(0);
  });
  test("a lowered model budget condenses earlier; staged mode is reported to the model unchanged", async () => {
    const snap = largeChangeSet(40, 2); snap.mode = "staged";
    for (const entry of snap.files) entry.origin = "staged";
    const reports: EvidenceReport[] = [];
    const { adapter, calls } = evidenceModel();
    await planCommits(snap, adapter, { evidenceBudgetBytes: 100_000, onEvidence: report => reports.push(report) });
    expect(reports[0]).toMatchObject({ condensed: true, budgetBytes: 100_000, files: 42 });
    expect(Buffer.byteLength(calls[0]![1]!.content, "utf8")).toBeLessThanOrEqual(100_000);
    expect(JSON.parse(calls[0]![1]!.content).git_overview.mode).toBe("staged");
  });
  test("condensed plans are still validated globally: omitted, duplicate and split lockfile selections are retried with bounded feedback", async () => {
    const snap = largeChangeSet();
    const manifest = file("package.json"), lock = file("package-lock.json", { isLockfile: true });
    snap.files.push(manifest, lock); snap.diffByFile["package.json"] = "diff"; snap.diffByFile["package-lock.json"] = "diff";
    const first = snap.files[0]!.path;
    const partial = plan([group("g1", first), group("g2", first)]); // duplicate, and ~480 files missing
    const splitLock = plan([...snap.files.filter(entry => entry.path !== "package-lock.json").map((entry, i) => group(`g${i}`, entry.path)), group("deps", "package-lock.json")]);
    const good = plan([{ ...group("all"), selectors: snap.files.map(entry => ({ path: entry.path, hunks: "all" as const })) }]);
    const { adapter, calls } = mock([{ text: JSON.stringify(partial) }, { text: JSON.stringify(splitLock) }, { text: JSON.stringify(good) }]);
    expect((await planCommits(snap, adapter)).groups).toHaveLength(1);
    expect(calls).toHaveLength(3);
    const feedback = calls[1]!.at(-1)!.content;
    expect(feedback).toContain("overlap");
    expect(feedback).toContain("more validation errors (missing_coverage");
    expect(feedback.length).toBeLessThan(8_300);
    expect(calls[2]!.at(-1)!.content).toContain("lockfile_group");
  });
  test("exhausted retries on a condensed set fail without a partial plan and with bounded feedback", async () => {
    const snap = largeChangeSet();
    const partial = { text: JSON.stringify(plan([group("g1", snap.files[0]!.path)])) };
    const { adapter, calls } = mock([partial, partial, partial]);
    const error = await planCommits(snap, adapter).then(() => undefined, (caught: Error) => caught);
    expect(error?.message).toContain("failed after 3 attempts");
    expect(error!.message.length).toBeLessThan(8_400);
    expect(calls).toHaveLength(3);
    expect(calls[2]!.reduce((total, message) => total + message.content.length, 0)).toBeLessThan(1_000_000 + 30_000);
  });
  test("cancellation and deadline still apply to a condensed plan", async () => {
    const never: ModelAdapter = { complete: () => new Promise(() => {}) };
    await expect(planCommits(largeChangeSet(), never, { timeoutMs: 50 })).rejects.toThrow("cancelled or timed out");
    const controller = new AbortController(); controller.abort();
    const { adapter, calls } = mock([valid()]);
    await expect(planCommits(largeChangeSet(), adapter, { signal: controller.signal })).rejects.toThrow("cancelled or timed out");
    expect(calls).toHaveLength(0);
  });
  test("small change sets keep the normal evidence and prompt", async () => {
    const reports: EvidenceReport[] = [];
    const { adapter, calls } = mock([valid()]);
    await planCommits(snapshot(), adapter, { onEvidence: report => reports.push(report) });
    expect(reports[0]).toMatchObject({ condensed: false, truncatedItems: 0, files: 1, hunks: 2 });
    expect(calls[0]![0]!.content).not.toContain("CONDENSED");
  });
});
