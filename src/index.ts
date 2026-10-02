import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runCommitCommand } from "./command/run.js";
import { COMMIT_MESSAGE_TYPE, renderCommitMessage } from "./ui/render.js";

/** Registration only: no I/O or session work while the extension factory loads. */
export default function commitExtension(pi: ExtensionAPI): void {
  let running = false;
  // Plain-text rendering: the default renderer parses content as Markdown, which overflows marked's regex stack on large diffs.
  // Guarded so hosts without message renderers still load the command.
  if (typeof pi.registerMessageRenderer === "function") pi.registerMessageRenderer(COMMIT_MESSAGE_TYPE, renderCommitMessage);
  pi.registerCommand("commit", {
    description: "Preview and confirm single or hunk-split Git commits (/commit --help)",
    handler: async (args, ctx) => {
      if (running) { ctx.ui.notify("A /commit operation is already running.", "warning"); return; }
      running = true;
      try {
        await runCommitCommand(args, ctx, {
          output(text, level = "info") {
            pi.sendMessage({ customType: COMMIT_MESSAGE_TYPE, content: text, display: true, details: { level } }, { triggerTurn: false });
            // Print mode otherwise suppresses non-assistant messages. Never pollute RPC/JSON stdout.
            if (ctx.mode === "print") process.stderr.write(`${text}\n`);
            if (ctx.hasUI && level !== "info") ctx.ui.notify(text, level);
          },
        });
      } finally { running = false; }
    },
  });
}
