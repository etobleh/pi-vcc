import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { compileRanked } from "../core/summarize";
import { parseKeepAndPrompt, PI_VCC_COMPACT_INSTRUCTION } from "../core/compact-args";
import { loadSettings, type PiVccSettings } from "../core/settings";
import { calibrateCharsPerToken, estimateMessageContentChars, estimateMessageContentTokens, estimateTokensFromChars } from "../core/token-estimate";
import { buildGlobalIndexMap } from "../core/lineage";
import { extractFiles } from "../extract/files";
import { normalize } from "../core/normalize";
import { isProactiveTriggerActive } from "./proactive-threshold";
import { countPiVccCompactionsFromSession, ordinalSuffix } from "../core/compaction-count";
import type { PiVccCompactionDetails } from "../details";
import type { CompactionReason, FileOps } from "../types";

export { PI_VCC_COMPACT_INSTRUCTION } from "../core/compact-args";

export interface CompactionStats {
  summarized: number;
  kept: number;
  keptUserTurns: number;
  totalUserTurns: number;
  requestedKeepUserTurns: number;
  keepUserTurnsExplicit: boolean;
  keepFallbackToCompactAll: boolean;
  /** Set when the tail came from a token-budget cut instead of a user-turn cut. */
  budgetCut?: BudgetCutKind;
  keptTokensEst: number;
  /** True when smart-keep boosted the default keep beyond 1. */
  smartKeepAdjusted?: boolean;
  /** Base keep before smart adjustment (for toast like "1→3"). */
  smartFromKeep?: number;
  reason?: CompactionReason;
  willRetry?: boolean;
}

export type BudgetCutKind = "no_anchor" | "oversized_tail";
export const OVERSIZED_TAIL_FACTOR = 2.5;

let lastStats: CompactionStats | null = null;
let lastCompactWasPiVcc = false;
let lastCompactWasProactive = false;
let lastCompactionInterrupted = false;
let pendingFollowUpPrompt: string | null = null;
let pendingAutoContinueTimer: ReturnType<typeof setTimeout> | null = null;

export const AUTO_CONTINUE_CUSTOM_TYPE = "pi-vcc-auto-continue";

export const triggerAutoContinue = (pi: ExtensionAPI): void => {
  pi.sendMessage(
    {
      customType: AUTO_CONTINUE_CUSTOM_TYPE,
      content: "Continue",
      display: false,
      details: undefined,
    },
    {
      triggerTurn: true,
      deliverAs: "followUp",
    },
  );
};

export const triggerInvisibleContinue = triggerAutoContinue;

const clearPendingAutoContinue = () => {
  if (pendingAutoContinueTimer) {
    clearTimeout(pendingAutoContinueTimer);
    pendingAutoContinueTimer = null;
  }
};

const scheduleAutoContinue = (pi: any) => {
  clearPendingAutoContinue();
  pendingAutoContinueTimer = setTimeout(() => {
    pendingAutoContinueTimer = null;
    try {
      triggerAutoContinue(pi);
    } catch {}
  }, 0);
};

export const getLastCompactionStats = () => lastStats;

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

export const formatCompactionStats = (stats: CompactionStats, ordinal?: number): string => {
  const compactionLabel = ordinal && ordinal > 0
    ? ` (${ordinal}${ordinalSuffix(ordinal)} compaction)`
    : "";
  if (stats.budgetCut) {
    const reason = stats.budgetCut === "no_anchor" ? "no user anchor" : "oversized tail";
    return `pi-vcc: kept ~${formatTokens(stats.keptTokensEst)} tok tail (mid-turn cut, ${reason}), summarized ${stats.summarized}.${compactionLabel}`;
  }
  const notes: string[] = [`summarized ${stats.summarized}`];
  if (stats.smartKeepAdjusted) {
    notes.push("smart-keep");
  }
  return `pi-vcc: kept ${stats.keptUserTurns}/${stats.totalUserTurns} turns, ~${formatTokens(stats.keptTokensEst)} tok (${notes.join(", ")}).${compactionLabel}`;
};

