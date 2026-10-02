import { describe, expect, test } from "bun:test";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { createModelAdapter } from "../../src/plan/model.js";

const model: Model<Api> = { id: "test", name: "Test", provider: "mock", api: "openai-completions", baseUrl: "http://unused.invalid", input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 };
function result(extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text: "{}" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now(), ...extra };
}
function registry(response: AssistantMessage | Error) {
  const requests: { model: Model<Api>; context: Context; options?: ModelsSimpleStreamOptions }[] = [];
  const host: Pick<ModelRegistry, "streamSimple"> = { streamSimple(model, context, options) {
    requests.push({ model, context, options });
    if (response instanceof Error) throw response;
    const stream = createAssistantMessageEventStream(); stream.end(response); return stream;
  } };
  return { host, requests };
}

describe("installed pi 1.0 public model-registry adapter", () => {
  test("dispatches via authenticated host registry with signal and transcript", async () => {
    const { host, requests } = registry(result()); const signal = new AbortController().signal;
    const adapter = createModelAdapter(model, host);
    expect(await adapter.complete([{ role: "system", content: "Rules" }, { role: "user", content: "Evidence" }, { role: "assistant", content: "Bad proposal" }, { role: "user", content: "Retry" }], undefined, { signal })).toEqual({ text: "{}", toolCalls: [] });
    expect(requests[0]!.model).toBe(model);
    expect(requests[0]!.options?.signal).toBe(signal);
    expect(requests[0]!.context.messages.map(message => message.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(requests[0]!.options).not.toHaveProperty("apiKey");
  });
  test("pi-ai tool definitions mapped to leading system declarations; output mapped", async () => {
    const { host, requests } = registry(result({ content: [{ type: "text", text: "Proposal" }, { type: "toolCall", id: "t1", name: "propose_commit", arguments: { groups: [] } }] }));
    const adapter = createModelAdapter(model, host);
    const response = await adapter.complete([{ role: "user", content: "Evidence" }], [{ name: "propose_commit", description: "Propose", parameters: { type: "object", properties: { groups: { type: "array" } }, required: ["groups"] } }]);
    expect(requests[0]!.context.messages[0]!.role).toBe("system");
    expect(response.toolCalls).toEqual([{ id: "t1", name: "propose_commit", arguments: { groups: [] } }]);
  });
  test("provider exception and error response never echo credential-bearing payload", async () => {
    for (const failure of [new Error("Authorization: secret-api-key"), result({ stopReason: "error", errorMessage: "secret-api-key" })]) {
      const { host } = registry(failure);
      try { await createModelAdapter(model, host).complete([{ role: "user", content: "Evidence" }]); throw new Error("Expected rejection"); }
      catch (error) { expect(String(error)).toContain("model request failed"); expect(String(error)).not.toContain("secret-api-key"); }
    }
  });
  test("aborted, incomplete/deferred and overlength responses are clear failures", async () => {
    for (const reason of ["aborted", "length", "deferred", "pending"] as const) {
      const { host } = registry(result({ stopReason: reason }));
      await expect(createModelAdapter(model, host).complete([{ role: "user", content: "Evidence" }])).rejects.toThrow();
    }
  });
  test("strict JSON adapter explicitly rejects unsupported tool-result history", async () => {
    const { host, requests } = registry(result());
    await expect(createModelAdapter(model, host).complete([{ role: "tool", content: "Result", name: "x", toolCallId: "t" }])).rejects.toThrow("unsupported");
    expect(requests).toHaveLength(0);
  });
});
