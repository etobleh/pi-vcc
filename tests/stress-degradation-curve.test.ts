import { describe, it, expect } from "bun:test";
import { compile } from "../src/core/summarize";

const FILES = [
  "src/auth.ts", "src/users.ts", "src/api.ts", "src/db.ts",
  "src/utils.ts", "src/config.ts", "src/routes.ts", "src/middleware.ts",
  "src/models.ts", "src/services.ts", "src/handlers.ts", "src/types.ts",
];

const GOALS = [
  "Build an authentication system",
  "Add user management endpoints",
  "Create the REST API layer",
  "Set up the database connection pool",
  "Implement utility functions",
  "Load configuration from environment",
  "Define route handlers",
  "Add authentication middleware",
  "Create data models",
  "Build the service layer",
];

const makeRound = (i: number): any[] => {
  const file1 = FILES[i % FILES.length];
  const file2 = FILES[(i + 5) % FILES.length];
  const goal = GOALS[i % GOALS.length];
  const id1 = `r${i}-1`, id2 = `r${i}-2`, id3 = `r${i}-3`;
  const msgs: any[] = [
    { role: "user", content: goal },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "Edit",
          id: id1,
          arguments: {
            file_path: file1,
            oldText: "// placeholder",
            newText: `export function fn${i}() { return ${i}; }`,
          },
        },
      ],
    },
    { role: "toolResult", toolCallId: id1, toolName: "Edit", content: "OK" },
    { role: "assistant", content: `The issue was missing fn${i}. Resolved by implementing fn${i}. Edited ${file1}.` },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "Read",
          id: id2,
          arguments: { file_path: file2 },
        },
      ],
    },
    { role: "toolResult", toolCallId: id2, toolName: "Read", content: `// ${file2}\nexport const DATA = ${i};` },
  ];
  if (i % 2 === 0) {
    msgs.push(
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            name: "bash",
            id: id3,
            arguments: { command: `git commit -m "feat: ${goal.toLowerCase()}"` },
          },
        ],
      },
      { role: "toolResult", toolCallId: id3, toolName: "bash", content: `[main abc${String(i).padStart(4, "0")}] feat` },
    );
  }
  return msgs;
};

describe("Degradation curve and multi-round compaction stress test", () => {
  it("maintains bounded summary size and section invariants over 20 sequential compactions", () => {
    let summary = "";

    for (let round = 0; round < 20; round++) {
      const msgs = makeRound(round);
      summary = compile({ messages: msgs, previousSummary: summary || undefined });

      expect(summary.length).toBeGreaterThan(0);

      // Preamble appears exactly once at the top
      const preambleCount = (summary.match(/This summary captures work done before/g) ?? []).length;
      expect(preambleCount).toBe(1);
      expect(summary.indexOf("This summary captures work done before")).toBe(0);

      // Section order is invariant
      const goalIdx = summary.indexOf("[Session Goal]");
      const prefIdx = summary.indexOf("[User Preferences]");
      const filesIdx = summary.indexOf("[Files And Changes]");
      const commitsIdx = summary.indexOf("[Commits]");

      if (goalIdx >= 0 && filesIdx >= 0) expect(goalIdx).toBeLessThan(filesIdx);
      if (filesIdx >= 0 && commitsIdx >= 0) expect(filesIdx).toBeLessThan(commitsIdx);

      // Breadcrumb lines do not duplicate preamble or stack unboundedly
      const breadcrumbLines = summary.split("\n").filter((l) => l.startsWith("- ...recall:"));
      expect(breadcrumbLines.length).toBeLessThanOrEqual(15);

      // Total summary length stays bounded
      expect(summary.length).toBeLessThan(20_000);
    }
  });
});
