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
  cols?: number; rows?: number; description?: string;
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
  private opts: PtyHostOptions;
  private deps: { spawn?: SpawnFn };
  private cols = 80;
  private rows = 24;

  constructor(opts: PtyHostOptions, deps: { spawn?: SpawnFn } = {}) {
    this.opts = opts;
    this.deps = deps;
  }

  get tenant(): string | null { return this._tenant; }

  async start(): Promise<void> {
    const spawn = this.deps.spawn ?? (await defaultSpawn());
    this.cols = this.opts.cols ?? 80;
    this.rows = this.opts.rows ?? 24;
    this.pty = spawn(this.opts.command, this.opts.args, {
      name: "xterm-256color",
      cols: this.cols,
      rows: this.rows,
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
      ws.on("open", () => ws.send(encodeFrame({ type: "term_register", token: this.opts.token, name: this.opts.name, description: this.opts.description })));
      ws.on("message", (raw) => {
        let f;
        try { f = parseTunnelFrame(raw.toString()); } catch { return; }
        if (f.type === "term_registered") { this._tenant = f.tenant; this.startHeartbeat(); resolve(); }
        else if (f.type === "term_input") { this.pty?.write(Buffer.from(f.data, "base64").toString("utf8")); }
        else if (f.type === "term_resize") { this.applyResize(f.cols, f.rows); }
      });
      ws.on("error", (e) => { if (!this._tenant) reject(e); });
      ws.on("close", () => { this.stopHeartbeat(); if (!this.closed) this.scheduleReconnect(); });
    });
  }

  // Apply a resize to the PTY. When the requested size equals the current one
  // (e.g. a viewer re-attaching to a TUI already at this size), a plain resize
  // emits no observable size change, so full-screen apps like pi never repaint
  // and the new viewer sees a blank screen. Nudge the rows to a different value
  // and, after a short delay so the app actually observes the intermediate
  // size, restore the requested size — forcing two SIGWINCH-driven repaints.
  private applyResize(cols: number, rows: number): void {
    if (!this.pty) return;
    const sameSize = cols === this.cols && rows === this.rows;
    this.cols = cols;
    this.rows = rows;
    try {
      if (sameSize) {
        const nudge = rows > 1 ? rows - 1 : rows + 1;
        this.pty.resize(cols, nudge);
        const t = setTimeout(() => { try { this.pty?.resize(cols, rows); } catch { /* ignore */ } }, 250);
        (t as { unref?: () => void }).unref?.();
      } else {
        this.pty.resize(cols, rows);
      }
    } catch { /* ignore */ }
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
