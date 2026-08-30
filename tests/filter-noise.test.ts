import { describe, it, expect } from "bun:test";
import { filterNoise } from "../src/core/filter-noise";
import type { NormalizedBlock } from "../src/types";

describe("filterNoise", () => {
  it("removes pi-native noise tool calls and results (vcc_recall)", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "vcc_recall", args: { query: "auth" } },
      { kind: "tool_result", name: "vcc_recall", text: "recall dump..." },
      { kind: "tool_call", name: "read", args: { path: "x.ts" } },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "tool_call", name: "read", args: { path: "x.ts" } });
  });

  it("removes pi-native noise custom types (vcc-recall, pi-vcc-auto-continue)", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "custom", customType: "vcc-recall", text: "large recall dump" },
      { kind: "custom", customType: "pi-vcc-auto-continue", text: "Continue" },
      { kind: "custom", customType: "other-extension", text: "extension context" },
      { kind: "user", text: "Fix the bug" },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ kind: "custom", customType: "other-extension", text: "extension context" });
    expect(result[1]).toEqual({ kind: "user", text: "Fix the bug" });
  });

  it("removes thinking blocks from summary blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "thinking", text: "reasoning about approach" },
      { kind: "assistant", text: "Here is the plan" },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "assistant", text: "Here is the plan" });
  });

  it("removes empty user blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "   \n  " },
      { kind: "user", text: "real task" },
    ];
    const result = filterNoise(blocks);
    expect(result).toHaveLength(1);
    expect((result[0] as any).text).toBe("real task");
  });

  it("supports configurable extra noise tools and custom types", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "my_custom_tool", args: {} },
      { kind: "custom", customType: "my_custom_ext", text: "noise" },
      { kind: "tool_call", name: "read", args: { path: "main.ts" } },
    ];
    const result = filterNoise(blocks, {
      extraNoiseTools: ["my_custom_tool"],
      extraNoiseCustomTypes: ["my_custom_ext"],
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ kind: "tool_call", name: "read", args: { path: "main.ts" } });
  });

  it("preserves non-noise tool calls and user turns", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "edit", args: { path: "a.ts" } },
      { kind: "tool_result", name: "edit", text: "ok" },
      { kind: "bash", command: "bun test", output: "pass", exitCode: 0 },
    ];
    expect(filterNoise(blocks)).toHaveLength(3);
  });
});
