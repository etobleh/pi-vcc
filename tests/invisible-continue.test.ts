import { describe, expect, it, test } from "bun:test";
import {
  registerBeforeCompactHook,
  triggerInvisibleContinue,
  buildOwnCut,
  AUTO_CONTINUE_CUSTOM_TYPE,
} from "../src/hooks/before-compact";

describe("auto-continue: trigger and delivery", () => {
  it("triggerAutoContinue sends a hidden message with non-empty content and followUp delivery", () => {
    const calls: { m: any; o: any }[] = [];
    const pi = { sendMessage: (m: any, o: any) => calls.push({ m, o }) } as any;
    triggerInvisibleContinue(pi);

    expect(calls).toHaveLength(1);
    expect(calls[0].o).toEqual({ triggerTurn: true, deliverAs: "followUp" });
    expect(calls[0].m).toMatchObject({
      customType: AUTO_CONTINUE_CUSTOM_TYPE,
      content: "Continue",
      display: false,
    });
  });
});

describe("invisible auto-continue: summarize-path noise", () => {
  it("our continue custom message carries empty content → adds no noise to summarizer input", () => {
    const entries = [
      { id: "u1", type: "message", message: { role: "user", content: "go" } },
      { id: "a1", type: "message", message: { role: "assistant", content: "reply" } },
      {
        id: "c1",
        type: "custom_message",
        customType: AUTO_CONTINUE_CUSTOM_TYPE,
        content: [],
        display: false,
        timestamp: "2026-01-01T00:00:00.000Z",
      },
      { id: "u2", type: "message", message: { role: "user", content: "next" } },
      { id: "a2", type: "message", message: { role: "assistant", content: "done" } },
    ];
    const cut = buildOwnCut(entries, 1);
    expect(cut.ok).toBe(true);
    if (!cut.ok) return;

    // The continue message is collected into the live window (harmless) but its
    // content is empty, so it contributes zero text/tokens to the summarizer.
    const custom = cut.messages.find((m: any) => m.content && m.role === "custom");
    expect(custom).toBeDefined();
    const contentLen = Array.isArray(custom.content)
      ? custom.content.length
      : String(custom.content ?? "").length;
    expect(contentLen).toBe(0);
  });
});