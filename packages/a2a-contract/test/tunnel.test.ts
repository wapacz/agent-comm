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
});
