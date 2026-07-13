import type { WebSocketServer, WebSocket } from "ws";
import {
  parseTunnelFrame, encodeFrame, validateAgentCard,
  type ChunkFrame, type ErrorFrame,
} from "@pi-comm/a2a-contract";
import type { AgentRegistry } from "./registry.ts";

export function startTunnelServer(
  wss: WebSocketServer,
  registry: AgentRegistry,
  token: string,
  deps: { onChunk: (tenant: string, f: ChunkFrame | ErrorFrame) => void },
): void {
  wss.on("connection", (ws: WebSocket) => {
    let tenant: string | null = null;
    ws.on("message", (raw) => {
      let frame;
      try { frame = parseTunnelFrame(raw.toString()); }
      catch { ws.close(1002, "bad frame"); return; }

      if (frame.type === "ping") { ws.send(encodeFrame({ type: "pong" })); return; }

      if (frame.type === "register") {
        if (frame.token !== token) { ws.close(1008, "unauthorized"); return; }
        let card;
        try { card = validateAgentCard(frame.card); } catch { ws.close(1002, "bad card"); return; }
        tenant = registry.register(frame.name, card, {
          card,
          send: (f) => { try { ws.send(encodeFrame(f)); } catch { /* dropped */ } },
        });
        ws.send(encodeFrame({ type: "registered", tenant }));
        return;
      }

      if (frame.type === "chunk" || frame.type === "error") {
        if (tenant) deps.onChunk(tenant, frame);
        return;
      }
    });
    ws.on("close", () => { if (tenant) registry.unregister(tenant); });
    ws.on("error", () => { if (tenant) registry.unregister(tenant); });
  });
}
