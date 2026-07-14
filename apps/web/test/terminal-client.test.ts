import { describe, it, expect, beforeEach } from "vitest";
import { TerminalClient } from "../src/terminal-client.ts";

class FakeWS {
  static OPEN = 1;
  static last: FakeWS | null = null;
  url: string; protocols: string[]; sent: string[] = [];
  readyState = 1;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onopen: (() => void) | null = null;
  constructor(url: string, protocols: string[]) { this.url = url; this.protocols = protocols; FakeWS.last = this; }
  send(d: string) { this.sent.push(d); }
  close() { this.onclose?.(); }
}

beforeEach(() => { (globalThis as { WebSocket?: unknown }).WebSocket = FakeWS as unknown as typeof WebSocket; });

describe("TerminalClient", () => {
  it("connects with the bearer subprotocol and decodes term_data", () => {
    const client = new TerminalClient({ wsBaseUrl: "ws://relay", token: "tok", tenant: "alice" });
    const bytes: Uint8Array[] = [];
    client.connect({ onData: (b) => bytes.push(b), onClose: () => {} });
    const ws = FakeWS.last!;
    expect(ws.url).toBe("ws://relay/agents/alice/terminal");
    expect(ws.protocols).toEqual(["bearer", "tok"]);
    ws.onmessage!({ data: JSON.stringify({ type: "term_data", data: btoa("hi") }) });
    expect(new TextDecoder().decode(bytes[0])).toBe("hi");
  });

  it("encodes input and resize as term_ frames", () => {
    const client = new TerminalClient({ wsBaseUrl: "ws://relay", token: "tok", tenant: "alice" });
    client.connect({ onData: () => {}, onClose: () => {} });
    const ws = FakeWS.last!;
    client.sendInput("x");
    client.sendResize(120, 40);
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "term_input", data: btoa("x") });
    expect(JSON.parse(ws.sent[1])).toEqual({ type: "term_resize", cols: 120, rows: 40 });
  });

  it("queues sends before OPEN and flushes on open", () => {
    const client = new TerminalClient({ wsBaseUrl: "ws://relay", token: "tok", tenant: "alice" });
    client.connect({ onData: () => {}, onClose: () => {} });
    const ws = FakeWS.last!;
    // Simulate socket still CONNECTING
    ws.readyState = 0;
    client.sendResize(120, 40);
    expect(ws.sent).toHaveLength(0); // queued, not sent yet
    ws.readyState = 1;
    ws.onopen!();
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toEqual({ type: "term_resize", cols: 120, rows: 40 });
  });
});
