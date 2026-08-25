import { describe, it, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { registerRecallTool } from "../src/tools/recall";

// ── Helpers (mirrors tests/recall-tool-scope.test.ts) ──────────────────────

const userMsg = (id: string, content: string) => ({
  type: "message",
  id,
  message: { role: "user", content },
});

let dirCount = 0;
const makeSession = (n: number, textOf: (i: number) => string) => {
  const dir = mkdtempSync(join(tmpdir(), `pi-vcc-recall-quality-${dirCount++}-`));
  const file = join(dir, "session.jsonl");
  const ids = Array.from({ length: n }, (_, i) => `m${i}`);
  const lines = ids.map((id, i) => JSON.stringify(userMsg(id, textOf(i))));
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return { dir, file, ids };
};

const register = () => {
  let tool: any;
  registerRecallTool({ registerTool: (t: any) => { tool = t; } } as any);
  return tool;
};

const invoke = async (tool: any, file: string, ids: string[], params: Record<string, unknown>) => {
  const result = await tool.execute("tool-call", params, undefined, undefined, {
    sessionManager: {
      getSessionFile: () => file,
      getBranch: () => ids.map((id) => ({ id })),
      getEntries: () => ids.map((id) => ({ id })),
    },
  });
  return result.content[0].text as string;
};

describe("vcc_recall pagination and hard-cap truncation signaling", () => {
  it("reports a capped page count and an explicit truncation message when raw hits exceed the cap", async () => {
    // "." makes this a regex-mode query, matching every one of the 60
    // messages deterministically (no BM25/floor involved) — isolates the
    // hard cap's effect on the tool-facing header/footer.
    const { dir, file, ids } = makeSession(60, (i) => `zebra_query_tag entry number ${i}`);
    try {
      const tool = register();
      const output = await invoke(tool, file, ids, { query: "zebra_query_tag.*entry" });

      // 60 raw matches capped to 50 → 10 pages of 5.
      expect(output).toContain("Page 1/10");
      expect(output).toContain("50 total matches");
      // Truthful truncation signal: must not claim 50 is the whole story.
      // Neutral wording ("showing", not "showing top") — this is the regex
      // path, which has no relevance ranking, so "top" would be a false claim.
      expect(output).toContain("showing 50 of 60 matches");
      expect(output).not.toContain("showing top");
      expect(output).toContain("refine your query");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not show a truncation message when raw hits are under the cap", async () => {
    const { dir, file, ids } = makeSession(3, (i) => `zebra_query_tag entry number ${i}`);
    try {
      const tool = register();
      const output = await invoke(tool, file, ids, { query: "zebra_query_tag.*entry" });

      expect(output).toContain("3 matches");
      expect(output).not.toContain("showing");
      expect(output).not.toContain("refine your query");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports an explicit out-of-range page instead of a false 'no matches' when hits exist but the page isn't reachable", async () => {
    // 60 raw matches capped to 50 → pages 1-10 exist. Page 11 has no rows to
    // slice, but hits.length (50) is > 0 — must not claim "No matches".
    const { dir, file, ids } = makeSession(60, (i) => `zebra_query_tag entry number ${i}`);
    try {
      const tool = register();
      const output = await invoke(tool, file, ids, { query: "zebra_query_tag.*entry", page: 11 });

      expect(output).toContain("Page 11 is outside the available range 1-10");
      expect(output).toContain("50 matches");
      expect(output).not.toContain("No matches");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps normal zero-hit behavior unchanged for an out-of-range page with no matches at all", async () => {
    const { dir, file, ids } = makeSession(3, (i) => `entry number ${i}`);
    try {
      const tool = register();
      const output = await invoke(tool, file, ids, { query: "NO_SUCH_MARKER_ANYWHERE", page: 5 });

      expect(output).toContain("No matches");
      expect(output).not.toContain("is outside the available range");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