const readCompactionEventContext = (event: unknown): { reason?: CompactionReason; willRetry: boolean } => {
  const raw = event as { reason?: unknown; willRetry?: unknown };
  const reason = raw.reason === "manual" || raw.reason === "threshold" || raw.reason === "overflow"
    ? raw.reason
    : undefined;
  return { reason, willRetry: raw.willRetry === true };
};

export const scheduleCompactionStatsNotify = (ctx: any, stats: CompactionStats, ordinal?: number) => {
  const count = ordinal ?? countPiVccCompactionsFromSession(ctx?.sessionManager);
  setTimeout(() => {
    try {
      ctx?.ui?.notify?.(
        formatCompactionStats(stats, count),
        "info",
      );
    } catch {}
  }, 500);
};

const parseCompactionInstructions = (customInstructions?: string): {
  isPiVcc: boolean;
  keepUserTurns: number;
  keepUserTurnsExplicit: boolean;
  followUpPrompt: string | null;
  hasCustomInstructions: boolean;
} => {
  const trimmed = customInstructions?.trim();
  if (!trimmed) {
    return {
      isPiVcc: false,
      keepUserTurns: 1,
      keepUserTurnsExplicit: false,
      followUpPrompt: null,
      hasCustomInstructions: false,
    };
  }

  if (trimmed === PI_VCC_COMPACT_INSTRUCTION) {
    return {
      isPiVcc: true,
      keepUserTurns: 1,
      keepUserTurnsExplicit: false,
      followUpPrompt: null,
      hasCustomInstructions: false,
    };
  }

  const keepPrefix = `${PI_VCC_COMPACT_INSTRUCTION} `;
  if (trimmed.startsWith(keepPrefix)) {
    const parsed = parseKeepAndPrompt(trimmed.slice(keepPrefix.length));
    return {
      isPiVcc: true,
      keepUserTurns: parsed.keepUserTurns ?? 1,
      keepUserTurnsExplicit: parsed.keepUserTurnsExplicit,
      followUpPrompt: parsed.followUpPrompt || null,
      hasCustomInstructions: false,
    };
  }

  // Not a /pi-vcc instruction (e.g. user typed /compact <text>)
  return {
    isPiVcc: false,
    keepUserTurns: 1,
    keepUserTurnsExplicit: false,
    followUpPrompt: null,
    hasCustomInstructions: true,
  };
};

const normalizeKeepUserTurns = (keepUserTurns: number): number => {
  if (!Number.isFinite(keepUserTurns)) return 0;
  return Math.max(0, Math.floor(keepUserTurns));
};

const dbg = (settings: PiVccSettings, data: Record<string, unknown>) => {
  if (!settings.debug) return;
  try { writeFileSync(join(tmpdir(), "pi-vcc-debug.json"), JSON.stringify(data, null, 2)); } catch {}
};

const previewContent = (content: unknown): string => {
  if (typeof content === "string") return content.slice(0, 300);
  if (Array.isArray(content)) {
    return content
      .map((c: any) => {
        if (c?.type === "text") return c.text ?? "";
        if (c?.type === "toolCall") return `[toolCall:${c.name}]`;
        if (c?.type === "thinking") return `[thinking]`;
        if (c?.type === "image") return `[image:${c.mimeType}]`;
        return `[${c?.type ?? "unknown"}]`;
      })
      .join("\n")
      .slice(0, 300);
  }
  return "";
};

export interface EntryWithMessage {
  entry: { id: string; type: string };
  message: { role: string; content: unknown; [key: string]: unknown };
}

// Convert a non-message entry that carries LLM-context text (custom_message /
// branch_summary) into its agent-message form, mirroring pi-core's
// createCustomMessage / createBranchSummaryMessage (not root-exported, so inlined).
export const toLiveMessage = (entry: any): { role: string; content: unknown; [key: string]: unknown } | null => {
  if (entry.type === "message" && entry.message) return entry.message;
  if (entry.type === "custom_message") {
    return {
      role: "custom",
      customType: entry.customType,
      content: entry.content,
      display: entry.display,
      details: entry.details,
      timestamp: entry.timestamp != null ? new Date(entry.timestamp).getTime() : undefined,
    };
  }
  if (entry.type === "branch_summary") {
    return {
      role: "branchSummary",
      summary: entry.summary,
      fromId: entry.fromId,
      content: undefined,
      timestamp: entry.timestamp != null ? new Date(entry.timestamp).getTime() : undefined,
    };
  }
  return null;
};

