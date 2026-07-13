import { describe, it, expect } from "vitest";
import { InboundManager, extractPromptText } from "../src/inbound.ts";
import type { Message } from "@pi-comm/a2a-contract";

const msg = (text: string, id = "m1"): Message => ({ messageId: id, role: "ROLE_USER", parts: [{ text }] });

describe("extractPromptText", () => {
  it("joins text parts and ignores non-text", () => {
    const m: Message = { messageId: "m", role: "ROLE_USER", parts: [{ text: "a" }, { data: { x: 1 } }, { text: "b" }] };
    expect(extractPromptText(m)).toBe("a\nb");
  });
});

describe("InboundManager", () => {
  it("tracks open jobs FIFO and completes them", () => {
    const mgr = new InboundManager();
    const j1 = mgr.begin("r1", msg("first"), false);
    const j2 = mgr.begin("r2", msg("second"), true);
    expect(j1.promptText).toBe("first");
    expect(mgr.oldestOpen()?.reqId).toBe("r1");
    mgr.complete("r1");
    expect(mgr.oldestOpen()?.reqId).toBe("r2");
    expect(j2.job.stream).toBe(true);
  });
});
