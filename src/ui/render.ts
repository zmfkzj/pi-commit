import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

/** Custom message type used by `pi.sendMessage` for every /commit output. */
export const COMMIT_MESSAGE_TYPE = "pi-commit";

/** Plain text of a custom message; content is a string or a text/image part array. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * Plain-text renderer for /commit output. The default custom-message renderer parses `content` as
 * Markdown, and marked's regexes overflow the stack on large diffs without blank lines, which
 * crashes the TUI. `Text` only wraps lines, so arbitrary preview content is always safe.
 */
export const renderCommitMessage: MessageRenderer<{ level?: string } | undefined> = (message, { outputPad }, theme) => {
  const level = message.details?.level;
  const color = level === "error" ? "error" : level === "warning" ? "warning" : "customMessageText";
  const box = new Box(outputPad, 1, text => theme.bg("customMessageBg", text));
  box.addChild(new Text(theme.fg(color, messageText(message.content)), 0, 0));
  return box;
};