export type OwnCutCancelReason =
  | "no_live_messages"
  | "too_few_live_messages";

export type OwnCutResult =
  | {
      ok: true;
      messages: any[];
      firstKeptEntryId: string;
      compactAll: boolean;
      keptUserTurns: number;
      totalUserTurns: number;
      requestedKeepUserTurns: number;
      keepFallbackToCompactAll: boolean;
      budgetCut?: BudgetCutKind;
    }
  | { ok: false; reason: OwnCutCancelReason };

const collectLiveMessages = (branchEntries: any[]): EntryWithMessage[] => {
  // Find the last compaction entry and its firstKeptEntryId
  let lastCompactionIdx = -1;
  let lastKeptId: string | undefined;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type === "compaction") {
      lastCompactionIdx = i;
      lastKeptId = branchEntries[i].firstKeptEntryId;
      break;
    }
  }

  // Orphan recovery: triggers when lastKeptId is set to "" (sentinel from prior
  // compact-all) OR set to an id that no longer exists in the branch. In both cases,
  // start collecting from right after the last compaction entry.
  const hasPriorCompaction = lastCompactionIdx >= 0;
  const hasValidKeptId = !!lastKeptId && branchEntries.some((e: any) => e.id === lastKeptId);
  const orphanRecovery = hasPriorCompaction && !hasValidKeptId;

  // Collect live messages
  const liveMessages: EntryWithMessage[] = [];
  if (orphanRecovery) {
    for (let i = lastCompactionIdx + 1; i < branchEntries.length; i++) {
      const e = branchEntries[i];
      if (e.type === "compaction") continue;
      const m = toLiveMessage(e);
      if (m) liveMessages.push({ entry: e, message: m });
    }
  } else {
    let foundKept = !lastKeptId; // if no prior compaction, start collecting immediately
    for (const e of branchEntries) {
      if (!foundKept && e.id === lastKeptId) foundKept = true;
      if (!foundKept) continue;
      if (e.type === "compaction") continue;
      const m = toLiveMessage(e);
      if (m) liveMessages.push({ entry: e, message: m });
    }
  }
  return liveMessages;
};

export function buildOwnCut(branchEntries: any[], keepUserTurns = 1): OwnCutResult {
  const normalizedKeepUserTurns = normalizeKeepUserTurns(keepUserTurns);
  const liveMessages = collectLiveMessages(branchEntries);

  if (liveMessages.length === 0) return { ok: false, reason: "no_live_messages" };
  if (liveMessages.length <= 2) return { ok: false, reason: "too_few_live_messages" };

  const userIndices = liveMessages.reduce<number[]>((acc, e, i) => {
    if (e.message.role === "user") acc.push(i);
    return acc;
  }, []);
  const compactAll = (keepFallbackToCompactAll: boolean) => ({
    ok: true as const,
    messages: liveMessages.map((e) => e.message),
    firstKeptEntryId: "",
    compactAll: true,
    keptUserTurns: 0,
    totalUserTurns: userIndices.length,
    requestedKeepUserTurns: normalizedKeepUserTurns,
    keepFallbackToCompactAll,
  });

  if (normalizedKeepUserTurns <= 0) return compactAll(false);

  // Summarize all messages before the requested kept user-turn tail.
  const targetUserIdx = userIndices.length - normalizedKeepUserTurns;
  const cutIdx = targetUserIdx >= 0 ? userIndices[targetUserIdx] : -1;

  if (cutIdx <= 0) {
    // Keep request cannot form a safe boundary (single user prompt, no user prompt,
    // or keep larger than available user turns), so compact EVERYTHING and keep no tail.
    // firstKeptEntryId="" is a sentinel: pi-core's buildSessionContext won't match it
    // (so 0 kept from pre-compaction), and next buildOwnCut triggers orphan recovery.
    return compactAll(true);
  }

  return {
    ok: true,
    messages: liveMessages.slice(0, cutIdx).map((e) => e.message),
    firstKeptEntryId: liveMessages[cutIdx].entry.id,
    compactAll: false,
    keptUserTurns: userIndices.length - targetUserIdx,
    totalUserTurns: userIndices.length,
    requestedKeepUserTurns: normalizedKeepUserTurns,
    keepFallbackToCompactAll: false,
  };
}

