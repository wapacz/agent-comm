import { describe, it, expect } from "vitest";
import { parseTunnelFrame, encodeFrame } from "../src/tunnel.ts";

describe("tunnel protocol", () => {
  it("round-trips a request frame", () => {
    const f = { type: "request", reqId: "r1", stream: true,
      message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "hi" }] } } as const;
    expect(parseTunnelFrame(encodeFrame(f))).toEqual(f);
  });

  it("rejects an unknown frame type", () => {
    expect(() => parseTunnelFrame(JSON.stringify({ type: "nope" }))).toThrow();
  });

  it("rejects malformed JSON", () => {
    expect(() => parseTunnelFrame("{not json")).toThrow();
  });

  it("round-trips a term_data frame", () => {
    const f = { type: "term_data", data: "aGVsbG8=" } as const;
    expect(parseTunnelFrame(encodeFrame(f))).toEqual(f);
  });

  it("round-trips a term_register frame", () => {
    const f = { type: "term_register", token: "t", name: "alice" } as const;
    expect(parseTunnelFrame(encodeFrame(f))).toEqual(f);
  });

  it("round-trips a term_resize frame", () => {
    const f = { type: "term_resize", cols: 120, rows: 40 } as const;
    expect(parseTunnelFrame(encodeFrame(f))).toEqual(f);
  });

  it("round-trips a term_register frame with a description", () => {
    const f = { type: "term_register", token: "t", name: "alice", description: "pi session" } as const;
    expect(parseTunnelFrame(encodeFrame(f))).toEqual(f);
  });
});
