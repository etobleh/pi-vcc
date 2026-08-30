import type { Message } from "@earendil-works/pi-ai";
import type { NormalizedBlock } from "../types";
import { textOf } from "./content";
import { sanitize } from "./sanitize";

const normalizeOne = (msg: any, msgIndex?: number): NormalizedBlock[] => {
  if (!msg || typeof msg !== "object") return [];

  if (msg.role === "user") {
    const blocks: NormalizedBlock[] = [];
    const text = sanitize(textOf(msg.content));
    if (text) blocks.push({ kind: "user", text, sourceIndex: msgIndex });
    if (msg.content && typeof msg.content !== "string") {
      for (const part of msg.content) {
        if (part.type === "image") {
          blocks.push({ kind: "user", text: `[image: ${part.mimeType}]`, sourceIndex: msgIndex });
        }
      }
    }
    return blocks.length > 0 ? blocks : [{ kind: "user", text: "", sourceIndex: msgIndex }];
  }

  if (msg.role === "bashExecution") {
    const cmd = msg.command ?? "";
    const out = msg.output ?? "";
    const exit = msg.exitCode;
    return [{ kind: "bash", command: cmd, output: out, exitCode: exit, sourceIndex: msgIndex }];
  }

  if (msg.role === "custom") {
    const customType = msg.customType ?? "";
    const text = sanitize(textOf(msg.content));
    return [{ kind: "custom", customType, text, sourceIndex: msgIndex }];
  }

  if (msg.role === "branchSummary") {
    const text = sanitize(msg.summary ?? textOf(msg.content));
    return [{ kind: "branch_summary", text, sourceIndex: msgIndex }];
  }

  if (msg.role === "toolResult") {
    const block: NormalizedBlock = {
      kind: "tool_result",
      name: msg.toolName,
      text: sanitize(textOf(msg.content)),
      sourceIndex: msgIndex,
    };
    if (Boolean((msg as any).isError)) block.isError = true;
    return [block];
  }

  if (msg.role === "assistant") {
    if (!msg.content) return [];
    if (typeof msg.content === "string") {
      return [{ kind: "assistant", text: sanitize(msg.content), sourceIndex: msgIndex }];
    }

    const blocks: NormalizedBlock[] = [];
    for (const part of msg.content) {
      if (part.type === "text") {
        blocks.push({ kind: "assistant", text: sanitize(part.text), sourceIndex: msgIndex });
      } else if (part.type === "toolCall") {
        blocks.push({
          kind: "tool_call",
          name: part.name,
          args: part.arguments,
          sourceIndex: msgIndex,
        });
      }
    }
    return blocks;
  }

  return [];
};

export const normalize = (
  messages: any[],
  getSourceIndex?: (msgOrItem: any, index: number) => number | undefined,
): NormalizedBlock[] =>
  messages.flatMap((item, i) => {
    const msg = item && typeof item === "object" && "message" in item ? item.message : item;
    let sourceIndex: number | undefined;
    if (typeof getSourceIndex === "function") {
      sourceIndex = getSourceIndex(item, i);
    } else if (item && typeof item === "object" && typeof item.sourceIndex === "number") {
      sourceIndex = item.sourceIndex;
    } else if (msg && typeof msg === "object" && typeof msg.sourceIndex === "number") {
      sourceIndex = msg.sourceIndex;
    } else {
      sourceIndex = i;
    }
    return normalizeOne(msg, sourceIndex);
  });