// Token-budget tail cut: rescue default-path sessions when the user-turn
// anchored tail is absent (autonomous: no user boundary in the live window)
// or oversized (a single giant last user turn). Cuts at the nearest valid
// non-toolResult boundary, mirroring pi-core's findCutPoint.
export const findBudgetCutIndex = (
  live: EntryWithMessage[],
  maxTokens: number,
  charsPerToken?: number,
): number => {
  let acc = 0;
  let crossed = -1;
  for (let i = live.length - 1; i >= 0; i--) {
    acc += estimateMessageContentTokens(live[i].message.content, charsPerToken);
    if (acc >= maxTokens) {
      crossed = i;
      break;
    }
  }
  if (crossed < 0) return -1;
  // Snap forward off any toolResult to the next valid boundary.
  for (let j = Math.max(crossed, 1); j < live.length; j++) {
    if (live[j].message.role !== "toolResult") return j;
  }
  return -1;
};

export const applyTailBudget = (
  branchEntries: any[],
  cut: OwnCutResult,
  opts: { maxTokens?: number; oversizedFactor?: number; charsPerToken?: number } = {},
): OwnCutResult => {
  if (!cut.ok) return cut;
  const maxTokens = opts.maxTokens ?? MAX_SMART_TAIL_TOKENS;
  const factor = opts.oversizedFactor ?? OVERSIZED_TAIL_FACTOR;
  const live = collectLiveMessages(branchEntries);

  const budgetResult = (idx: number, budgetCut: BudgetCutKind): OwnCutResult => ({
    ok: true,
    messages: live.slice(0, idx).map((m) => m.message),
    firstKeptEntryId: live[idx].entry.id,
    compactAll: false,
    keptUserTurns: live.slice(idx).filter((m) => m.message.role === "user").length,
    totalUserTurns: live.filter((m) => m.message.role === "user").length,
    requestedKeepUserTurns: cut.requestedKeepUserTurns,
    keepFallbackToCompactAll: false,
    budgetCut,
  });

  // Case A: no user anchor → compact-all. Re-cut to a token budget unless the
  // compact-all came from explicit keep:0 (which must be respected absolutely).
  if (cut.compactAll) {
    if (!cut.keepFallbackToCompactAll) return cut;
    const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
    if (idx < 0) return cut;
    return budgetResult(idx, "no_anchor");
  }

  // Case B: oversized user-boundary tail. Only re-cut when the kept tail exceeds
  // maxTokens * factor (tolerance zone below is unchanged).
  const tailStart = cut.messages.length; // equals the cut index in the live window
  let tailTokens = 0;
  for (let i = tailStart; i < live.length; i++) {
    tailTokens += estimateMessageContentTokens(live[i].message.content, opts.charsPerToken);
  }
  if (tailTokens <= maxTokens * factor) return cut;
  const idx = findBudgetCutIndex(live, maxTokens, opts.charsPerToken);
  if (idx <= tailStart) return cut;
  return budgetResult(idx, "oversized_tail");
};

// ── smart keep-tail: boost default keep when tail is small ──

export const MIN_SMART_TAIL_TOKENS = 5_000;
export const MAX_SMART_TAIL_TOKENS = 25_000;

export interface ResolveSmartKeepOptions {
  branchEntries: any[];
  /** Requested keep:N; null when user did not specify (default path). */
  requestedKeepUserTurns: number | null;
  /** True when user typed keep:N explicitly — always respected. */
  explicit: boolean;
  /** Setting toggle. */
  smartKeepTail: boolean;
  /** Injectable thresholds for tests. */
  minTokens?: number;
  maxTokens?: number;
  /** Calibrated chars/token for the current session; defaults to heuristic when omitted. */
  charsPerToken?: number;
}

export interface ResolveSmartKeepResult {
  keepUserTurns: number;
  smartAdjusted: boolean;
  /** Original base keep, for toast like "1→3". */
  fromKeep: number;
}

