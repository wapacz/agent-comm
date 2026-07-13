import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { startRelay } from "../src/server.ts";
import { parseTunnelFrame, encodeFrame } from "@pi-comm/a2a-contract";

const card = {
  name: "worker", description: "echo", version: "1.0.0",
  capabilities: { streaming: true }, defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"], skills: [{ id: "echo", name: "Echo", description: "echoes", tags: [] }],
};

let relay: { port: number; close: () => Promise<void> };
afterEach(async () => { await relay?.close(); });

async function connectEchoAgent(port: number): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`);
  await new Promise<void>((r) => ws.on("open", () => r()));
  ws.send(encodeFrame({ type: "register", token: "t", name: "worker", card }));
  ws.on("message", (raw) => {
    const f = parseTunnelFrame(raw.toString());
    if (f.type === "request") {
      const inText = f.message.parts[0] && "text" in f.message.parts[0] ? (f.message.parts[0] as { text: string }).text : "";
      ws.send(encodeFrame({ type: "chunk", reqId: f.reqId, final: true,
        message: { messageId: "a", role: "ROLE_AGENT", parts: [{ text: `echo:${inText}` }] } }));
    }
  });
  await new Promise((r) => setTimeout(r, 50)); // allow register round-trip
}

describe("relay end-to-end", () => {
  it("routes a client message to a connected agent and back", async () => {
    relay = await startRelay({ port: 0, token: "t" });
    await connectEchoAgent(relay.port);
    const res = await fetch(`http://127.0.0.1:${relay.port}/agents/worker/message:send`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "hi" }] } }),
    });
    const body = await res.json();
    expect(body.message.parts[0]).toEqual({ text: "echo:hi" });
  });
});
