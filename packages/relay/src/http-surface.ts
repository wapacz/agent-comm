import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { validateMessage, type Message } from "@pi-comm/a2a-contract";
import type { AgentRegistry } from "./registry.ts";
import { checkBearer } from "./auth.ts";

export { checkBearer } from "./auth.ts";

export class PendingRequests {
  private finalResolvers = new Map<string, { resolve: (m: Message) => void; reject: (e: Error) => void }>();
  private streamSinks = new Map<string, (v: { message: Message; final: boolean } | { error: string }) => void>();

  open(reqId: string): void { /* reserved for symmetry; state created lazily */ }

  push(reqId: string, msg: Message, final: boolean): void {
    const sink = this.streamSinks.get(reqId);
    if (sink) sink({ message: msg, final });
    if (final) {
      this.finalResolvers.get(reqId)?.resolve(msg);
      this.finalResolvers.delete(reqId);
    }
  }

  fail(reqId: string, err: string): void {
    this.streamSinks.get(reqId)?.({ error: err });
    this.finalResolvers.get(reqId)?.reject(new Error(err));
    this.finalResolvers.delete(reqId);
  }

  awaitFinal(reqId: string): Promise<Message> {
    return new Promise((resolve, reject) => this.finalResolvers.set(reqId, { resolve, reject }));
  }

  async *iterate(reqId: string): AsyncGenerator<{ message: Message; final: boolean }> {
    const queue: Array<{ message: Message; final: boolean } | { error: string }> = [];
    let notify: (() => void) | null = null;
    this.streamSinks.set(reqId, (v) => { queue.push(v); notify?.(); });
    try {
      while (true) {
        if (queue.length === 0) await new Promise<void>((r) => (notify = r));
        while (queue.length) {
          const v = queue.shift()!;
          if ("error" in v) throw new Error(v.error);
          yield v;
          if (v.final) return;
        }
      }
    } finally { this.streamSinks.delete(reqId); }
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

export function createHttpHandler(registry: AgentRegistry, pending: PendingRequests, token: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // CORS for the web app (browser client).
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization,content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (!checkBearer(req.headers.authorization, token)) return send(res, 401, { error: "unauthorized" });

    // GET /agents — list all registered agents
    if (req.method === "GET" && path === "/agents") return send(res, 200, { agents: registry.list() });

    // GET /agents/{tenant}/.well-known/agent-card.json
    const cardMatch = /^\/agents\/([^/]+)\/\.well-known\/agent-card\.json$/.exec(path);
    if (req.method === "GET" && cardMatch) {
      const conn = registry.get(decodeURIComponent(cardMatch[1]));
      if (!conn) return send(res, 404, { error: "unknown tenant" });
      return send(res, 200, conn.card);
    }

    // POST /agents/{tenant}/message:send — blocking, waits for final chunk
    const sendMatch = /^\/agents\/([^/]+)\/message:send$/.exec(path);
    if (req.method === "POST" && sendMatch) {
      const conn = registry.get(decodeURIComponent(sendMatch[1]));
      if (!conn) return send(res, 404, { error: "unknown tenant" });
      let message: Message;
      try { message = validateMessage((await readJson(req) as { message: unknown }).message); }
      catch (e) { return send(res, 400, { error: (e as Error).message }); }
      const reqId = randomUUID();
      const finalPromise = pending.awaitFinal(reqId);
      conn.send({ type: "request", reqId, stream: false, message });
      try { return send(res, 200, { message: await finalPromise }); }
      catch (e) { return send(res, 502, { error: (e as Error).message }); }
    }

    // POST /agents/{tenant}/message:stream — SSE streaming
    const streamMatch = /^\/agents\/([^/]+)\/message:stream$/.exec(path);
    if (req.method === "POST" && streamMatch) {
      const conn = registry.get(decodeURIComponent(streamMatch[1]));
      if (!conn) return send(res, 404, { error: "unknown tenant" });
      let message: Message;
      try { message = validateMessage((await readJson(req) as { message: unknown }).message); }
      catch (e) { return send(res, 400, { error: (e as Error).message }); }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const reqId = randomUUID();
      conn.send({ type: "request", reqId, stream: true, message });
      try {
        for await (const { message: m } of pending.iterate(reqId)) {
          res.write(`data: ${JSON.stringify({ message: m })}\n\n`);
        }
      } catch (e) {
        res.write(`data: ${JSON.stringify({ error: (e as Error).message })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    return send(res, 404, { error: "not found" });
  };
}
