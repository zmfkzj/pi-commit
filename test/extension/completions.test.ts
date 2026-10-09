import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import commitExtension from "../../src/index.js";
import { parseCommitArgs } from "../../src/command/args.js";
import { COMMIT_OPTIONS, completeCommitArguments } from "../../src/command/completions.js";

const values = (prefix: string) => completeCommitArguments(prefix)?.map(item => item.value) ?? null;
const allFlags = COMMIT_OPTIONS.map(option => option.flag);

function load() {
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const sent: unknown[] = [];
  const api: Pick<ExtensionAPI, "registerCommand" | "registerMessageRenderer" | "sendMessage"> = {
    registerCommand: (name, definition) => { commands.set(name, definition); },
    registerMessageRenderer: () => {},
    sendMessage: (message: unknown) => { sent.push(message); },
  };
  commitExtension(api as ExtensionAPI);
  return { command: commands.get("commit")!, sent };
}

describe("/commit argument completions", () => {
  test("offers every option on empty input, without duplicates", () => {
    const all = values("")!;
    expect(all).toEqual(COMMIT_OPTIONS.map(option => option.flag + (option.takesValue ? " " : "")));
    expect(new Set(all).size).toBe(all.length);
  });

  test("completes the option being typed and keeps the text before it", () => {
    expect(values("--d")).toEqual(["--dry-run"]);
    expect(values("--dry-run --h")).toEqual(["--dry-run --help"]);
    expect(values("--m")).toEqual(["--model "]);
    expect(values('--context "fix --push" --p')).toEqual(['--context "fix --push" --push']);
    expect(values("  --y")).toEqual(["  --yes"]);
  });

  test("does not offer options already given, including --opt=value forms", () => {
    const rest = values("--dry-run --push ")!;
    expect(rest).not.toContain("--dry-run --push --dry-run");
    expect(rest).not.toContain("--dry-run --push --push");
    expect(rest).toHaveLength(allFlags.length - 2);
    expect(values("--model=openai/gpt --m")).toBeNull();
    expect(values('--context="x y" --model a/b --')).toEqual(["--dry-run", "--no-changelog", "--push", "--yes", "--help"].map(flag => `--context="x y" --model a/b ${flag}`));
  });

  test("offers nothing while a value, a quote or an escape is typed, or for non-options", () => {
    expect(values("--model ")).toBeNull();
    expect(values("--context ")).toBeNull();
    expect(values("--model op")).toBeNull();
    expect(values("--model=op")).toBeNull();
    expect(values('--context "fix --p')).toBeNull();
    expect(values("--context 'unclosed")).toBeNull();
    expect(values("--dry-run \\")).toBeNull();
    expect(values("foo")).toBeNull();
    expect(values("--zzz")).toBeNull();
  });

  test("a lone exact match is dropped so Enter submits", () => {
    expect(values("--push")).toBeNull();
    expect(values("--dry-run --help")).toBeNull();
  });

  test("every candidate parses once its value (if any) is supplied", () => {
    for (const option of COMMIT_OPTIONS) {
      const value = completeCommitArguments(`--${option.flag.slice(2, 4)}`)!.find(item => item.value.trim() === option.flag)!.value;
      expect(() => parseCommitArgs(option.takesValue ? `${value}openai/gpt-5` : value)).not.toThrow();
    }
  });

  test("is wired to the registered command and works through Pi's autocomplete provider", async () => {
    const { command, sent } = load();
    expect(command.getArgumentCompletions).toBe(completeCommitArguments);
    const provider = new CombinedAutocompleteProvider([{ name: "commit", description: command.description, getArgumentCompletions: command.getArgumentCompletions }], process.cwd());
    const signal = new AbortController().signal;
    const names = await provider.getSuggestions(["/comm"], 0, 5, { signal });
    expect(names?.items.map(item => item.value)).toEqual(["commit"]);
    const line = "/commit --dry-run --h";
    const suggestions = (await provider.getSuggestions([line], 0, line.length, { signal }))!;
    expect(suggestions.items.map(item => item.value)).toEqual(["--dry-run --help"]);
    const applied = provider.applyCompletion([line], 0, line.length, suggestions.items[0]!, suggestions.prefix).lines[0]!;
    expect(applied).toBe("/commit --dry-run --help");
    // The completed line runs: --help only prints usage (no git work).
    await command.handler(applied.slice("/commit ".length), { mode: "tui", hasUI: true, ui: { notify() {} } } as never);
    expect(JSON.stringify(sent)).toContain("--dry-run");
  });
});
