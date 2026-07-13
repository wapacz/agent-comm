import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { AgentRegistry } from "./registry.ts";
import { startTunnelServer } from "./tunnel-server.ts";
import { PendingRequests, createHttpHandler } from "./http-surface.ts";

export async function startRelay(opts: { port: number; token: string }): Promise<{ port: number; close: () => Promise<void> }> {
  const registry = new AgentRegistry();
  const pending = new PendingRequests();
  const handler = createHttpHandler(registry, pending, opts.token);
  const http = createServer(handler);

  const wss = new WebSocketServer({ noServer: true });
  startTunnelServer(wss, registry, opts.token, {
    onChunk: (_tenant, f) => {
      if (f.type === "chunk") pending.push(f.reqId, f.message, f.final);
      else pending.fail(f.reqId, f.error);
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
