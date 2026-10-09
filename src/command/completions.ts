/**
 * Argument completions for `/commit`. Pi passes everything after `/commit ` and replaces it with the chosen value, so each candidate keeps
 * the text before the option being typed and appends the completed option. Options already given are not offered again (the parser
 * rejects duplicates); nothing is offered while a value, a quoted string or an escape is being typed.
 */
export interface CommandCompletion { value: string; label: string; description?: string }

interface OptionSpec { flag: string; description: string; takesValue?: boolean }
export const COMMIT_OPTIONS: readonly OptionSpec[] = [
  { flag: "--dry-run", description: "Show the plan summary only; never write" },
  { flag: "--model", description: "Exact registered provider/id for planning", takesValue: true },
  { flag: "--context", description: "Additional planning instructions (quote multi-word values)", takesValue: true },
  { flag: "--no-changelog", description: "Do not generate a changelog" },
  { flag: "--push", description: "Push after every planned commit succeeds" },
  { flag: "--yes", description: "Skip the confirmation dialog" },
  { flag: "--help", description: "Show /commit help" },
];
const VALUE_FLAGS = new Set(COMMIT_OPTIONS.filter(option => option.takesValue).map(option => option.flag));

interface Token { start: number; value: string }
/** Mirrors tokenizeArgs, but never throws: an open quote or a trailing escape is reported instead. */
function scan(input: string): { tokens: Token[]; open: boolean } {
  const tokens: Token[] = [];
  let current = "", quote: "'" | '"' | undefined, start = -1;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"' && ["\\", '"'].includes(input[i + 1] ?? "")) current += input[++i];
      else current += char;
    } else if (/\s/.test(char)) {
      if (start >= 0) { tokens.push({ start, value: current }); current = ""; start = -1; }
    } else {
      if (start < 0) start = i;
      if (char === "'" || char === '"') quote = char;
      else if (char === "\\") {
        if (i + 1 === input.length) return { tokens, open: true };
        current += input[++i];
      } else current += char;
    }
  }
  if (quote) return { tokens, open: true };
  if (start >= 0) tokens.push({ start, value: current });
  return { tokens, open: false };
}

export function completeCommitArguments(prefix: string): CommandCompletion[] | null {
  const { tokens, open } = scan(prefix);
  if (open) return null;
  const typing = prefix.length > 0 && !/\s$/.test(prefix) ? tokens.pop() : undefined;
  const typed = typing?.value ?? "";
  const start = typing?.start ?? prefix.length;
  const used = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    const raw = tokens[i]!.value, equal = raw.indexOf("="), flag = equal < 0 ? raw : raw.slice(0, equal);
    used.add(flag);
    if (equal < 0 && VALUE_FLAGS.has(flag)) {
      if (i + 1 === tokens.length) return null; // the value of --model/--context comes next
      i++;
    }
  }
  if (typed.includes("=") || (typed !== "" && !typed.startsWith("-"))) return null;
  const items = COMMIT_OPTIONS.filter(option => !used.has(option.flag) && option.flag.startsWith(typed)).map(option => ({
    value: `${prefix.slice(0, start)}${option.flag}${option.takesValue ? " " : ""}`,
    label: option.takesValue ? `${option.flag} <${option.flag === "--model" ? "provider/id" : "text"}>` : option.flag,
    description: option.description,
  }));
  if (items.length === 0 || (items.length === 1 && items[0]!.value === prefix)) return null;
  return items;
}
