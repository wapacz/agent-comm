export interface TerminalHandlers {
  onData: (bytes: Uint8Array) => void;
  onClose: () => void;
  onStatus?: (status: "connecting" | "open" | "closed") => void;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export class TerminalClient {
  private ws: WebSocket | null = null;
  private pending: string[] = [];

  constructor(private opts: { wsBaseUrl: string; token: string; tenant: string }) {}

  connect(handlers: TerminalHandlers): void {
    const base = (this.opts.wsBaseUrl || location.origin).replace(/^http/, "ws");
    const url = `${base}/agents/${encodeURIComponent(this.opts.tenant)}/terminal`;
    const ws = new WebSocket(url, ["bearer", this.opts.token]);
    this.ws = ws;
    handlers.onStatus?.("connecting");
    ws.onopen = () => { for (const m of this.pending) ws.send(m); this.pending = []; handlers.onStatus?.("open"); };
    ws.onmessage = (ev: MessageEvent) => {
      let f: { type?: string; data?: string };
      try { f = JSON.parse(ev.data as string); } catch { return; }
      if (f.type === "term_data" && typeof f.data === "string") handlers.onData(base64ToBytes(f.data));
    };
    ws.onclose = () => { handlers.onStatus?.("closed"); handlers.onClose(); };
  }

  private sendRaw(obj: unknown): void {
    const msg = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(msg);
    else this.pending.push(msg);
  }

  sendInput(data: string): void {
    const b64 = bytesToBase64(new TextEncoder().encode(data));
    this.sendRaw({ type: "term_input", data: b64 });
  }

  sendResize(cols: number, rows: number): void {
    this.sendRaw({ type: "term_resize", cols, rows });
  }

  close(): void { this.ws?.close(); }
}
