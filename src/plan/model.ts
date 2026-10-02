import type { Api, AssistantMessage, Context, Message, Model, Tool, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelAdapter, ModelMessage, ModelTool } from "../types.ts";

const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Public pi 1.0 adapter. The registry owns request-time API-key/OAuth/header
 * resolution and custom-provider dispatch. Credentials never enter our messages,
 * errors, logs or state. Provider error payloads are intentionally not echoed. */
export function createModelAdapter(model: Model<Api>, registry: Pick<ModelRegistry, "streamSimple">): ModelAdapter {
  return {
    async complete(messages: ModelMessage[], tools?: ModelTool[], options?: { signal?: AbortSignal }) {
      options?.signal?.throwIfAborted();
      const transcript: Message[] = messages.map((message): Message => {
        const timestamp = Date.now();
        switch (message.role) {
          case "system": return { role: "system", content: message.content, timestamp };
          case "user": return { role: "user", content: message.content, timestamp };
          case "assistant": return { role: "assistant", content: [{ type: "text", text: message.content }], api: model.api, provider: model.provider, model: model.id, usage: ZERO_USAGE, stopReason: "stop", timestamp };
          case "tool": throw new Error("This adapter uses strict-JSON planning; tool-result transcripts are unsupported.");
        }
      });
      const context: Context = { messages: transcript };
      if (tools?.length) {
        if (transcript[0]?.role !== "system") transcript.unshift({ role: "system", content: "", timestamp: Date.now() });
        if (transcript[0]?.role === "system") transcript[0].toolsAdded = tools.map(tool => ({ ...tool, parameters: tool.parameters as Tool["parameters"] }));
      }
      let result: AssistantMessage;
      try {
        result = await registry.streamSimple(model, context, { signal: options?.signal, maxTokens: 8192 }).result();
      } catch {
        if (options?.signal?.aborted) throw new Error("Commit planning cancelled or timed out.");
        throw new Error(`Commit planning model request failed (${model.provider}/${model.id}); check provider configuration.`);
      }
      if (result.stopReason === "aborted" || options?.signal?.aborted) throw new Error("Commit planning cancelled or timed out.");
      if (result.stopReason === "error") throw new Error(`Commit planning model request failed (${model.provider}/${model.id}); check provider configuration.`);
      if (result.stopReason === "length") throw new Error("Commit planning model output exceeded its token limit; reduce the change set.");
      if (result.stopReason === "deferred" || result.stopReason === "pending") throw new Error("Commit planning requires an immediate completed model response.");
      return {
        text: result.content.filter(block => block.type === "text").map(block => block.text).join("\n"),
        toolCalls: result.content.filter(block => block.type === "toolCall").map(block => ({ id: block.id, name: block.name, arguments: block.arguments })),
      };
    },
  };
}
