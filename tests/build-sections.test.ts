import { describe, it, expect } from "bun:test";
import { buildSections } from "../src/core/build-sections";
import type { NormalizedBlock } from "../src/types";

describe("buildSections", () => {
  it("returns all-empty for no blocks", () => {
    const r = buildSections({ blocks: [] });
    expect(r.sessionGoal).toEqual([]);
    expect(r.outstandingContext).toEqual([]);
    expect(r.briefTranscript).toBe("");
  });

  it("populates sections from realistic blocks", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix the auth bug" },
      { kind: "tool_call", name: "Read", args: { file_path: "auth.ts" } },
      { kind: "tool_result", name: "Read", text: "const x = 1;" },
      { kind: "tool_call", name: "Edit", args: { file_path: "auth.ts" } },
      { kind: "tool_result", name: "Edit", text: "ok" },
      { kind: "assistant", text: "- run tests next" },
    ];
    const r = buildSections({ blocks });
    expect(r.sessionGoal).toContain("Fix the auth bug");
    expect(r.briefTranscript).toContain('[user]');
    expect(r.briefTranscript).toContain('* Read "auth.ts"');
    expect(r.briefTranscript).toContain('* Edit "auth.ts"');
  });

  it("captures outstanding context from user and assistant text", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "Tests are still failing after the retry." },
    ];
    const r = buildSections({ blocks });
    expect(r.outstandingContext.length).toBeGreaterThan(0);
    expect(r.outstandingContext[0]).toContain("Tests are still failing");
    expect(r.outstandingContext[0]).toContain("[WARN]");
  });

  it("captures bash non-zero exit codes with [ERROR]", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "bash", command: "cargo build", output: "error: could not compile dependencies", exitCode: 101 },
    ];
    const r = buildSections({ blocks });
    expect(r.outstandingContext.length).toBeGreaterThan(0);
    expect(r.outstandingContext[0]).toContain("[ERROR]");
    expect(r.outstandingContext[0]).toContain("bash:exit 101");
    expect(r.outstandingContext[0]).toContain("cargo build");
    expect(r.outstandingContext[0]).toContain("could not compile");
  });

  it("captures typescript compiler errors and tags with [ERROR]", () => {
    const blocks: NormalizedBlock[] = [
      {
        kind: "bash",
        command: "tsc --noEmit",
        output: "src/auth.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
        exitCode: 0,
      },
    ];
    const r = buildSections({ blocks });
    expect(r.outstandingContext.length).toBeGreaterThan(0);
    expect(r.outstandingContext[0]).toContain("[ERROR]");
    expect(r.outstandingContext[0]).toContain("[tsc]");
    expect(r.outstandingContext[0]).toContain("TS2322");
  });

  it("retags tsc errors as [RESOLVED] when file is edited subsequently", () => {
    const blocks: NormalizedBlock[] = [
      {
        kind: "bash",
        command: "tsc --noEmit",
        output: "src/auth.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
        exitCode: 1,
      },
      {
        kind: "tool_call",
        name: "Edit",
        args: { path: "src/auth.ts" },
      },
      {
        kind: "tool_result",
        name: "Edit",
        text: "ok",
      },
    ];
    const r = buildSections({ blocks });
    const tscItem = r.outstandingContext.find((c) => c.includes("[tsc]"));
    expect(tscItem).toBeDefined();
    expect(tscItem).toContain("[RESOLVED]");
  });

  it("captures empty grep and glob results with [INFO]", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "grep", args: { pattern: "verifyToken", path: "src/" } },
      { kind: "tool_result", name: "grep", text: "No matches found", isError: false },
      { kind: "tool_call", name: "glob", args: { pattern: "**/*.proto" } },
      { kind: "tool_result", name: "glob", text: "No files matched.", isError: false },
    ];
    const r = buildSections({ blocks });
    expect(r.outstandingContext.length).toBe(2);
    expect(r.outstandingContext[0]).toContain("[INFO]");
    expect(r.outstandingContext[0]).toContain('[no matches] grep "verifyToken"');
    expect(r.outstandingContext[1]).toContain("[INFO]");
    expect(r.outstandingContext[1]).toContain('[no matches] glob "**/*.proto"');
  });

  it("captures test failures in bash output as [WARN] [tests]", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "bash", command: "bun test", output: "bun test v1.4.0\n2 failed\nFAIL auth.test.ts", exitCode: 1 },
    ];
    const r = buildSections({ blocks });
    expect(r.outstandingContext.length).toBe(1);
    expect(r.outstandingContext[0]).toContain("[WARN]");
    expect(r.outstandingContext[0]).toContain("[tests]");
    expect(r.outstandingContext[0]).toContain("2 failed");
    expect(r.outstandingContext[0]).not.toContain("bun test v1.4.0");
  });

  it("does not classify a successful bun test summary as a failure", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "bash", command: "bun test", output: "bun test v1.4.0\n 338 pass\n 0 fail", exitCode: 0 },
    ];
    expect(buildSections({ blocks }).outstandingContext).toEqual([]);
  });

  it("respects the 8KB scan limit for errors in large bash output", () => {
    const padding = "x".repeat(10_000) + "\n";
    const blocks: NormalizedBlock[] = [
      {
        kind: "bash",
        command: "cat large.log",
        output: padding + "src/auth.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
        exitCode: 0,
      },
    ];
    const r = buildSections({ blocks });
    // Error is past 8KB limit, so it should not be picked up
    expect(r.outstandingContext.length).toBe(0);
  });

  it("pairs empty search results only with the matching tool name (case-insensitive)", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_call", name: "Grep", args: { pattern: "firstSearch" } },
      { kind: "tool_call", name: "Glob", args: { glob: "*.ts" } },
      { kind: "tool_result", name: "grep", text: "No matches found" },
    ];
    const r = buildSections({ blocks });
    expect(r.outstandingContext.length).toBe(1);
    expect(r.outstandingContext[0]).toContain('[no matches] grep "firstSearch"');
    expect(r.outstandingContext[0]).not.toContain("*.ts");
  });

  it("caps outstanding context items at 8", () => {
    const blocks: NormalizedBlock[] = Array.from({ length: 15 }, (_, i) => ({
      kind: "tool_result",
      name: `tool_${i}`,
      text: `Error occurrence ${i}`,
      isError: true,
    }));
    const r = buildSections({ blocks });
    expect(r.outstandingContext.length).toBe(8);
  });

  it("brief transcript hides tool results", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "tool_result", name: "Read", text: "lots of code here ..." },
      { kind: "tool_result", name: "bash", text: "Command not found" },
    ];
    const r = buildSections({ blocks });
    expect(r.briefTranscript).toBe("");
  });

  it("brief transcript merges adjacent assistant sections", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "assistant", text: "Part one." },
      { kind: "tool_call", name: "Read", args: { file_path: "a.ts" } },
      { kind: "assistant", text: "Part two." },
    ];
    const r = buildSections({ blocks });
    const matches = r.briefTranscript.match(/\[assistant\]/g);
    expect(matches?.length).toBe(1);
  });
});
