import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const SETTINGS_PATH_DEFAULT = join(getAgentDir(), "pi-vcc-config.json");
const settingsPath = (): string => process.env.PI_VCC_CONFIG_PATH ?? join(getAgentDir(), "pi-vcc-config.json");
/** Backwards-compat export. Resolves at access time, not import time. */
export const SETTINGS_PATH = settingsPath();

/** Per-model or global compaction threshold. */
export interface ModelThreshold {
  /**
   * Tokens to reserve for LLM response. Overrides pi-core's
   * compaction.reserveTokens for matching models.
   *
   * Takes precedence over compactAtTokens and compactPercent when multiple are set.
   */
  reserveTokens?: number;
  /**
   * Absolute context token count where compaction triggers.
   * Ignored when reserveTokens is also set; takes precedence over compactPercent.
   */
  compactAtTokens?: number;
  /**
   * Compaction trigger as a percentage of context window (1–99).
   * Ignored when reserveTokens or compactAtTokens is also set.
   */
  compactPercent?: number;
  /**
   * Recent tokens to keep when pi-core handles compaction.
   */
  keepRecentTokens?: number;
}

export interface PiVccSettings {
  /**
   * When true (default), pi-vcc handles ALL compactions:
   *   - /compact (no args)
   *   - auto threshold / overflow
   *   - /pi-vcc (always handled regardless)
   *
   * When false, pi-vcc only handles /pi-vcc; everything else falls back to
   * pi core's default LLM-based compaction. Existing config files keep their
   * stored value; the new default applies to fresh installs only.
   */
  overrideDefaultCompaction: boolean;
  /**
   * When true (default), pi-vcc boosts the default keep-tail when the current
   * keep:1 tail is small enough. Specifically: if the estimated tail for keep:1
   * is <= MIN_SMART_TAIL_TOKENS (5k), increase keep up to the largest N whose
   * tail stays <= MAX_SMART_TAIL_TOKENS (25k). Explicit `keep:N` from the user
   * is always respected and never adjusted.
   */
  smartKeepTail: boolean;
  /**
   * When true (default false), pi-vcc asks the agent to continue after a successful
   * automatic compaction if the turn was cut mid-work.
   */
  continueAfterThresholdCompact: boolean;
  /** Extra tool names to drop as noise during compaction. */
  noiseTools?: string[];
  /** Extra custom message types to drop as noise during compaction. */
  noiseCustomTypes?: string[];
  /** Write debug snapshot to <tmpdir>/pi-vcc-debug.json on each compaction. */
  debug: boolean;
  /**
   * Per-model compaction thresholds. Keys match "provider/modelId" or "modelId".
   */
  modelThresholds?: Record<string, ModelThreshold>;
  /**
   * Global threshold applied to models not matched by modelThresholds.
   */
  globalThreshold?: ModelThreshold;
  /**
   * @deprecated Use globalThreshold instead.
   */
  defaultThreshold?: ModelThreshold;
}

export const DEFAULT_SETTINGS: PiVccSettings = {
  overrideDefaultCompaction: true,
  smartKeepTail: true,
  continueAfterThresholdCompact: false,
  debug: false,
};

/**
 * Resolve the effective ModelThreshold for a given model.
 *
 * Lookup order:
 *  1. Exact match on "provider/modelId" key
 *  2. Exact match on "modelId" key
 *  3. globalThreshold from settings
 *  4. undefined (no override — pi-core's global settings apply)
 */
export function getModelThreshold(
  settings: PiVccSettings,
  model: { id: string; provider?: string } | undefined,
): ModelThreshold | undefined {
  if (!model) return settings.globalThreshold ?? settings.defaultThreshold;

  const providerModelId = model.provider ? `${model.provider}/${model.id}` : undefined;

  // Exact match on provider/modelId
  if (providerModelId && settings.modelThresholds?.[providerModelId]) {
    return settings.modelThresholds[providerModelId];
  }

  // Exact match on just modelId
  if (settings.modelThresholds?.[model.id]) {
    return settings.modelThresholds[model.id];
  }

  return settings.globalThreshold ?? settings.defaultThreshold;
}

/**
 * Resolve the effective reserveTokens for a threshold, handling both
 * absolute (reserveTokens) and percentage (compactPercent) modes.
 */
export function resolveReserveTokens(
  threshold: ModelThreshold,
  contextWindow: number,
): number | undefined {
  if (threshold.reserveTokens != null) return threshold.reserveTokens;
  if (threshold.compactPercent != null && contextWindow > 0) {
    const pct = threshold.compactPercent;
    if (pct < 1 || pct > 99) return undefined;
    return Math.round(contextWindow * (1 - pct / 100));
  }
  return undefined;
}

/**
 * Resolve the context token count where compaction should trigger.
 * Precedence: reserveTokens > compactAtTokens > compactPercent.
 */
export function resolveTriggerTokens(
  threshold: ModelThreshold,
  contextWindow: number,
): number | undefined {
  if (contextWindow <= 0) return undefined;

  if (threshold.reserveTokens != null) {
    return contextWindow - threshold.reserveTokens;
  }

  if (threshold.compactAtTokens != null) {
    const tokens = threshold.compactAtTokens;
    if (!Number.isFinite(tokens) || tokens < 1) return undefined;
    return Math.round(tokens);
  }

  const reserve = resolveReserveTokens(threshold, contextWindow);
  if (reserve == null) return undefined;
  return contextWindow - reserve;
}

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
};

const readPiCoreCompactionEnabled = (path: string): boolean | undefined => {
  const parsed = readJson(path);
  if (!parsed) return undefined;
  const enabled = (parsed as { compaction?: { enabled?: unknown } }).compaction?.enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
};

/**
 * Read pi-core's effective `compaction.enabled` setting.
 */
export function isPiCoreCompactionEnabled(projectCwd?: string): boolean {
  const globalEnabled = readPiCoreCompactionEnabled(join(getAgentDir(), "settings.json"));
  if (projectCwd) {
    const projectEnabled = readPiCoreCompactionEnabled(join(projectCwd, CONFIG_DIR_NAME, "settings.json"));
    if (typeof projectEnabled === "boolean") return projectEnabled;
  }
  if (typeof globalEnabled === "boolean") return globalEnabled;
  return true;
}

export function loadSettings(): PiVccSettings {
  const parsed = readJson(settingsPath());
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
  const loaded = { ...DEFAULT_SETTINGS, ...(parsed as Partial<PiVccSettings>) };
  if (!loaded.globalThreshold && (parsed as any).defaultThreshold) {
    loaded.globalThreshold = (parsed as any).defaultThreshold;
  }
  return loaded;
}

/**
 * Ensure ~/.pi/agent/pi-vcc-config.json exists with default keys.
 * - File missing → create with full default block.
 * - File exists but invalid JSON → no-op (don't clobber user file).
 * - File exists and valid → fill in missing default keys, preserve existing values.
 */
export function scaffoldSettings(): void {
  try {
    const path = settingsPath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (!existsSync(path)) {
      writeFileSync(path, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
      return;
    }

    const parsed = readJson(path);
    if (!parsed || typeof parsed !== "object") return; // don't clobber

    let changed = false;
    const next: Record<string, unknown> = { ...parsed };
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      if (!(key in next)) {
        next[key] = value;
        changed = true;
      }
    }
    if (changed) writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    // best-effort; never crash extension load
  }
}
