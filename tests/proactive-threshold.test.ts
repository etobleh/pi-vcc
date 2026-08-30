import { describe, it, expect, beforeEach } from "bun:test";
import {
  getModelThreshold,
  resolveReserveTokens,
  resolveTriggerTokens,
  type PiVccSettings,
  type ModelThreshold,
} from "../src/core/settings";
import {
  checkAndTrigger,
  isProactiveTriggerActive,
  resetProactiveState,
} from "../src/hooks/proactive-threshold";

describe("getModelThreshold resolution", () => {
  const settings: PiVccSettings = {
    overrideDefaultCompaction: true,
    smartKeepTail: true,
    continueAfterThresholdCompact: false,
    debug: false,
    modelThresholds: {
      "anthropic/claude-3-5-sonnet": { compactPercent: 85 },
      "GLM-5.1-FP8": { compactPercent: 50 },
    },
    globalThreshold: { compactPercent: 75 },
  };

  it("matches exact provider/modelId first", () => {
    const t = getModelThreshold(settings, { id: "claude-3-5-sonnet", provider: "anthropic" });
    expect(t?.compactPercent).toBe(85);
  });

  it("matches modelId second", () => {
    const t = getModelThreshold(settings, { id: "GLM-5.1-FP8", provider: "neuralwatt" });
    expect(t?.compactPercent).toBe(50);
  });

  it("falls back to globalThreshold when model does not match", () => {
    const t = getModelThreshold(settings, { id: "gpt-4o", provider: "openai" });
    expect(t?.compactPercent).toBe(75);
  });

  it("returns globalThreshold when model is undefined", () => {
    const t = getModelThreshold(settings, undefined);
    expect(t?.compactPercent).toBe(75);
  });
});

describe("resolveTriggerTokens precedence", () => {
  it("prioritizes reserveTokens over compactAtTokens and compactPercent", () => {
    const t: ModelThreshold = {
      reserveTokens: 10_000,
      compactAtTokens: 50_000,
      compactPercent: 80,
    };
    const trigger = resolveTriggerTokens(t, 100_000);
    // contextWindow - reserveTokens = 90_000
    expect(trigger).toBe(90_000);
  });

  it("prioritizes compactAtTokens over compactPercent", () => {
    const t: ModelThreshold = {
      compactAtTokens: 60_000,
      compactPercent: 80,
    };
    const trigger = resolveTriggerTokens(t, 100_000);
    expect(trigger).toBe(60_000);
  });

  it("uses compactPercent when other options are omitted", () => {
    const t: ModelThreshold = {
      compactPercent: 70,
    };
    const trigger = resolveTriggerTokens(t, 100_000);
    // 70% of 100k = 70k
    expect(trigger).toBe(70_000);
  });

  it("returns undefined for invalid contextWindow or empty threshold", () => {
    expect(resolveTriggerTokens({}, 100_000)).toBeUndefined();
    expect(resolveTriggerTokens({ compactPercent: 50 }, 0)).toBeUndefined();
  });
});

describe("proactive threshold triggering", () => {
  beforeEach(() => {
    resetProactiveState();
  });

  it("triggers compaction when usage exceeds threshold and sets proactiveTriggerActive", () => {
    let compactCalled = false;
    let notifyMessage = "";
    const ctx = {
      model: { id: "test-model", contextWindow: 100_000 },
      getContextUsage: () => ({ tokens: 80_000 }),
      compact: () => { compactCalled = true; },
      ui: { notify: (msg: string) => { notifyMessage = msg; } },
    };

    const tmpConfig = `/tmp/test-pi-vcc-${Date.now()}.json`;
    require("fs").writeFileSync(tmpConfig, JSON.stringify({
      globalThreshold: { compactPercent: 75 },
    }));
    process.env.PI_VCC_CONFIG_PATH = tmpConfig;

    checkAndTrigger(ctx, "auto");
    expect(compactCalled).toBe(true);
    expect(isProactiveTriggerActive()).toBe(true);
    expect(notifyMessage).toContain("80%");

    // Calling again immediately should be blocked by cooldown
    compactCalled = false;
    checkAndTrigger(ctx, "auto");
    expect(compactCalled).toBe(false);

    try { require("fs").unlinkSync(tmpConfig); } catch {}
    delete process.env.PI_VCC_CONFIG_PATH;
  });
});
