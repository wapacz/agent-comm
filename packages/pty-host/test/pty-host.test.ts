import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { createServer, type Server } from "node:http";
import { parseTunnelFrame, encodeFrame } from "@pi-comm/a2a-contract";
import { PtyHost, type PtyLike, type SpawnFn } from "../src/pty-host.ts";

let server: Server; let port: number;
afterEach(async () => { await new Promise<void>((r) => server?.close(() => r())); });

// Minimal relay stub: accepts term_register, replies term_registered, exposes the socket.
async function startStub(): Promise<{ port: number; socket: Promise<WebSocket> }> {
  const wss = new WebSocketServer({ noServer: true });
  server = createServer();
  let resolveSock!: (ws: WebSocket) => void;
  const socket = new Promise<WebSocket>((r) => (resolveSock = r));
  wss.on("connection", (ws) => {
    resolveSock(ws);
    ws.on("message", (raw) => {
      const f = parseTunnelFrame(raw.toString());
      if (f.type === "term_register") ws.send(encodeFrame({ type: "term_registered", tenant: f.name }));
    });
  });
  server.on("upgrade", (req, sock, head) => wss.handleUpgrade(req, sock, head, (ws) => wss.emit("connection", ws, req)));
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
  return { port, socket };
}

function makeFakePty() {
  let dataCb: ((d: string) => void) | null = null;
  const writes: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  const pty: PtyLike = {
    onData: (cb) => { dataCb = cb; },
    onExit: () => {},
    write: (d) => writes.push(d),
    resize: (cols, rows) => resizes.push({ cols, rows }),
    kill: () => {},
  };
  return { pty, emit: (d: string) => dataCb?.(d), writes, resizes };
}

describe("PtyHost", () => {
  it("registers, pumps pty output out, and input/resize in", async () => {
    const { port, socket } = await startStub();
    const fake = makeFakePty();
    const spawn: SpawnFn = () => fake.pty;
    const host = new PtyHost(
      { wsUrl: `ws://127.0.0.1:${port}`, token: "t", name: "alice", command: "pi", args: [], cwd: "/tmp", env: {} },
      { spawn },
    );
    await host.start();
    expect(host.tenant).toBe("alice");

    const ws = await socket;
    const received: string[] = [];
    ws.on("message", (raw) => {
      const f = parseTunnelFrame(raw.toString());
      if (f.type === "term_data") received.push(f.data);
    });

    // PTY output -> term_data frame (base64 of "hi").
    fake.emit("hi");
    await new Promise((r) => setTimeout(r, 30));
    expect(received).toContain(Buffer.from("hi", "utf8").toString("base64"));

    // Relay -> input + resize applied to the pty.
    ws.send(encodeFrame({ type: "term_input", data: Buffer.from("x", "utf8").toString("base64") }));
    ws.send(encodeFrame({ type: "term_resize", cols: 100, rows: 30 }));
    await new Promise((r) => setTimeout(r, 30));
    expect(fake.writes).toContain("x");
    expect(fake.resizes).toContainEqual({ cols: 100, rows: 30 });

    host.close();
  });
});
