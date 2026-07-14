import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { startRelay } from "../src/server.ts";
import { parseTunnelFrame, encodeFrame } from "@pi-comm/a2a-contract";

let relay: { port: number; close: () => Promise<void> };
afterEach(async () => { await relay?.close(); });

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((r) => ws.on("open", () => r()));
}

describe("relay terminal channel", () => {
  it("bridges launcher <-> viewer both ways", async () => {
    relay = await startRelay({ port: 0, token: "t" });

    // Launcher connects to /pty and registers.
    const launcher = new WebSocket(`ws://127.0.0.1:${relay.port}/pty`);
    await waitOpen(launcher);
    const launcherInputs: string[] = [];
    launcher.on("message", (raw) => {
      const f = parseTunnelFrame(raw.toString());
      if (f.type === "term_input") launcherInputs.push(f.data);
    });
    launcher.send(encodeFrame({ type: "term_register", token: "t", name: "alice" }));
    await new Promise((r) => setTimeout(r, 50));

    // Viewer connects to the tenant terminal with the bearer subprotocol.
    const viewer = new WebSocket(`ws://127.0.0.1:${relay.port}/agents/alice/terminal`, ["bearer", "t"]);
    await waitOpen(viewer);
    const viewerData: string[] = [];
    viewer.on("message", (raw) => {
      const f = parseTunnelFrame(raw.toString());
      if (f.type === "term_data") viewerData.push(f.data);
    });
    await new Promise((r) => setTimeout(r, 50));

    // Launcher emits PTY bytes -> viewer receives them.
    launcher.send(encodeFrame({ type: "term_data", data: "aGk=" }));
    // Viewer types -> launcher receives it.
    viewer.send(encodeFrame({ type: "term_input", data: "eA==" }));
    await new Promise((r) => setTimeout(r, 50));

    expect(viewerData).toEqual(["aGk="]);
    expect(launcherInputs).toEqual(["eA=="]);
  });

  it("closes viewer socket when launcher disconnects", async () => {
    relay = await startRelay({ port: 0, token: "t" });

    const launcher = new WebSocket(`ws://127.0.0.1:${relay.port}/pty`);
    await waitOpen(launcher);
    launcher.send(encodeFrame({ type: "term_register", token: "t", name: "alice" }));
    await new Promise((r) => setTimeout(r, 50));

    const viewer = new WebSocket(`ws://127.0.0.1:${relay.port}/agents/alice/terminal`, ["bearer", "t"]);
    await waitOpen(viewer);
    await new Promise((r) => setTimeout(r, 50));

    const viewerClosed = new Promise<void>((resolve) => viewer.on("close", () => resolve()));
    launcher.close();
    await viewerClosed;
  });

  it("rejects a viewer with a bad bearer token", async () => {
    relay = await startRelay({ port: 0, token: "t" });
    const launcher = new WebSocket(`ws://127.0.0.1:${relay.port}/pty`);
    await waitOpen(launcher);
    launcher.send(encodeFrame({ type: "term_register", token: "t", name: "alice" }));
    await new Promise((r) => setTimeout(r, 50));

    const viewer = new WebSocket(`ws://127.0.0.1:${relay.port}/agents/alice/terminal`, ["bearer", "WRONG"]);
    const closed = await new Promise<boolean>((resolve) => {
      viewer.on("open", () => resolve(false));
      viewer.on("error", () => resolve(true));
      viewer.on("unexpected-response", () => resolve(true));
    });
    expect(closed).toBe(true);
  });
});
