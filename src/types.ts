import type { Message } from "@earendil-works/pi-ai";

export type CompactionReason = "manual" | "threshold" | "overflow";

export interface FileOps {
  readFiles?: string[];
  modifiedFiles?: string[];
  createdFiles?: string[];
}

export type NormalizedBlock =
  | { kind: "user"; text: string; sourceIndex?: number }
  | { kind: "assistant"; text: string; sourceIndex?: number }
  | { kind: "tool_call"; name: string; args: Record<string, unknown>; sourceIndex?: number }
  | { kind: "tool_result"; name?: string; text: string; isError?: boolean; sourceIndex?: number }
  | { kind: "bash"; command: string; output: string; exitCode: number | undefined; sourceIndex?: number }
  | { kind: "thinking"; text: string; redacted?: boolean; sourceIndex?: number }
  | { kind: "custom"; customType: string; text: string; sourceIndex?: number }
  | { kind: "branch_summary"; text: string; sourceIndex?: number };
