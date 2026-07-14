import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { AgentRegistry } from "./registry.ts";
import { startTunnelServer } from "./tunnel-server.ts";
import { PendingRequests, createHttpHandler } from "./http-surface.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export async function startRelay(opts: {
  port: number;
  token: string;
  requestTimeoutMs?: number;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const registry = new AgentRegistry();
  const pending = new PendingRequests();
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const handler = createHttpHandler(registry, pending, opts.token, { requestTimeoutMs });
  const http = createServer(handler);

  const wss = new WebSocketServer({ noServer: true });
  startTunnelServer(wss, registry, opts.token, {
    onChunk: (_tenant, f) => {
      if (f.type === "chunk") pending.push(f.reqId, f.message, f.final);
      else pending.fail(f.reqId, f.error);
    },
    onDisconnect: (tenant) => {
      pending.failByTenant(tenant, "agent disconnected");
    },
  });

  http.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").startsWith("/agent")) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  await new Promise<void>((r) => http.listen(opts.port, r));
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;

  return {
    port,
    close: () => new Promise<void>((r) => { for (const client of wss.clients) client.terminate(); wss.close(); http.closeAllConnections(); http.close(() => r()); }),
  };
}
