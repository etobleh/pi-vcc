import { compile } from "../src/core/summarize";

const FILES = [
  "src/auth.ts", "src/users.ts", "src/api.ts", "src/db.ts",
  "src/utils.ts", "src/config.ts", "src/routes.ts", "src/middleware.ts",
  "src/models.ts", "src/services.ts", "src/handlers.ts", "src/types.ts",
  "src/errors.ts", "src/validators.ts", "src/cache.ts", "src/logger.ts",
  "src/session.ts", "src/token.ts", "src/oauth.ts", "src/crypto.ts",
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
  "Implement request handlers",
  "Add TypeScript type definitions",
  "Create error handling utilities",
  "Build input validators",
  "Add caching layer",
  "Set up structured logging",
  "Implement session management",
  "Add JWT token handling",
  "Build OAuth2 integration",
  "Add cryptographic utilities",
  "Refactor auth to support SSO",
  "Add rate limiting to API",
  "Migrate database to PostgreSQL",
  "Add integration tests",
  "Set up CI pipeline",
];

const makeRound = (i: number): any[] => {
  const file1 = FILES[i % FILES.length];
  const file2 = FILES[(i + 7) % FILES.length];
  const goal = GOALS[i % GOALS.length];
  const id1 = `r${i}-1`, id2 = `r${i}-2`, id3 = `r${i}-3`;
  const msgs: any[] = [
    { role: "user", content: goal },
    { role: "assistant", content: [{ type: "toolCall", name: "Edit", id: id1, arguments: { file_path: file1, oldText: "// placeholder", newText: `export function fn${i}() { return ${i}; }` } }] },
    { role: "toolResult", toolCallId: id1, toolName: "Edit", content: "OK" },
    { role: "assistant", content: `Edited ${file1} with function fn${i}.` },
    { role: "assistant", content: [{ type: "toolCall", name: "read", id: id2, arguments: { file_path: file2 } }] },
    { role: "toolResult", toolCallId: id2, toolName: "read", content: `// ${file2}\nexport const DATA = ${i};` },
    { role: "assistant", content: `Read ${file2} to understand the interface.` },
  ];
  if (i % 3 === 0) {
    msgs.push(
      { role: "assistant", content: [{ type: "toolCall", name: "bash", id: id3, arguments: { command: `git commit -m "feat: ${goal.toLowerCase()}" ` } }] },
      { role: "toolResult", toolCallId: id3, toolName: "bash", content: `[main abc${String(i).padStart(4, "0")}] feat: ${goal.toLowerCase()}` },
      { role: "assistant", content: `Committed: feat: ${goal.toLowerCase()}.` },
    );
  }
  return msgs;
};

let prev = "";
for (let round = 0; round < 20; round++) {
  const msgs = makeRound(round);
  prev = compile({ messages: msgs, previousSummary: prev || undefined }) || "";
  console.log(`Round ${round + 1}: summary length ${prev.length} chars`);
}
