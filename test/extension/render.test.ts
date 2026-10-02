import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import commitExtension from "../../src/index.js";
import { messageText } from "../../src/ui/render.js";

type Renderer = MessageRenderer<unknown>;
type Theme = Parameters<Renderer>[2];
type Message = Parameters<Renderer>[0];

const identityTheme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text } as unknown as Theme;
const taggedTheme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bg: (_color: string, text: string) => text } as unknown as Theme;
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

function message(content: Message["content"], details?: unknown): Message {
  return { role: "custom", customType: "pi-commit", content, display: true, details, timestamp: 0 };
}

function load() {
  const renderers = new Map<string, Renderer>();
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const sent: unknown[] = [];
  const api: Pick<ExtensionAPI, "registerCommand" | "registerMessageRenderer" | "sendMessage"> = {
    registerCommand: (name, definition) => { commands.set(name, definition); },
    registerMessageRenderer: (type, renderer) => { renderers.set(type, renderer as Renderer); },
    sendMessage: (sentMessage: unknown) => { sent.push(sentMessage); },
  };
  commitExtension(api as ExtensionAPI);
  return { renderers, commands, sent };
}

describe("pi-commit message renderer", () => {
  test("extension registers /commit and a renderer for the pi-commit message type", () => {
    const { renderers, commands } = load();
    expect(commands.has("commit")).toBe(true);
    expect(renderers.get("pi-commit")).toBeFunction();
  });

  test("messages sent by /commit use the registered custom type", async () => {
    const { renderers, commands, sent } = load();
    const ctx = { mode: "tui", hasUI: true, ui: { notify() {} } } as never;
    await commands.get("commit")!.handler("--help", ctx);
    expect(sent).toHaveLength(1);
    expect(renderers.has((sent[0] as { customType: string }).customType)).toBe(true);
  });

  test("huge diff-like content renders as raw plain text without Markdown parsing", () => {
    const renderer = load().renderers.get("pi-commit")!;
    const lines = Array.from({ length: 5000 }, (_, i) => `+line ${i + 1}`);
    const component = renderer(message([...lines, "---"].join("\n"), { level: "info" }), { expanded: false, outputPad: 1 }, identityTheme)!;
    expect(component).toBeDefined();
    const rendered = component.render(80).map(strip);
    const text = rendered.join("\n");
    expect(rendered.length).toBeGreaterThan(5000);
    expect(text).toContain("+line 1");
    expect(text).toContain("+line 5000");
    // Markdown would turn the trailing "---" under a text line into a setext heading and strip the marker.
    expect(text).toContain("---");
  });

  test("renders Markdown syntax literally", () => {
    const renderer = load().renderers.get("pi-commit")!;
    const component = renderer(message("# heading\n**bold** `code`\n- item"), { expanded: false, outputPad: 0 }, identityTheme)!;
    const text = component.render(80).map(strip).join("\n");
    expect(text).toContain("# heading");
    expect(text).toContain("**bold** `code`");
    expect(text).toContain("- item");
  });

  test("joins text parts of array content and ignores non-text parts", () => {
    const renderer = load().renderers.get("pi-commit")!;
    const content = [{ type: "text", text: "first part" }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "second part" }] as Message["content"];
    const text = renderer(message(content), { expanded: false, outputPad: 0 }, identityTheme)!.render(80).map(strip).join("\n");
    expect(text).toContain("first part");
    expect(text).toContain("second part");
    expect(messageText(content)).toBe("first part\nsecond part");
    expect(messageText(undefined)).toBe("");
    expect(() => renderer(message(undefined as never), { expanded: false, outputPad: 0 }, identityTheme)!.render(80)).not.toThrow();
  });

  test("colors warning and error output by details.level", () => {
    const renderer = load().renderers.get("pi-commit")!;
    const render = (details?: unknown) => renderer(message("body", details), { expanded: false, outputPad: 0 }, taggedTheme)!.render(80).join("\n");
    expect(render({ level: "error" })).toContain("<error>body</error>");
    expect(render({ level: "warning" })).toContain("<warning>body</warning>");
    expect(render({ level: "info" })).toContain("<customMessageText>body</customMessageText>");
    expect(render(undefined)).toContain("<customMessageText>body</customMessageText>");
  });
});
