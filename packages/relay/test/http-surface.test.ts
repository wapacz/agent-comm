import { describe, it, expect, beforeEach } from "vitest";
import { AgentRegistry } from "../src/registry.ts";
import { PendingRequests, createHttpHandler, checkBearer } from "../src/http-surface.ts";
import { createServer, type Server } from "node:http";
import type { TunnelFrame } from "@pi-comm/a2a-contract";

const card = {
  name: "backend", description: "d", version: "1.0.0",
  capabilities: { streaming: true }, defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"], skills: [{ id: "c", name: "C", description: "d", tags: [] }],
};

let server: Server; let base: string; let registry: AgentRegistry; let pending: PendingRequests;
let lastFrame: TunnelFrame | null = null;

beforeEach(async () => {
  registry = new AgentRegistry();
  pending = new PendingRequests();
  // Fake agent: whatever request arrives, immediately answer via pending.
  registry.register("backend", card, {
    card,
    send: (f) => {
      lastFrame = f;
      if (f.type === "request") {
        pending.push(f.reqId, { messageId: "a1", role: "ROLE_AGENT", parts: [{ text: "pong" }] }, true);
      }
    },
  });
  const handler = createHttpHandler(registry, pending, "secret");
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

describe("checkBearer", () => {
  it("passes only for the exact token", () => {
    expect(checkBearer("Bearer secret", "secret")).toBe(true);
    expect(checkBearer("Bearer nope", "secret")).toBe(false);
    expect(checkBearer(undefined, "secret")).toBe(false);
  });
});

describe("http surface", () => {
  it("lists agents", async () => {
    const res = await fetch(`${base}/agents`, { headers: { authorization: "Bearer secret" } });
    const body = await res.json();
    expect(body.agents).toEqual([{ tenant: "backend", card }]);
  });

  it("serves an agent card", async () => {
    const res = await fetch(`${base}/agents/backend/.well-known/agent-card.json`, { headers: { authorization: "Bearer secret" } });
    expect(await res.json()).toEqual(card);
  });

  it("rejects without a bearer token", async () => {
    const res = await fetch(`${base}/agents`);
    expect(res.status).toBe(401);
  });

  it("routes message:send to the agent and returns its reply", async () => {
    const res = await fetch(`${base}/agents/backend/message:send`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "ping" }] } }),
    });
    const body = await res.json();
    expect(body.message.parts[0]).toEqual({ text: "pong" });
    expect(lastFrame?.type).toBe("request");
  });

  it("404s for an unknown tenant", async () => {
    const res = await fetch(`${base}/agents/ghost/message:send`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "ping" }] } }),
    });
    expect(res.status).toBe(404);
  });
});
