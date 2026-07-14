import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { validateMessage, type Message } from "@pi-comm/a2a-contract";
import type { AgentRegistry } from "./registry.ts";
import { checkBearer } from "./auth.ts";

export { checkBearer } from "./auth.ts";

const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2",
  ".map": "application/json", ".txt": "text/plain",
};

// Serve a built web app from `webDir` (public, no auth). Unknown paths without a
// file extension fall back to index.html (single-page app); missing assets 404.
async function serveStatic(webDir: string, urlPath: string, res: ServerResponse): Promise<void> {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, "") || "index.html";
  const root = normalize(webDir);
  const candidate = normalize(join(root, rel));
  if (candidate !== root && !candidate.startsWith(root + "/")) { res.writeHead(403); res.end("forbidden"); return; }
  let file = candidate;
  let body: Buffer;
  try {
    body = await readFile(candidate);
  } catch {
    if (extname(candidate)) { res.writeHead(404); res.end("not found"); return; }
    file = join(root, "index.html");
    try { body = await readFile(file); } catch { res.writeHead(404); res.end("not found"); return; }
  }
  res.writeHead(200, { "content-type": STATIC_MIME[extname(file).toLowerCase()] ?? "application/octet-stream" });
  res.end(body);
}

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export class PendingRequests {
  private finalResolvers = new Map<string, { resolve: (m: Message) => void; reject: (e: Error) => void }>();
  private streamSinks = new Map<string, (v: { message: Message; final: boolean } | { error: string }) => void>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private reqIdToTenant = new Map<string, string>();
  private tenantToReqIds = new Map<string, Set<string>>();

  /** Record reqId → tenant and tenant → Set<reqId> for disconnect-based cancellation. */
  track(reqId: string, tenant: string): void {
    this.reqIdToTenant.set(reqId, tenant);
    if (!this.tenantToReqIds.has(tenant)) this.tenantToReqIds.set(tenant, new Set());
    this.tenantToReqIds.get(tenant)!.add(reqId);
  }

  /** Centralized cleanup: clears timer and tenant-tracking for reqId. Idempotent. */
  private settle(reqId: string): void {
    const t = this.timers.get(reqId);
    if (t !== undefined) { clearTimeout(t); this.timers.delete(reqId); }
    const tenant = this.reqIdToTenant.get(reqId);
    if (tenant !== undefined) {
      this.reqIdToTenant.delete(reqId);
      const set = this.tenantToReqIds.get(tenant);
      if (set) { set.delete(reqId); if (set.size === 0) this.tenantToReqIds.delete(tenant); }
    }
  }

  open(reqId: string): void { /* reserved for symmetry; state created lazily */ }

  push(reqId: string, msg: Message, final: boolean): void {
    const sink = this.streamSinks.get(reqId);
    if (sink) sink({ message: msg, final });
    if (final) {
      this.settle(reqId);
      this.finalResolvers.get(reqId)?.resolve(msg);
      this.finalResolvers.delete(reqId);
    }
  }

  fail(reqId: string, err: string): void {
    this.settle(reqId);
    this.streamSinks.get(reqId)?.({ error: err });
    this.finalResolvers.get(reqId)?.reject(new Error(err));
    this.finalResolvers.delete(reqId);
  }

  /** Fail all in-flight requests tracked under the given tenant (e.g. on disconnect). */
  failByTenant(tenant: string, error: string): void {
    const reqIds = this.tenantToReqIds.get(tenant);
    if (!reqIds) return;
    // Snapshot before iterating — fail() mutates the set via settle().
    const snapshot = [...reqIds];
    for (const reqId of snapshot) {
      this.fail(reqId, error);
    }
  }

  awaitFinal(reqId: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Message> {
    return new Promise((resolve, reject) => {
      this.finalResolvers.set(reqId, { resolve, reject });
      const t = setTimeout(() => {
        this.settle(reqId);
        this.finalResolvers.delete(reqId);
        reject(new Error("request timeout"));
      }, timeoutMs);
      t.unref?.();
      this.timers.set(reqId, t);
    });
  }

  openStream(reqId: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): AsyncGenerator<{ message: Message; final: boolean }> {
    const queue: Array<{ message: Message; final: boolean } | { error: string }> = [];
    let notify: (() => void) | null = null;
    // Register the sink SYNCHRONOUSLY so pushes from conn.send() are never dropped.
    this.streamSinks.set(reqId, (v) => { queue.push(v); notify?.(); });
    // Start timeout at registration time.
    const t = setTimeout(() => {
      this.settle(reqId);
      this.streamSinks.get(reqId)?.({ error: "request timeout" });
      notify?.();
    }, timeoutMs);
    t.unref?.();
    this.timers.set(reqId, t);
    const self = this;
    async function* gen() {
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
      } finally {
        self.settle(reqId);
        self.streamSinks.delete(reqId);
      }
    }
    return gen();
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

export function createHttpHandler(
  registry: AgentRegistry,
  pending: PendingRequests,
  token: string,
  opts?: { requestTimeoutMs?: number; listTerminals?: () => Array<{ tenant: string; description?: string }>; webDir?: string },
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // CORS for the web app (browser client).
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization,content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // Public static web app (when bundled together). API routes stay bearer-gated.
    const isApiPath = path === "/agents" || path === "/terminals" || path.startsWith("/agents/");
    if (req.method === "GET" && opts?.webDir && !isApiPath) { return serveStatic(opts.webDir, path, res); }

    if (!checkBearer(req.headers.authorization, token)) return send(res, 401, { error: "unauthorized" });

    // GET /agents — list all registered agents (pure A2A, no terminal field)
    if (req.method === "GET" && path === "/agents") return send(res, 200, { agents: registry.list() });

    // GET /terminals — list all registered terminal launchers
    if (req.method === "GET" && path === "/terminals") {
      const terminals = opts?.listTerminals?.() ?? [];
      return send(res, 200, { terminals });
    }

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
      const tenant = decodeURIComponent(sendMatch[1]);
      const conn = registry.get(tenant);
      if (!conn) return send(res, 404, { error: "unknown tenant" });
      let message: Message;
      try { message = validateMessage((await readJson(req) as { message: unknown }).message); }
      catch (e) { return send(res, 400, { error: (e as Error).message }); }
      const reqId = randomUUID();
      const finalPromise = pending.awaitFinal(reqId, opts?.requestTimeoutMs);
      pending.track(reqId, tenant);
      conn.send({ type: "request", reqId, stream: false, message });
      try { return send(res, 200, { message: await finalPromise }); }
      catch (e) { return send(res, 502, { error: (e as Error).message }); }
    }

    // POST /agents/{tenant}/message:stream — SSE streaming
    const streamMatch = /^\/agents\/([^/]+)\/message:stream$/.exec(path);
    if (req.method === "POST" && streamMatch) {
      const tenant = decodeURIComponent(streamMatch[1]);
      const conn = registry.get(tenant);
      if (!conn) return send(res, 404, { error: "unknown tenant" });
      let message: Message;
      try { message = validateMessage((await readJson(req) as { message: unknown }).message); }
      catch (e) { return send(res, 400, { error: (e as Error).message }); }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const reqId = randomUUID();
      const stream = pending.openStream(reqId, opts?.requestTimeoutMs); // register sink BEFORE dispatching
      pending.track(reqId, tenant);
      conn.send({ type: "request", reqId, stream: true, message });
      try {
        for await (const { message: m } of stream) {
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
