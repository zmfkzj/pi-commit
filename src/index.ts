import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { runCommitCommand } from "./command/run.js";

/** Registration only: no I/O or session work while the extension factory loads. */
export default function commitExtension(pi: ExtensionAPI): void {
  let running = false;
  pi.registerCommand("commit", {
    description: "Preview and confirm single or hunk-split Git commits (/commit --help)",
    handler: async (args, ctx) => {
      if (running) { ctx.ui.notify("A /commit operation is already running.", "warning"); return; }
      running = true;
      try {
        await runCommitCommand(args, ctx, {
          output(text, level = "info") {
            pi.sendMessage({ customType: "pi-commit", content: text, display: true, details: { level } }, { triggerTurn: false });
            // Print mode otherwise suppresses non-assistant messages. Never pollute RPC/JSON stdout.
            if (ctx.mode === "print") process.stderr.write(`${text}\n`);
            if (ctx.hasUI && level !== "info") ctx.ui.notify(text, level);
          },
        });
      } finally { running = false; }
    },
  });
}
