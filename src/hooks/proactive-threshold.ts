import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadSettings, getModelThreshold, resolveTriggerTokens } from "../core/settings";

type ProactiveContext = {
  model?: any;
  getContextUsage?: () => any;
  compact?: (options?: any) => void;
  ui?: any;
  sessionManager?: { getCwd?: () => string };
};

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

// Cooldown after compaction to prevent double-trigger.
let lastCompactTime = 0;
const COOLDOWN_MS = 3000;

let proactiveTriggerActive = false;

const setCooldown = () => { lastCompactTime = Date.now(); };
const isCoolingDown = () => Date.now() - lastCompactTime < COOLDOWN_MS;

/** Check if a proactive trigger is currently in flight. */
export const isProactiveTriggerActive = () => proactiveTriggerActive;

/** Reset all proactive state (for testing / session start). */
export const resetProactiveState = () => {
  lastCompactTime = 0;
  proactiveTriggerActive = false;
};

/**
 * Check if a configured threshold has been crossed and trigger compaction if so.
 */
export const checkAndTrigger = (ctx: ProactiveContext, source: string) => {
  const settings = loadSettings();
  const threshold = getModelThreshold(settings, ctx.model);

  if (!threshold) return;

  const contextWindow = ctx.model?.contextWindow ?? 0;
  const effectiveThreshold = resolveTriggerTokens(threshold, contextWindow);
  if (effectiveThreshold == null) return;

  const usage = ctx.getContextUsage?.();
  if (!usage || usage.tokens === null) return;

  if (usage.tokens <= effectiveThreshold) return;

  if (isCoolingDown()) return;

  try {
    const pct = Math.round((usage.tokens / contextWindow) * 100);
    ctx?.ui?.notify?.(
      `pi-vcc: [${source}] Context at ${pct}% exceeds threshold (${formatTokens(effectiveThreshold)} tok). Compacting...`,
      "info",
    );
  } catch {}

  setCooldown();
  proactiveTriggerActive = true;
  ctx.compact?.();
};

export const registerProactiveThresholdHook = (pi: ExtensionAPI) => {
  pi.on("agent_end", (_event, ctx) => {
    checkAndTrigger(ctx, "auto");
  });

  pi.on("model_select", (_event, ctx) => {
    checkAndTrigger(ctx, "model-switch");
  });

  pi.on("session_compact", () => {
    setCooldown();
    proactiveTriggerActive = false;
  });

  pi.on("session_start", () => {
    lastCompactTime = 0;
    proactiveTriggerActive = false;
  });
};
