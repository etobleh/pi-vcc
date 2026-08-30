import { describe, it, expect } from "bun:test";
import { join } from "path";
import { readFileSync } from "fs";
import { loadAllMessages } from "../src/core/load-messages";
import { buildGlobalIndexMap } from "../src/core/lineage";
import { compileRanked } from "../src/core/summarize";
import { normalize } from "../src/core/normalize";
import { filterNoise } from "../src/core/filter-noise";
import { toLiveMessage } from "../src/hooks/before-compact";

describe("pi session fixture integration (D1, D2, D3, D4, D8)", () => {
  const fixturePath = join(__dirname, "fixtures/pi-session.jsonl");
  const rawContent = readFileSync(fixturePath, "utf-8");
  const entries = rawContent
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));

  it("loadAllMessages only indexes type === 'message' entries", () => {
    const loaded = loadAllMessages(fixturePath, false);
    // There are 9 message entries in the fixture (e1, e2, e3, e4, e8, e9, e10, e11, e12, e13)
    expect(loaded.rawMessages).toHaveLength(10);
    // First message (e1) is index 0
    expect(loaded.rendered[0].index).toBe(0);
    // Check bashExecution entry e4 (global index 3)
    expect(loaded.rendered[3].index).toBe(3);
    // Check e8 (after compaction e6 and branch_summary e7) has global index 4
    expect(loaded.rendered[4].index).toBe(4);
  });

  it("buildGlobalIndexMap matches loadAllMessages indexing exactly (D3)", () => {
    const loaded = loadAllMessages(fixturePath, false);
    const indexMap = buildGlobalIndexMap(entries);

    expect(indexMap.get("e1")).toBe(0);
    expect(indexMap.get("e2")).toBe(1);
    expect(indexMap.get("e3")).toBe(2);
    expect(indexMap.get("e4")).toBe(3);
    // Non-message entries are not in indexMap
    expect(indexMap.get("e5")).toBeUndefined(); // custom_message
    expect(indexMap.get("e6")).toBeUndefined(); // compaction
    expect(indexMap.get("e7")).toBeUndefined(); // branch_summary
    // Next message entry e8 gets global index 4
    expect(indexMap.get("e8")).toBe(4);
    expect(indexMap.get("e11")).toBe(7); // git commit
    expect(indexMap.get("e12")).toBe(8);
    expect(indexMap.get("e13")).toBe(9);
  });

  it("normalizing preserves custom and branch_summary roles without flattening to user (D2)", () => {
    const live = entries
      .map((e) => ({ entry: e, message: toLiveMessage(e) }))
      .filter((e) => e.message != null);

    const blocks = normalize(live);
    const kinds = blocks.map((b) => b.kind);

    expect(kinds).toContain("custom");
    expect(kinds).toContain("branch_summary");
    expect(kinds).toContain("bash");

    const customBlock = blocks.find((b) => b.kind === "custom");
    expect(customBlock).toMatchObject({
      kind: "custom",
      customType: "vcc-recall",
    });

    const branchBlock = blocks.find((b) => b.kind === "branch_summary");
    expect(branchBlock).toMatchObject({
      kind: "branch_summary",
      text: "Explored alternative auth design",
    });
  });

  it("filterNoise drops vcc-recall custom message and avoids polluting summary (D1, D2)", () => {
    const live = entries
      .map((e) => ({ entry: e, message: toLiveMessage(e) }))
      .filter((e) => e.message != null);

    const blocks = filterNoise(normalize(live));
    // vcc-recall customType must be filtered out
    expect(blocks.some((b) => b.kind === "custom" && b.customType === "vcc-recall")).toBe(false);
  });

  it("summary produces correct (#N) refs and does not mine recall dump or bash for goals (D2, D3, D4, D8)", () => {
    const indexMap = buildGlobalIndexMap(entries);
    const live = entries
      .map((e) => ({ entry: e, message: toLiveMessage(e) }))
      .filter((e) => e.message != null);

    const summary = compileRanked({
      messages: live,
      globalIndexMap: indexMap,
    });

    // Session goal must NOT contain text from vcc-recall dump ("fix everything always")
    expect(summary).not.toContain("fix everything always");

    // Must contain git commit extracted from bash execution (D8)
    expect(summary).toContain("refactor auth to JWT");

    // Tool grep must render pattern in path (D4)
    expect(summary).toContain('* grep "TODO" in src');

    // Global message references (#0, #4, #7, etc.) match global index
    expect(summary).toContain("(#0)");
    expect(summary).toContain("(#4)");
  });
});
