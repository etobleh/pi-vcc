import { describe, it, expect } from "bun:test";
import {
  countPiVccCompactions,
  countPiVccCompactionsFromSession,
  ordinalSuffix,
} from "../src/core/compaction-count";
import { formatCompactionStats } from "../src/hooks/before-compact";

describe("ordinalSuffix", () => {
  it("returns correct suffix for single digits", () => {
    expect(ordinalSuffix(1)).toBe("st");
    expect(ordinalSuffix(2)).toBe("nd");
    expect(ordinalSuffix(3)).toBe("rd");
    expect(ordinalSuffix(4)).toBe("th");
  });

  it("handles 11th, 12th, 13th exceptions", () => {
    expect(ordinalSuffix(11)).toBe("th");
    expect(ordinalSuffix(12)).toBe("th");
    expect(ordinalSuffix(13)).toBe("th");
    expect(ordinalSuffix(111)).toBe("th");
    expect(ordinalSuffix(112)).toBe("th");
    expect(ordinalSuffix(113)).toBe("th");
  });

  it("handles 21st, 22nd, 23rd", () => {
    expect(ordinalSuffix(21)).toBe("st");
    expect(ordinalSuffix(22)).toBe("nd");
    expect(ordinalSuffix(23)).toBe("rd");
    expect(ordinalSuffix(101)).toBe("st");
  });
});

describe("countPiVccCompactions", () => {
  it("returns 0 for empty entries", () => {
    expect(countPiVccCompactions([])).toBe(0);
  });

  it("counts only pi-vcc compactor entries", () => {
    const entries = [
      { type: "message", id: "1" },
      { type: "compaction", details: { compactor: "pi-vcc" } },
      { type: "message", id: "2" },
      { type: "compaction", details: { compactor: "core" } },
      { type: "compaction", details: { compactor: "pi-vcc" } },
    ];
    expect(countPiVccCompactions(entries)).toBe(2);
  });
});

describe("countPiVccCompactionsFromSession", () => {
  it("extracts from sessionManager safely", () => {
    const sm = {
      getEntries: () => [
        { type: "compaction", details: { compactor: "pi-vcc" } },
        { type: "compaction", details: { compactor: "pi-vcc" } },
        { type: "compaction", details: { compactor: "pi-vcc" } },
      ],
    };
    expect(countPiVccCompactionsFromSession(sm)).toBe(3);
    expect(countPiVccCompactionsFromSession(undefined)).toBe(0);
    expect(countPiVccCompactionsFromSession({ getEntries: () => { throw new Error("fail"); } })).toBe(0);
  });
});

describe("formatCompactionStats with ordinal", () => {
  it("formats stats with compaction ordinal label", () => {
    const stats = {
      summarized: 10,
      kept: 2,
      keptUserTurns: 1,
      totalUserTurns: 3,
      requestedKeepUserTurns: 1,
      keepUserTurnsExplicit: false,
      keepFallbackToCompactAll: false,
      keptTokensEst: 500,
    };
    const out = formatCompactionStats(stats, 3);
    expect(out).toContain("(3rd compaction)");
  });
});
