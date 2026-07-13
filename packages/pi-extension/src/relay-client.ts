import WebSocket from "ws";
import {
  encodeFrame,
  parseTunnelFrame,
  type RequestFrame,
  type Message,
  type AgentCard,
} from "@pi-comm/a2a-contract";

export class RelayClient {
  private ws: WebSocket | null = null;
  private _tenant: string | null = null;
  private requestCb: ((f: RequestFrame) => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private opts: { wsUrl: string; token: string; name: string; card: AgentCard }) {}

  get tenant(): string | null {
    return this._tenant;
  }

  onRequest(cb: (f: RequestFrame) => void): void {
    this.requestCb = cb;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.wsUrl);
      this.ws = ws;

      ws.on("open", () => {
        ws.send(
          encodeFrame({
            type: "register",
            token: this.opts.token,
            name: this.opts.name,
            card: this.opts.card,
          }),
        );
      });

      ws.on("message", (raw) => {
        let f: ReturnType<typeof parseTunnelFrame>;
        try {
          f = parseTunnelFrame(raw.toString());
        } catch {
          return;
        }
        if (f.type === "registered") {
          this._tenant = f.tenant;
          this.startHeartbeat();
          resolve();
        } else if (f.type === "request") {
          this.requestCb?.(f);
        }
        // f.type === "pong" → alive, nothing to do
      });

      ws.on("error", (e) => {
        if (!this._tenant) reject(e);
      });

      ws.on("close", () => {
        this.stopHeartbeat();
        if (!this.closed) this.scheduleReconnect();
      });
    });
  }

  sendChunk(reqId: string, message: Message, final: boolean): void {
    this.ws?.send(encodeFrame({ type: "chunk", reqId, message, final }));
  }

  sendError(reqId: string, error: string): void {
    this.ws?.send(encodeFrame({ type: "error", reqId, error }));
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.ws?.close();
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      try {
        this.ws?.send(encodeFrame({ type: "ping" }));
      } catch {
        /* ignore */
      }
    }, 15_000);
    (this.heartbeat as { unref?: () => void }).unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  private scheduleReconnect(): void {
    const t = setTimeout(() => {
      this.connect().catch(() => this.scheduleReconnect());
    }, 1000);
    (t as { unref?: () => void }).unref?.();
  }
}
