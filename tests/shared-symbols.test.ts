import { describe, it, expect } from "bun:test";
import { buildSections } from "../src/core/build-sections";
import { formatSummary } from "../src/core/format";
import { compile } from "../src/core/summarize";
import type { NormalizedBlock } from "../src/types";

describe("type catalog extraction", () => {
  it("extracts exported signatures from modified TypeScript files", () => {
    const blocks: NormalizedBlock[] = [
      {
        kind: "tool_call",
        name: "Edit",
        args: { file_path: "src/auth.ts", newText: "export function login(email: string): Promise<Session> {}\nexport interface Session { id: string; }" },
      },
      { kind: "tool_result", name: "Edit", text: "ok" },
    ];
    const r = buildSections({ blocks });
    expect(r.typeCatalog).toBeDefined();
    expect(r.typeCatalog!.length).toBeGreaterThan(0);
    expect(r.typeCatalog!.some((l) => l.includes("src/auth.ts:"))).toBe(true);
    expect(r.typeCatalog!.some((l) => l.includes("login"))).toBe(true);
    expect(r.typeCatalog!.some((l) => l.includes("interface Session"))).toBe(true);
  });

  it("extracts signatures from Read results", () => {
    const blocks: NormalizedBlock[] = [
      {
        kind: "tool_call",
        name: "Read",
        args: { file_path: "src/types.ts" },
      },
      {
        kind: "tool_result",
        name: "Read",
        text: "export type UserRole = 'admin' | 'user';\nexport class Account {}",
      },
    ];
    const r = buildSections({ blocks });
    expect(r.typeCatalog!.some((l) => l.includes("src/types.ts:"))).toBe(true);
    expect(r.typeCatalog!.some((l) => l.includes("type UserRole"))).toBe(true);
    expect(r.typeCatalog!.some((l) => l.includes("class Account"))).toBe(true);
  });

  it("caps total signatures at 30 with file omission notice", () => {
    const blocks: NormalizedBlock[] = [];
    for (let i = 0; i < 10; i++) {
      blocks.push({
        kind: "tool_call",
        name: "Read",
        args: { file_path: `src/mod${i}.ts` },
      });
      const sigs = Array.from({ length: 6 }, (_, j) => `export function fn${i}_${j}(): void;`).join("\n");
      blocks.push({
        kind: "tool_result",
        name: "Read",
        text: sigs,
      });
    }
    const r = buildSections({ blocks });
    const totalSigs = r.typeCatalog!.filter((l) => l.startsWith("  ")).length;
    expect(totalSigs).toBeLessThanOrEqual(30);
    expect(r.typeCatalog!.some((l) => l.includes("more files with signatures omitted"))).toBe(true);
  });
});

describe("symbolChanges tracking", () => {
  it("tracks access kind (modified vs read) per symbol", () => {
    const blocks: NormalizedBlock[] = [
      {
        kind: "tool_call",
        name: "Read",
        args: { file_path: "src/config.ts" },
      },
      {
        kind: "tool_result",
        name: "Read",
        text: "export const DEFAULT_PORT = 3000;",
      },
      {
        kind: "tool_call",
        name: "Edit",
        args: { file_path: "src/server.ts", newText: "export function startServer() {}" },
      },
      { kind: "tool_result", name: "Edit", text: "ok" },
    ];
    const r = buildSections({ blocks });
    expect(r.symbolChanges).toBeDefined();
    const portSym = r.symbolChanges!.find((s) => s.name === "DEFAULT_PORT");
    const serverSym = r.symbolChanges!.find((s) => s.name === "startServer");
    expect(portSym?.access).toBe("read");
    expect(serverSym?.access).toBe("modified");
  });
});

describe("Type Catalog format and merge integration", () => {
  it("includes Type Catalog in formatSummary and treats it as volatile on merge", () => {
    const blocks: NormalizedBlock[] = [
      {
        kind: "tool_call",
        name: "Read",
        args: { file_path: "src/types.ts" },
      },
      {
        kind: "tool_result",
        name: "Read",
        text: "export interface User { id: string; }",
      },
    ];
    const r = buildSections({ blocks });
    const formatted = formatSummary(r);
    expect(formatted).toContain("[Type Catalog]");
    expect(formatted).toContain("src/types.ts:");
    expect(formatted).toContain("interface User");

    // Type Catalog should be fresh-only across compactions
    const prev = "[Session Goal]\n- goal\n\n[Type Catalog]\nsrc/old.ts:\n  export function oldFn(): void\n\n---\n\n[user]\nhi";
    const merged = compile({
      previousSummary: prev,
      messages: [],
    });
    expect(merged).not.toContain("oldFn");
  });
});
