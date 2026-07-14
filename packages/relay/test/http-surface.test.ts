import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
  const handler = createHttpHandler(registry, pending, "secret", { listTerminals: () => [{ tenant: "backend", description: "d" }] });
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
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

  it("lists terminals on GET /terminals", async () => {
    const res = await fetch(`${base}/terminals`, { headers: { authorization: "Bearer secret" } });
    expect(res.status).toBe(200);
    expect((await res.json()).terminals).toEqual([{ tenant: "backend", description: "d" }]);
  });

  it("rejects GET /terminals without a bearer token", async () => {
    const res = await fetch(`${base}/terminals`);
    expect(res.status).toBe(401);
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

describe("message:stream", () => {
  it("streams multiple chunks then [DONE]", async () => {
    // Register a streaming agent that pushes two non-final chunks then a final one.
    registry.register("streamer", card, {
      card,
      send: (f) => {
        if (f.type === "request") {
          pending.push(f.reqId, { messageId: "r1", role: "ROLE_AGENT", parts: [{ text: "chunk1" }] }, false);
          pending.push(f.reqId, { messageId: "r2", role: "ROLE_AGENT", parts: [{ text: "chunk2" }] }, false);
          pending.push(f.reqId, { messageId: "r3", role: "ROLE_AGENT", parts: [{ text: "final" }] }, true);
        }
      },
    });
    const res = await fetch(`${base}/agents/streamer/message:stream`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ message: { messageId: "m2", role: "ROLE_USER", parts: [{ text: "go" }] } }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain('"chunk1"');
    expect(text).toContain('"chunk2"');
    expect(text).toContain('"final"');
    expect(text).toContain("data: [DONE]");
    // Every chunk line must be a valid SSE data frame.
    const dataLines = text.split("\n").filter((l) => l.startsWith("data: ") && l !== "data: [DONE]");
    expect(dataLines).toHaveLength(3);
    for (const line of dataLines) {
      const payload = JSON.parse(line.slice("data: ".length)) as { message: unknown };
      expect(payload).toHaveProperty("message");
    }
  });

  it("404s for an unknown tenant on message:stream", async () => {
    const res = await fetch(`${base}/agents/ghost/message:stream`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ message: { messageId: "m3", role: "ROLE_USER", parts: [{ text: "ping" }] } }),
    });
    expect(res.status).toBe(404);
  });

  it("400s for invalid message body on message:stream", async () => {
    const res = await fetch(`${base}/agents/backend/message:stream`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ message: { bad: "data" } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("PendingRequests — timeout", () => {
  it("awaitFinal rejects with 'request timeout' when no final arrives within timeoutMs", async () => {
    const pending = new PendingRequests();
    const reqId = "req-timeout-1";
    await expect(pending.awaitFinal(reqId, 20)).rejects.toThrow("request timeout");
  });

  it("a late push after timeout does NOT throw and has no effect", async () => {
    const pending = new PendingRequests();
    const reqId = "req-timeout-2";
    const p = pending.awaitFinal(reqId, 20);
    await expect(p).rejects.toThrow("request timeout");
    // Push after timeout must not throw
    expect(() => pending.push(reqId, { messageId: "x", role: "ROLE_AGENT", parts: [] }, true)).not.toThrow();
  });

  it("openStream yields error and throws when timeout fires before first chunk", async () => {
    const pending = new PendingRequests();
    const reqId = "req-stream-timeout-1";
    const stream = pending.openStream(reqId, 20);
    await expect(async () => { for await (const _ of stream) { /* noop */ } }).rejects.toThrow("request timeout");
  });
});

describe("PendingRequests — failByTenant", () => {
  it("failByTenant rejects an in-flight awaitFinal tracked under that tenant", async () => {
    const pending = new PendingRequests();
    const reqId = "req-tenant-1";
    pending.track(reqId, "myagent");
    const p = pending.awaitFinal(reqId);
    pending.failByTenant("myagent", "agent disconnected");
    await expect(p).rejects.toThrow("agent disconnected");
  });

  it("failByTenant does nothing for an unknown tenant", () => {
    const pending = new PendingRequests();
    expect(() => pending.failByTenant("nobody", "x")).not.toThrow();
  });

  it("failByTenant errors an in-flight openStream tracked under that tenant", async () => {
    const pending = new PendingRequests();
    const reqId = "req-stream-tenant-1";
    pending.track(reqId, "myagent");
    const stream = pending.openStream(reqId);
    const p = (async () => { for await (const _ of stream) { /* noop */ } })();
    pending.failByTenant("myagent", "agent disconnected");
    await expect(p).rejects.toThrow("agent disconnected");
  });
});

describe("static web serving (webDir)", () => {
  let staticServer: Server; let staticBase: string; let webDir: string;

  beforeEach(async () => {
    const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    webDir = await mkdtemp(join(tmpdir(), "pi-comm-web-"));
    await writeFile(join(webDir, "index.html"), "<!doctype html><title>app</title>");
    await mkdir(join(webDir, "assets"));
    await writeFile(join(webDir, "assets", "app.js"), "console.log(1)");
    const reg = new AgentRegistry();
    const handler = createHttpHandler(reg, new PendingRequests(), "secret", { webDir });
    staticServer = createServer(handler);
    await new Promise<void>((r) => staticServer.listen(0, r));
    const addr = staticServer.address();
    staticBase = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterEach(async () => { await new Promise<void>((r) => staticServer.close(() => r())); });

  it("serves index.html at / without a token", async () => {
    const res = await fetch(`${staticBase}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<title>app</title>");
  });

  it("serves static assets without a token", async () => {
    const res = await fetch(`${staticBase}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("falls back to index.html for unknown routes (no extension)", async () => {
    const res = await fetch(`${staticBase}/some/deep/route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>app</title>");
  });

  it("still requires a bearer token for API routes", async () => {
    expect((await fetch(`${staticBase}/agents`)).status).toBe(401);
    expect((await fetch(`${staticBase}/terminals`)).status).toBe(401);
  });

  it("404s a missing asset (does not leak index.html for extensioned paths)", async () => {
    const res = await fetch(`${staticBase}/assets/missing.js`);
    expect(res.status).toBe(404);
  });
});
