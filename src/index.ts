import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runCommitCommand } from "./command/run.js";
import { completeCommitArguments } from "./command/completions.js";
import { parseSubcommand, type CommitSubcommand } from "./command/args.js";
import { formatDependencyReport, registerDependencyProvider, type DependencyProvider } from "./dependencies.js";
import { createDependencyProvider, type DoctorContext } from "./doctor.js";
import { safeDisplay } from "./ui/format.js";
import { COMMIT_MESSAGE_TYPE, renderCommitMessage } from "./ui/render.js";

/** Registration only: no I/O or session work while the extension factory loads. */
export default function commitExtension(pi: ExtensionAPI): void {
  registerCommitExtension(pi, createDependencyProvider());
}

/** The factory with an injectable dependency provider (tests). */
export function registerCommitExtension(pi: ExtensionAPI, provider: DependencyProvider<DoctorContext>): void {
  let running = false;
  // Answer the umbrella's `/oh-my-pi doctor|install-deps` requests from load on (synchronously, inside the handler).
  // Guarded so hosts without an event bus still load the command.
  if (pi.events && typeof pi.events.on === "function") registerDependencyProvider(pi.events, provider);
  // Plain-text rendering: the default renderer parses content as Markdown, which overflows marked's regex stack on large diffs.
  // Guarded so hosts without message renderers still load the command.
  if (typeof pi.registerMessageRenderer === "function") pi.registerMessageRenderer(COMMIT_MESSAGE_TYPE, renderCommitMessage);
  pi.registerCommand("commit", {
    description: "Plan and confirm single or hunk-split Git commits (/commit --help, /commit doctor, /commit install-deps)",
    getArgumentCompletions: completeCommitArguments,
    handler: async (args, ctx) => {
      // The established /commit output channel: a plain-text transcript message, stderr in print mode, a notification
      // for warnings and errors.
      const output = (text: string, level: "info" | "warning" | "error" = "info") => {
        pi.sendMessage({ customType: COMMIT_MESSAGE_TYPE, content: text, display: true, details: { level } }, { triggerTurn: false });
        // Print mode otherwise suppresses non-assistant messages. Never pollute RPC/JSON stdout.
        if (ctx.mode === "print") process.stderr.write(`${text}\n`);
        if (ctx.hasUI && level !== "info") ctx.ui.notify(text, level);
      };
      let subcommand: CommitSubcommand | undefined;
      try { subcommand = parseSubcommand(args); }
      catch (error) { output(`pi-commit: ${safeDisplay(error instanceof Error ? error.message : String(error))}`, "error"); return; }
      if (subcommand) { await runDependencyCommand(subcommand, provider, ctx, output); return; }
      if (running) { ctx.ui.notify("A /commit operation is already running.", "warning"); return; }
      running = true;
      try {
        await runCommitCommand(args, ctx, { output });
      } finally { running = false; }
    },
  });
}

/** `/commit doctor` (read-only check) and `/commit install-deps` (repeatable; concurrent calls share one run). */
async function runDependencyCommand(
  subcommand: CommitSubcommand,
  provider: DependencyProvider<DoctorContext>,
  ctx: DoctorContext & { hasUI: boolean; ui: { setStatus?(key: string, text: string | undefined): void } },
  output: (text: string, level?: "info" | "warning" | "error") => void,
): Promise<void> {
  const mode = subcommand === "doctor" ? "check" : "install";
  const showStatus = ctx.hasUI && typeof ctx.ui.setStatus === "function";
  if (showStatus) ctx.ui.setStatus!("pi-commit", subcommand === "doctor" ? "pi-commit: checking dependencies…" : "pi-commit: installing dependencies…");
  try {
    const report = mode === "check" ? await provider.check(ctx) : await provider.install(ctx);
    const { text, level } = formatDependencyReport(provider.label, report, mode);
    output(text, level);
  } catch (error) {
    output(`pi-commit ${subcommand}: ${safeDisplay(error instanceof Error ? error.message : String(error))}`, "error");
  } finally {
    if (showStatus) ctx.ui.setStatus!("pi-commit", undefined);
  }
}
