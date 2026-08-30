import { describe, it, expect } from "bun:test";
import { compile } from "../src/core/summarize";
import { extractCausalChain, identifyTurns } from "../src/core/brief";
import { buildSections } from "../src/core/build-sections";
import type { NormalizedBlock } from "../src/types";
import { userMsg } from "./fixtures";

describe("extractCausalChain", () => {
  it("extracts cause and resolution from assistant text", () => {
    const text = "The issue is a race condition in session auth. I fixed it by adding a mutex guard.";
    const chain = extractCausalChain(text);
    expect(chain.cause).toContain("race condition");
    expect(chain.resolution).toContain("a mutex guard");
  });

  it("handles text with no causal markers", () => {
    const text = "All tests passed successfully.";
    const chain = extractCausalChain(text);
    expect(chain.cause).toBeNull();
    expect(chain.resolution).toBeNull();
  });
});

describe("identifyTurns", () => {
  it("synthesizes causal turn summaries into goal → cause → resolution → actions", () => {
    const blocks: NormalizedBlock[] = [
      { kind: "user", text: "Fix the race condition in auth.ts" },
      { kind: "tool_call", name: "Edit", args: { path: "src/auth.ts" } },
      { kind: "tool_result", name: "Edit", text: "ok" },
      { kind: "assistant", text: "The bug was missing locking on token refresh. Resolved by wrapping token refresh in a mutex." },
    ];
    const turns = identifyTurns(blocks);
    expect(turns.length).toBe(1);
    expect(turns[0].summary).toContain("Fix the race condition");
    expect(turns[0].summary).toContain("missing locking");
    expect(turns[0].summary).toContain("token refresh in a mutex");
    expect(turns[0].summary).toContain("edited src/auth.ts");
  });
});

describe("breadcrumbs: mergeHeaderSection", () => {
  it("leaves recall breadcrumbs when Session Goal exceeds cap", () => {
    const goals = Array.from({ length: 10 }, (_, i) =>
      `- Implement feature ${i}: auth${i} module`
    ).join("\n");
    const prevSummary = `[Session Goal]\n${goals}\n\n---\n\n[user]\nhi`;
    const r = compile({
      messages: [userMsg("continue")],
      previousSummary: prevSummary,
    });
    expect(r).toContain("...recall:");
    expect(r).toContain("auth0");
    expect(r).toContain("auth1");
    expect(r).toContain("feature 9");
    expect(r).not.toContain("Implement feature 0: auth0 module");
  });

  it("leaves breadcrumbs for Earlier Turns when cap exceeded", () => {
    const turns = Array.from({ length: 20 }, (_, i) =>
      `- Fix bug ${i} → missing lock → added mutex → edited bug${i}.ts`
    ).join("\n");
    const prevSummary = `[Earlier Turns]\n${turns}\n\n---\n\n[user]\nhi`;
    const r = compile({
      messages: [userMsg("next")],
      previousSummary: prevSummary,
    });
    expect(r).toContain("...recall:");
    expect(r).toContain("bug0.ts|mutex");
  });
});

describe("breadcrumbs: mergeFileLines (+recall:)", () => {
  it("replaces omitted items with +recall: listing omitted paths", () => {
    const paths = Array.from({ length: 12 }, (_, i) => `src/mod${i}.ts`);
    const prevSummary = [
      "[Files And Changes]",
      `- Modified: ${paths.join(", ")}`,
    ].join("\n") + "\n\n---\n\n[user]\ngo";
    const r = compile({
      messages: [userMsg("continue")],
      previousSummary: prevSummary,
    });
    expect(r).toContain("+recall:");
    expect(r).toContain("mod10.ts");
    expect(r).toContain("mod11.ts");
  });

  it("breadcrumb paths are parseable on next compaction", () => {
    const prevSummary = [
      "[Files And Changes]",
      `- Modified: src/mod0.ts, src/mod1.ts, +recall: src/mod2.ts`,
    ].join("\n") + "\n\n---\n\n[user]\ngo";
    const r = compile({
      messages: [userMsg("continue")],
      previousSummary: prevSummary,
    });
    expect(r).toContain("mod2.ts");
  });
});
