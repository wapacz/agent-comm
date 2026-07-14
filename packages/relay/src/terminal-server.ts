import type { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { parseTunnelFrame, encodeFrame } from "@pi-comm/a2a-contract";
import type { TerminalRegistry, Viewer } from "./terminal-registry.ts";

function viewerTenant(req: IncomingMessage): string | null {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const m = /^\/agents\/([^/]+)\/terminal$/.exec(path);
  return m ? decodeURIComponent(m[1]) : null;
}

export function startTerminalServer(
  wssPty: WebSocketServer,
  wssViewer: WebSocketServer,
  registry: TerminalRegistry,
  token: string,
): void {
  // Launchers (PTY hosts) connect here.
  wssPty.on("connection", (ws: WebSocket) => {
    let tenant: string | null = null;
    ws.on("message", (raw) => {
      let f;
      try { f = parseTunnelFrame(raw.toString()); } catch { ws.close(1002, "bad frame"); return; }
      if (f.type === "ping") { try { ws.send(encodeFrame({ type: "pong" })); } catch { /* closed */ } return; }
      if (f.type === "term_register") {
        if (tenant !== null) { ws.close(1008, "already registered"); return; }
        if (f.token !== token) { ws.close(1008, "unauthorized"); return; }
        tenant = registry.registerLauncher(f.name, {
          sendInput: (data) => { try { ws.send(encodeFrame({ type: "term_input", data })); } catch { /* dropped */ } },
          sendResize: (cols, rows) => { try { ws.send(encodeFrame({ type: "term_resize", cols, rows })); } catch { /* dropped */ } },
        });
        try { ws.send(encodeFrame({ type: "term_registered", tenant })); } catch { /* closed */ }
        return;
      }
      if (f.type === "term_data") { if (tenant) registry.broadcastData(tenant, f.data); return; }
    });
    const cleanup = () => { if (tenant) { const gone = registry.unregisterLauncher(tenant); for (const v of gone) v.close?.(); } };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });

  // Browser viewers connect here (bearer already checked at upgrade).
  wssViewer.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const tenant = viewerTenant(req);
    if (!tenant) { ws.close(1011, "bad tenant"); return; }
    const viewer: Viewer = {
      sendData: (data) => { try { ws.send(encodeFrame({ type: "term_data", data })); } catch { /* dropped */ } },
      close: () => { try { ws.close(1012, "launcher gone"); } catch { /* already closed */ } },
    };
    if (!registry.addViewer(tenant, viewer)) { ws.close(1011, "no terminal"); return; }
    ws.on("message", (raw) => {
      let f;
      try { f = parseTunnelFrame(raw.toString()); } catch { return; }
      const launcher = registry.getLauncher(tenant);
      if (!launcher) return;
      if (f.type === "term_input") { launcher.sendInput(f.data); return; }
      if (f.type === "term_resize") {
        viewer.lastResize = { cols: f.cols, rows: f.rows };
        if (registry.primaryViewer(tenant) === viewer) launcher.sendResize(f.cols, f.rows);
        return;
      }
    });
    const cleanup = () => {
      registry.removeViewer(tenant, viewer);
      const p = registry.primaryViewer(tenant);
      const launcher = registry.getLauncher(tenant);
      if (p?.lastResize && launcher) launcher.sendResize(p.lastResize.cols, p.lastResize.rows);
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });
}
