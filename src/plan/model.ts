import type { Api, AssistantMessage, Context, Message, Model, Tool, Usage } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ModelAdapter, ModelMessage, ModelTool } from "../types.ts";
import { EVIDENCE_LIMIT_BYTES } from "./planner.js";

const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** Plans for hundreds of files need more than 8192 output tokens (one selector per file); never above the model's own maximum
 * unless that is below the historical 8192 floor. */
const PLAN_OUTPUT_TOKENS_MIN = 8_192, PLAN_OUTPUT_TOKENS_MAX = 32_768;
export function planOutputTokens(model: Pick<Model<Api>, "maxTokens">): number {
  const limit = Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : PLAN_OUTPUT_TOKENS_MIN;
  return Math.max(PLAN_OUTPUT_TOKENS_MIN, Math.min(limit, PLAN_OUTPUT_TOKENS_MAX));
}

/** UTF-8 bytes per token assumed when sizing evidence to a context window (typical for code/JSON); system prompt and bounded retry feedback reserve. */
const BYTES_PER_TOKEN = 4, PROMPT_RESERVE_TOKENS = 8_192, MIN_EVIDENCE_BUDGET_BYTES = 64_000;
/**
 * Evidence budget for a model: the 1 MB ceiling, lowered when the context window cannot also hold every attempt's
 * worst-case response (retries resend earlier responses). Never below 64 KB so ordinary small change sets plan as before.
 */
export function planEvidenceBudgetBytes(model: Pick<Model<Api>, "contextWindow" | "maxTokens">, maxAttempts = 3): number {
  if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return EVIDENCE_LIMIT_BYTES;
  const tokens = model.contextWindow - maxAttempts * planOutputTokens(model) - PROMPT_RESERVE_TOKENS;
  return Math.max(MIN_EVIDENCE_BUDGET_BYTES, Math.min(EVIDENCE_LIMIT_BYTES, Math.floor(tokens * BYTES_PER_TOKEN)));
}

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
        result = await registry.streamSimple(model, context, { signal: options?.signal, maxTokens: planOutputTokens(model) }).result();
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
