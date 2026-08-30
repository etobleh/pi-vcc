import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getLastCompactionStats, scheduleCompactionStatsNotify } from "../hooks/before-compact";
import { countPiVccCompactionsFromSession, ordinalSuffix } from "../core/compaction-count";
import { buildPiVccCustomInstructions, parseKeepAndPrompt } from "../core/compact-args";

export const registerPiVccCommand = (pi: ExtensionAPI) => {
  pi.registerCommand("pi-vcc", {
    description: "Compact conversation with pi-vcc structured summary",
    handler: async (args: string, ctx) => {
      const { followUpPrompt, keepUserTurns } = parseKeepAndPrompt(args);
      ctx.compact({
        customInstructions: buildPiVccCustomInstructions(keepUserTurns),
        onComplete: () => {
          const stats = getLastCompactionStats();
          const count = countPiVccCompactionsFromSession(ctx.sessionManager);
          if (stats) {
            scheduleCompactionStatsNotify(ctx, stats, count);
          } else {
            const label = count > 0 ? ` (${count}${ordinalSuffix(count)} compaction)` : "";
            ctx.ui.notify(`Compacted with pi-vcc${label}`, "info");
          }
          if (followUpPrompt) {
            try {
              void Promise.resolve(pi.sendUserMessage(followUpPrompt)).catch(() => {});
            } catch {}
          }
        },
        onError: (err) => {
          if (err.message === "Compaction cancelled" || err.message === "Already compacted") {
            ctx.ui.notify("Nothing to compact", "warning");
          } else {
            ctx.ui.notify(`Compaction failed: ${err.message}`, "error");
          }
        },
      });
    },
  });
};