/**
 * Resolve the effective keep:N.
 * - Explicit keep:N from the user is always respected.
 * - smartKeepTail=false → old behavior (default keep:1).
 * - smartKeepTail=true → if keep:1 tail <= minTokens, grow keep to the
 *   largest N whose tail stays <= maxTokens. Stops at compact-all boundary.
 *
 * Optimized O(N) calculation using cumulative token estimates over liveMessages.
 */
export const resolveSmartKeepUserTurns = (opts: ResolveSmartKeepOptions): ResolveSmartKeepResult => {
  const minTokens = opts.minTokens ?? MIN_SMART_TAIL_TOKENS;
  const maxTokens = opts.maxTokens ?? MAX_SMART_TAIL_TOKENS;
  const baseKeep = opts.requestedKeepUserTurns ?? 1;

  if (opts.explicit || !opts.smartKeepTail) {
    return { keepUserTurns: baseKeep, smartAdjusted: false, fromKeep: baseKeep };
  }

  const live = collectLiveMessages(opts.branchEntries);
  if (live.length <= 2) {
    return { keepUserTurns: baseKeep, smartAdjusted: false, fromKeep: baseKeep };
  }

  const userIndices = live.reduce<number[]>((acc, e, i) => {
    if (e.message.role === "user") acc.push(i);
    return acc;
  }, []);
  const totalUserTurns = userIndices.length;

  if (totalUserTurns === 0) {
    return { keepUserTurns: baseKeep, smartAdjusted: false, fromKeep: baseKeep };
  }

  // Precompute suffix token sums from each message index to the end
  const suffixTokens: number[] = new Array(live.length + 1).fill(0);
  for (let i = live.length - 1; i >= 0; i--) {
    suffixTokens[i] = suffixTokens[i + 1] + estimateMessageContentTokens(live[i].message.content, opts.charsPerToken);
  }

  const tokensForK = (k: number): number | null => {
    const targetUserIdx = totalUserTurns - k;
    if (targetUserIdx <= 0) return null; // compact-all or invalid cut
    const cutIdx = userIndices[targetUserIdx];
    return suffixTokens[cutIdx];
  };

  const baseTokens = tokensForK(baseKeep);
  if (baseTokens == null || baseTokens > minTokens) {
    return { keepUserTurns: baseKeep, smartAdjusted: false, fromKeep: baseKeep };
  }

  let selected = baseKeep;
  for (let k = baseKeep + 1; k <= totalUserTurns; k++) {
    const tokens = tokensForK(k);
    if (tokens == null || tokens > maxTokens) break;
    selected = k;
  }

  return {
    keepUserTurns: selected,
    smartAdjusted: selected !== baseKeep,
    fromKeep: baseKeep,
  };
};

const REASON_MESSAGES: Record<OwnCutCancelReason, string> = {
  no_live_messages: "pi-vcc: Nothing to compact (no live messages)",
  too_few_live_messages: "pi-vcc: Too few messages to compact",
};

