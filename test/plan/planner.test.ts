import { describe, expect, test } from "bun:test";
import type { ModelAdapter, ModelMessage, ModelResponse } from "../../src/types.js";
import { planCommits } from "../../src/plan/planner.js";
import { group, plan, snapshot } from "./fixtures.js";

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
    expect(input.git_file_diff["src/a.ts"]).toContain("+new");
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
  test("invalid limits and empty/oversized snapshot rejected before model calls", async () => {
    const { adapter, calls } = mock([valid()]);
    await expect(planCommits(snapshot(), adapter, { maxAttempts: 0 })).rejects.toThrow("maxAttempts");
    await expect(planCommits(snapshot(), adapter, { timeoutMs: 0 })).rejects.toThrow("timeoutMs");
    await expect(planCommits(snapshot([]), adapter)).rejects.toThrow("No changes");
    const huge = snapshot(); huge.diffByFile["src/a.ts"] = "x".repeat(1_000_001);
    await expect(planCommits(huge, adapter)).rejects.toThrow("evidence limit");
    expect(calls).toHaveLength(0);
  });
});
