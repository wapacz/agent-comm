import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { AgentRegistry } from "./registry.ts";
import { startTunnelServer } from "./tunnel-server.ts";
import { TerminalRegistry } from "./terminal-registry.ts";
import { startTerminalServer } from "./terminal-server.ts";
import { PendingRequests, createHttpHandler } from "./http-surface.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export async function startRelay(opts: {
  port: number;
  token: string;
  requestTimeoutMs?: number;
  webDir?: string;
}): Promise<{ port: number; close: () => Promise<void> }> {
  const registry = new AgentRegistry();
  const pending = new PendingRequests();
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const terminalRegistry = new TerminalRegistry();
  const handler = createHttpHandler(registry, pending, opts.token, {
    requestTimeoutMs,
    listTerminals: () => terminalRegistry.listTerminals(),
    webDir: opts.webDir,
  });
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

  const wssPty = new WebSocketServer({ noServer: true });
  const wssViewer = new WebSocketServer({ noServer: true, handleProtocols: () => "bearer" });
  startTerminalServer(wssPty, wssViewer, terminalRegistry, opts.token);

  http.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/agent") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      return;
    }
    if (path === "/pty") {
      wssPty.handleUpgrade(req, socket, head, (ws) => wssPty.emit("connection", ws, req));
      return;
    }
    if (/^\/agents\/([^/]+)\/terminal$/.test(path)) {
      const proto = req.headers["sec-websocket-protocol"];
      const parts = typeof proto === "string" ? proto.split(",").map((s) => s.trim()) : [];
      if (parts[0] !== "bearer" || parts[1] !== opts.token) { socket.destroy(); return; }
      wssViewer.handleUpgrade(req, socket, head, (ws) => wssViewer.emit("connection", ws, req));
      return;
    }
    socket.destroy();
  });

  await new Promise<void>((r) => http.listen(opts.port, r));
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;

  return {
    port,
    close: () => new Promise<void>((r) => {
      for (const client of wss.clients) client.terminate();
      for (const client of wssPty.clients) client.terminate();
      for (const client of wssViewer.clients) client.terminate();
      wss.close(); wssPty.close(); wssViewer.close();
      http.closeAllConnections(); http.close(() => r());
    }),
  };
}