export const registerBeforeCompactHook = (pi: ExtensionAPI) => {
  pi.on("before_agent_start", () => {
    clearPendingAutoContinue();
  });

  pi.on("session_before_compact", (event, ctx) => {
    lastStats = null;
    lastCompactWasPiVcc = false;
    lastCompactionInterrupted = false;
    pendingFollowUpPrompt = null;

    const { preparation, branchEntries, customInstructions } = event;
    const { reason, willRetry } = readCompactionEventContext(event);
    const settings = loadSettings();

    // Always handle explicit /pi-vcc marker.
    // Otherwise, only handle when user opted in via settings and no custom instructions were given.
    const { isPiVcc, keepUserTurns, keepUserTurnsExplicit, followUpPrompt, hasCustomInstructions } = parseCompactionInstructions(customInstructions);
    pendingFollowUpPrompt = null;
    if (!isPiVcc) {
      if (hasCustomInstructions) {
        // Fall through to pi core's LLM compaction when custom instructions are present
        return;
      }
      if (!settings.overrideDefaultCompaction) {
        return;
      }
    }

    const calibrationCut = buildOwnCut(branchEntries as any[], 0);
    const calibrationMessageChars = calibrationCut.ok
      ? calibrationCut.messages.reduce(
          (sum: number, message: any) => sum + estimateMessageContentChars(message.content),
          0,
        )
      : 0;
    const calibrationSummaryChars = typeof preparation.previousSummary === "string"
      ? preparation.previousSummary.length
      : 0;
    const tokenEstimate = calibrateCharsPerToken(
      calibrationMessageChars + calibrationSummaryChars,
      preparation.tokensBefore,
    );

    // Smart keep-tail: boost default keep when the tail is small.
    // Explicit keep:N from the user is always respected (resolver no-ops).
    const smartKeep = resolveSmartKeepUserTurns({
      branchEntries: branchEntries as any[],
      requestedKeepUserTurns: keepUserTurnsExplicit ? keepUserTurns : null,
      explicit: keepUserTurnsExplicit,
      smartKeepTail: settings.smartKeepTail,
      charsPerToken: tokenEstimate.charsPerToken,
    });
    let ownCut = buildOwnCut(branchEntries as any[], smartKeep.keepUserTurns);
    // Default path only: rescue autonomous / oversized-tail sessions with a
    // token-budget cut. Explicit keep:N is respected absolutely (no-op here).
    if (ownCut.ok && !keepUserTurnsExplicit) {
      ownCut = applyTailBudget(branchEntries as any[], ownCut, { charsPerToken: tokenEstimate.charsPerToken });
    }
    if (!ownCut.ok) {
      const lastComp = [...branchEntries].reverse().find((e: any) => e.type === "compaction");
      const lastCompIdx = lastComp ? (branchEntries as any[]).indexOf(lastComp) : -1;

      // Recompute liveMessages view (same logic as buildOwnCut) for diagnostic
      const lastKeptId: string | undefined = (lastComp as any)?.firstKeptEntryId;
      const hasPriorCompaction = lastCompIdx >= 0;
      const hasValidKeptId = !!lastKeptId && (branchEntries as any[]).some((e: any) => e.id === lastKeptId);
      const diagOrphan = hasPriorCompaction && !hasValidKeptId;
      const liveRoles: string[] = [];
      if (diagOrphan) {
        for (let i = lastCompIdx + 1; i < branchEntries.length; i++) {
          const e = (branchEntries as any[])[i];
          if (e.type === "compaction") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      } else {
        let foundKept = !lastKeptId;
        for (const e of branchEntries as any[]) {
          if (!foundKept && e.id === lastKeptId) foundKept = true;
          if (!foundKept) continue;
          if (e.type === "compaction") continue;
          if (e.type === "message" && e.message) liveRoles.push(e.message.role);
        }
      }
      const userIndices = liveRoles.reduce<number[]>((acc, r, i) => (r === "user" ? (acc.push(i), acc) : acc), []);

      pendingFollowUpPrompt = null;
      const fallbackToCore = !isPiVcc && (reason === "overflow" || willRetry);
      dbg(settings, {
        cancelled: !fallbackToCore,
        fallbackToCore,
        reason: ownCut.reason,
        compaction: { reason, willRetry },
        isPiVcc,
        counts: {
          total: branchEntries.length,
          messages: (branchEntries as any[]).filter((e: any) => e.type === "message").length,
          compactions: (branchEntries as any[]).filter((e: any) => e.type === "compaction").length,
          entriesAfterLastCompaction: lastCompIdx >= 0 ? branchEntries.length - lastCompIdx - 1 : null,
        },
        liveMessages: {
          count: liveRoles.length,
          userCount: userIndices.length,
          firstUserIdx: userIndices[0] ?? null,
          lastUserIdx: userIndices[userIndices.length - 1] ?? null,
          roleSequence: liveRoles.length <= 30
            ? liveRoles
            : [...liveRoles.slice(0, 10), "...", ...liveRoles.slice(-10)],
        },
        lastCompaction: lastComp ? {
          hasFirstKeptEntryId: !!(lastComp as any).firstKeptEntryId,
          foundInBranch: (lastComp as any).firstKeptEntryId
            ? (branchEntries as any[]).some((e: any) => e.id === (lastComp as any).firstKeptEntryId)
            : null,
        } : null,
        tail: (branchEntries as any[]).slice(-5).map((e: any) => ({
          type: e.type,
          role: e.type === "message" ? e.message?.role : undefined,
          hasContent: e.type === "message" ? e.message?.content != null : undefined,
        })),
      });

      if (fallbackToCore) return;

      try {
        ctx?.ui?.notify?.(REASON_MESSAGES[ownCut.reason], "warning");
      } catch {}
      return { cancel: true };
    }

    pendingFollowUpPrompt = followUpPrompt;
    const firstKeptEntryId = ownCut.firstKeptEntryId;

    // Collect all session entries for global indexing (source of truth for #N)
    const allSessionEntries = ctx?.sessionManager?.getEntries?.() ?? branchEntries;
    const globalIndexMap = buildGlobalIndexMap(allSessionEntries as any[]);

    // Determine live slice with entry metadata attached
    const liveMessages = collectLiveMessages(branchEntries as any[]);
    const cutIdx = ownCut.compactAll
      ? liveMessages.length
      : liveMessages.findIndex((e) => e.entry.id === firstKeptEntryId);
    const messagesToSummarize: EntryWithMessage[] = cutIdx >= 0
      ? liveMessages.slice(0, cutIdx)
      : liveMessages;

    // Find the last real conversation turn message (exclude custom, branchSummary, compaction)
    let lastTurnMsg: any = undefined;
    for (let i = liveMessages.length - 1; i >= 0; i--) {
      const m = liveMessages[i]?.message;
      if (!m) continue;
      if (m.role !== "custom" && m.role !== "branchSummary") {
        lastTurnMsg = m;
        break;
      }
    }

    // Check if the last conversation turn was an interrupted assistant turn (for auto-continue gating)
    lastCompactionInterrupted = Boolean(
      lastTurnMsg &&
      !(lastTurnMsg.role === "assistant" && lastTurnMsg.stopReason === "stop")
    );

    // File operations: computed from own cut, unioning with preparation if cut points align
    const normalizedToSummarize = normalize(messagesToSummarize);
    const ownFileActivity = extractFiles(normalizedToSummarize);
    const fileOps: FileOps = {
      readFiles: [...ownFileActivity.read],
      modifiedFiles: [...ownFileActivity.modified, ...ownFileActivity.created],
    };
    if (preparation.firstKeptEntryId === ownCut.firstKeptEntryId && preparation.fileOps) {
      fileOps.readFiles = [...new Set([...(fileOps.readFiles ?? []), ...(preparation.fileOps.read ?? [])])];
      fileOps.modifiedFiles = [...new Set([
        ...(fileOps.modifiedFiles ?? []),
        ...(preparation.fileOps.written ?? []),
        ...(preparation.fileOps.edited ?? []),
      ])];
    }

    // Count kept messages and estimate tokens
    const keptIdx = (branchEntries as any[]).findIndex((e: any) => e.id === firstKeptEntryId);
    const keptEntries = keptIdx >= 0
      ? (branchEntries as any[]).slice(keptIdx).filter((e: any) => e.type === "message")
      : [];
    const keptChars = keptEntries.reduce(
      (sum: number, e: any) => sum + estimateMessageContentChars(e.message?.content),
      0,
    );
    const effectiveReason: CompactionReason | undefined =
      reason ?? (isProactiveTriggerActive() ? "threshold" : undefined);
    lastCompactWasProactive = isProactiveTriggerActive();

    lastStats = {
      summarized: messagesToSummarize.length,
      kept: keptEntries.length,
      keptUserTurns: ownCut.keptUserTurns,
      totalUserTurns: ownCut.totalUserTurns,
      requestedKeepUserTurns: ownCut.requestedKeepUserTurns,
      keepUserTurnsExplicit,
      keepFallbackToCompactAll: ownCut.keepFallbackToCompactAll,
      keptTokensEst: estimateTokensFromChars(keptChars, tokenEstimate.charsPerToken),
      smartKeepAdjusted: smartKeep.smartAdjusted,
      smartFromKeep: smartKeep.fromKeep,
      budgetCut: ownCut.ok ? ownCut.budgetCut : undefined,
      reason: effectiveReason,
      willRetry,
    };

    const config = settings;

    // Ranked compaction: keep the highest-signal blocks under a token budget
    // instead of the old unranked compile() (fixed 120-line cap). The token
    // budget is converted to a char budget via the session's calibrated
    // charsPerToken so the summary targets ~RANKED_BRIEF_BUDGET_TOKENS tokens
    // regardless of content density.
    const RANKED_BRIEF_BUDGET_TOKENS = 1100;
    const RANKED_BRIEF_CEILING_TOKENS = 2000;
    const RANKED_BRIEF_TOKENS_PER_BLOCK = 15;
    const summary = compileRanked({
      messages: messagesToSummarize,
      previousSummary: preparation.previousSummary,
      fileOps,
      globalIndexMap,
      extraNoiseTools: settings.noiseTools,
      extraNoiseCustomTypes: settings.noiseCustomTypes,
      ranking: {
        fileOps,
        maxBriefChars: Math.round(RANKED_BRIEF_BUDGET_TOKENS * tokenEstimate.charsPerToken),
        maxBriefCharsCeiling: Math.round(RANKED_BRIEF_CEILING_TOKENS * tokenEstimate.charsPerToken),
        briefCharsPerBlock: Math.round(RANKED_BRIEF_TOKENS_PER_BLOCK * tokenEstimate.charsPerToken),
      },
    });

    const branchIds = branchEntries.map((e: any) => e.id);
    const cutWindowIdx = branchIds.indexOf(firstKeptEntryId);
    const cutWindow = cutWindowIdx >= 0
      ? branchEntries.slice(Math.max(0, cutWindowIdx - 3), Math.min(branchEntries.length, cutWindowIdx + 3)).map((e: any) => ({
          id: e.id,
          type: e.type,
          role: e.type === "message" ? e.message?.role : undefined,
          preview: e.type === "message" ? previewContent(e.message?.content) : undefined,
        }))
      : [];

    dbg(config, {
      usedOwnCut: true,
      budgetCut: ownCut.budgetCut,
      compaction: { reason, willRetry },
      messagesToSummarize: messagesToSummarize.length,
      messagesPreviewHead: messagesToSummarize.slice(0, 3).map((m: any) => ({ role: m.message?.role, preview: previewContent(m.message?.content) })),
      messagesPreviewTail: messagesToSummarize.slice(-3).map((m: any) => ({ role: m.message?.role, preview: previewContent(m.message?.content) })),
      firstKeptEntryId,
      cutWindow,
      tokensBefore: preparation.tokensBefore,
      tokenEstimate,
      summaryLength: summary.length,
      summaryPreview: summary.slice(0, 500),
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
    });

    const details: PiVccCompactionDetails = {
      compactor: "pi-vcc",
      version: 1,
      sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((m) => m[1]),
      sourceMessageCount: messagesToSummarize.length,
      previousSummaryUsed: Boolean(preparation.previousSummary),
      readFiles: fileOps.readFiles,
      modifiedFiles: fileOps.modifiedFiles,
      reason: effectiveReason,
      willRetry,
    };

    lastCompactWasPiVcc = isPiVcc;

    return {
      compaction: {
        summary,
        details,
        tokensBefore: preparation.tokensBefore,
        firstKeptEntryId,
      },
    };
  });

  // Fire success toast for /compact path only (delayed to let UI settle).
  // /pi-vcc path uses its own onComplete callback in the command handler.
  pi.on("session_compact", async (event, ctx) => {
    const { reason, willRetry } = readCompactionEventContext(event);
    if (!event.fromExtension) return;
    const followUpPrompt = pendingFollowUpPrompt;
    pendingFollowUpPrompt = null;
    if (lastCompactWasPiVcc) return; // /pi-vcc handles its own toast via onComplete
    if (willRetry) return;
    const stats = lastStats;
    if (!stats) return;
    const shouldContinueAfterAutoCompact = (reason === "threshold" || reason === "overflow")
      && loadSettings().continueAfterThresholdCompact
      && lastCompactionInterrupted;
    scheduleCompactionStatsNotify(ctx, stats);
    if (followUpPrompt) {
      try {
        await pi.sendUserMessage(followUpPrompt);
      } catch {}
    } else if (shouldContinueAfterAutoCompact) {
      scheduleAutoContinue(pi);
    }
  });
};
