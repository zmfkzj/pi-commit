export interface CommitOptions {
  dryRun: boolean;
  model?: string;
  context?: string;
  noChangelog: boolean;
  push: boolean;
  yes: boolean;
  help: boolean;
}

export const HELP = `/commit [--dry-run] [--model provider/id] [--context "instructions"] [--no-changelog] [--push] [--yes]
Preview a single or hunk-split commit plan, then confirm (or skip the dialog with --yes).
--dry-run       Preview only; never change index, files, history or remote.
--model         Exact registered provider/id; otherwise use the current pi model.
--context       Additional planning instructions (quote multi-word values).
--no-changelog  Do not generate a changelog (existing edits remain in the plan).
--push          Push only after every planned commit succeeds; never force push.
--yes           Skip the confirmation dialog and execute right after the full preview (all modes); --dry-run still never writes.
--help          Show this help. Without --yes, interactive/RPC modes ask for confirmation and print/JSON modes refuse to write.`;

/** Shell-like quoting for slash-command arguments; no shell is ever evaluated. */
export function tokenizeArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "", quote: "'" | '"' | undefined, started = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && ["\\", '"'].includes(input[i + 1] ?? "")) current += input[++i];
      else current += char;
      started = true;
    } else if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) {
      if (started) { tokens.push(current); current = ""; started = false; }
    } else if (char === "\\") {
      if (i + 1 === input.length) throw new Error("Trailing escape in /commit arguments.");
      current += input[++i]; started = true;
    } else { current += char; started = true; }
  }
  if (quote) throw new Error("Unclosed quote in /commit arguments.");
  if (started) tokens.push(current);
  return tokens;
}

export function parseCommitArgs(input: string): CommitOptions {
  const options: CommitOptions = { dryRun: false, noChangelog: false, push: false, yes: false, help: false };
  const seen = new Set<string>(), args = tokenizeArgs(input);
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!, equal = raw.indexOf("="), flag = equal < 0 ? raw : raw.slice(0, equal);
    if (seen.has(flag)) throw new Error(`Duplicate /commit option: ${flag}`);
    seen.add(flag);
    if (["--model", "--context"].includes(flag)) {
      const value = equal >= 0 ? raw.slice(equal + 1) : args[++i];
      if (!value?.trim() || value.startsWith("--")) throw new Error(`${flag} requires a nonempty value.`);
      if (flag === "--model") {
        if (!/^[^/\s]+\/\S+$/.test(value)) throw new Error("--model must be an exact provider/id.");
        options.model = value;
      } else options.context = value;
      continue;
    }
    if (equal >= 0) throw new Error(`Unknown /commit option: ${raw}`);
    switch (flag) {
      case "--dry-run": options.dryRun = true; break;
      case "--no-changelog": options.noChangelog = true; break;
      case "--push": options.push = true; break;
      case "--yes": options.yes = true; break;
      case "--help": options.help = true; break;
      default: throw new Error(`Unknown /commit option: ${raw}. Use /commit --help.`);
    }
  }
  return options;
}
