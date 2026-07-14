import WebSocket from "ws";
import { encodeFrame, parseTunnelFrame } from "@pi-comm/a2a-contract";

export interface PtyLike {
  onData(cb: (d: string) => void): void;
  onExit(cb: () => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type SpawnFn = (
  file: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => PtyLike;

export interface PtyHostOptions {
  wsUrl: string; token: string; name: string;
  command: string; args: string[]; cwd: string; env: Record<string, string>;
  cols?: number; rows?: number;
}

async function defaultSpawn(): Promise<SpawnFn> {
  const pty = await import("node-pty");
  return (file, args, opts) => pty.spawn(file, args, opts) as unknown as PtyLike;
}

export class PtyHost {
  private ws: WebSocket | null = null;
  private pty: PtyLike | null = null;
  private _tenant: string | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private opts: PtyHostOptions, private deps: { spawn?: SpawnFn } = {}) {}

  get tenant(): string | null { return this._tenant; }

  async start(): Promise<void> {
    const spawn = this.deps.spawn ?? (await defaultSpawn());
    this.pty = spawn(this.opts.command, this.opts.args, {
      name: "xterm-256color",
      cols: this.opts.cols ?? 80,
      rows: this.opts.rows ?? 24,
      cwd: this.opts.cwd,
      env: this.opts.env,
    });
    this.pty.onData((d) => {
      const data = Buffer.from(d, "utf8").toString("base64");
      try { this.ws?.send(encodeFrame({ type: "term_data", data })); } catch { /* dropped */ }
    });
    this.pty.onExit(() => this.close());
    await this.connect();
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.wsUrl);
      this.ws = ws;
      ws.on("open", () => ws.send(encodeFrame({ type: "term_register", token: this.opts.token, name: this.opts.name })));
      ws.on("message", (raw) => {
        let f;
        try { f = parseTunnelFrame(raw.toString()); } catch { return; }
        if (f.type === "term_registered") { this._tenant = f.tenant; this.startHeartbeat(); resolve(); }
        else if (f.type === "term_input") { this.pty?.write(Buffer.from(f.data, "base64").toString("utf8")); }
        else if (f.type === "term_resize") { try { this.pty?.resize(f.cols, f.rows); } catch { /* ignore */ } }
      });
      ws.on("error", (e) => { if (!this._tenant) reject(e); });
      ws.on("close", () => { this.stopHeartbeat(); if (!this.closed) this.scheduleReconnect(); });
    });
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    try { this.pty?.kill(); } catch { /* ignore */ }
    this.ws?.close();
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      try { this.ws?.send(encodeFrame({ type: "ping" })); } catch { /* ignore */ }
    }, 15_000);
    (this.heartbeat as { unref?: () => void }).unref?.();
  }
  private stopHeartbeat(): void { if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null; }
  private scheduleReconnect(): void {
    const t = setTimeout(() => { this.connect().catch(() => this.scheduleReconnect()); }, 1000);
    (t as { unref?: () => void }).unref?.();
  }
}
