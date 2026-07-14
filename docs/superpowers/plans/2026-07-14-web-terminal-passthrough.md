# Web Terminal Passthrough Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a web browser act as a full remote control of a real Pi agent by mirroring Pi's terminal into `xterm.js` and forwarding keystrokes, as a new channel parallel to the existing A2A message surface.

**Architecture:** A new PTY-host launcher wraps real `pi` under `node-pty` on the agent host and dials the relay over WebSocket. The relay gains a `TerminalRegistry` and two new WS namespaces — `/pty` (launchers) and `/agents/{tenant}/terminal` (browsers) — and fans PTY bytes out to viewers while routing keystrokes/resizes back. The web app renders the stream in an `xterm.js` component. The pi↔relay tunnel is our own protocol (not A2A), so we extend `tunnel.ts` with `term_*` frames.

**Tech Stack:** TypeScript, Node 20+, `ws`, `node-pty`, `@xterm/xterm` + `@xterm/addon-fit`, `typebox`, `vitest`, Vite + React, npm workspaces.

## Global Constraints

- Node version floor: **`>=20`** (`engines.node: ">=20"` in every new `package.json`).
- Language: all code, comments, commit messages, identifiers in **English**.
- Package manager: **npm workspaces** (no pnpm/yarn).
- Tunnel frames are JSON objects with a `type` discriminator; extend `parseTunnelFrame`/`encodeFrame` and the `KNOWN` set together.
- Binary terminal payloads travel as **base64** strings inside `term_data`/`term_input` frames (JSON-safe).
- Tenant addressing stays **path-based**: `/agents/{tenant}/terminal`.
- Auth uses the same static bearer token from env `A2A_RELAY_TOKEN`. Launchers send it in the `term_register` frame; browsers send it as the WS subprotocol `["bearer", <token>]`. The token must be a valid WS subprotocol token (no whitespace/control chars).
- No secrets in code or logs. Never log the token or raw terminal bytes.
- Relay defaults to binding `127.0.0.1`.

---

## File Structure

```
packages/a2a-contract/src/tunnel.ts        # MODIFY: add term_* frames
packages/relay/src/terminal-registry.ts    # CREATE: launcher + viewer registry, geometry
packages/relay/src/terminal-server.ts      # CREATE: WS handlers for /pty and viewers
packages/relay/src/server.ts               # MODIFY: upgrade routing, wire terminal, roster flag
packages/relay/src/http-surface.ts         # MODIFY: roster `terminal` boolean
packages/relay/src/index.ts                # MODIFY: log the terminal endpoints
packages/pty-host/package.json             # CREATE
packages/pty-host/src/config.ts            # CREATE: resolve ws url/token/name/command
packages/pty-host/src/pty-host.ts          # CREATE: PtyHost (node-pty <-> relay pump)
packages/pty-host/src/index.ts             # CREATE: CLI entrypoint
apps/web/src/terminal-client.ts            # CREATE: browser WS client for the terminal
apps/web/src/components/Terminal.tsx       # CREATE: xterm.js component
apps/web/src/App.tsx                        # MODIFY: Chat/Terminal tab per tenant
apps/web/src/a2a-client.ts                  # MODIFY: listAgents returns `terminal`
apps/web/package.json                       # MODIFY: xterm deps + test devDeps
apps/web/vite.config.ts                     # MODIFY: ws:true on /agents proxy
docs/RUNBOOK.md                             # MODIFY: terminal runbook + security note
```

---

### Task 1: Tunnel `term_*` frames (`packages/a2a-contract`)

**Files:**
- Modify: `packages/a2a-contract/src/tunnel.ts`
- Test: `packages/a2a-contract/test/tunnel.test.ts`

**Interfaces:**
- Produces (added to the existing `TunnelFrame` union):
  - `TermRegisterFrame = { type: "term_register"; token: string; name: string }`
  - `TermRegisteredFrame = { type: "term_registered"; tenant: string }`
  - `TermDataFrame = { type: "term_data"; data: string }` (base64 PTY bytes)
  - `TermInputFrame = { type: "term_input"; data: string }` (base64 keystrokes)
  - `TermResizeFrame = { type: "term_resize"; cols: number; rows: number }`
  - `parseTunnelFrame`/`encodeFrame` accept all of the above.

- [ ] **Step 1: Add failing tests** — append to `packages/a2a-contract/test/tunnel.test.ts`:

```ts
it("round-trips a term_data frame", () => {
  const f = { type: "term_data", data: "aGVsbG8=" } as const;
  expect(parseTunnelFrame(encodeFrame(f))).toEqual(f);
});

it("round-trips a term_register frame", () => {
  const f = { type: "term_register", token: "t", name: "alice" } as const;
  expect(parseTunnelFrame(encodeFrame(f))).toEqual(f);
});

it("round-trips a term_resize frame", () => {
  const f = { type: "term_resize", cols: 120, rows: 40 } as const;
  expect(parseTunnelFrame(encodeFrame(f))).toEqual(f);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/a2a-contract/test/tunnel.test.ts`
Expected: FAIL — `tunnel: unknown frame type term_data`.

- [ ] **Step 3: Implement** — in `packages/a2a-contract/src/tunnel.ts` add the interfaces after `PongFrame`, extend the union and `KNOWN`:

```ts
export interface TermRegisterFrame { type: "term_register"; token: string; name: string; }
export interface TermRegisteredFrame { type: "term_registered"; tenant: string; }
export interface TermDataFrame { type: "term_data"; data: string; }
export interface TermInputFrame { type: "term_input"; data: string; }
export interface TermResizeFrame { type: "term_resize"; cols: number; rows: number; }
```

Change the `TunnelFrame` union to also include:

```ts
  | TermRegisterFrame | TermRegisteredFrame | TermDataFrame | TermInputFrame | TermResizeFrame;
```

Change `KNOWN` to:

```ts
const KNOWN = new Set([
  "register", "registered", "request", "chunk", "error", "ping", "pong",
  "term_register", "term_registered", "term_data", "term_input", "term_resize",
]);
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/a2a-contract`
Expected: PASS (all contract + tunnel tests).

- [ ] **Step 5: Commit**

```bash
git add packages/a2a-contract && git commit -m "feat(contract): term_* tunnel frames for terminal passthrough"
```

---

### Task 2: Terminal registry (`packages/relay`)

**Files:**
- Create: `packages/relay/src/terminal-registry.ts`
- Test: `packages/relay/test/terminal-registry.test.ts`

**Interfaces:**
- Produces:
  - `interface LauncherConn { sendInput(dataB64: string): void; sendResize(cols: number, rows: number): void; }`
  - `interface Viewer { sendData(dataB64: string): void; lastResize?: { cols: number; rows: number }; }`
  - `class TerminalRegistry`:
    - `registerLauncher(name: string, conn: LauncherConn): string` — returns unique tenant (dedup `name`, `name#2`, …).
    - `unregisterLauncher(tenant: string): void`
    - `getLauncher(tenant: string): LauncherConn | undefined`
    - `hasTerminal(tenant: string): boolean`
    - `addViewer(tenant: string, v: Viewer): boolean` — false if no launcher for tenant.
    - `removeViewer(tenant: string, v: Viewer): void`
    - `primaryViewer(tenant: string): Viewer | undefined` — first-added remaining viewer.
    - `broadcastData(tenant: string, dataB64: string): void`
    - `tenantsWithTerminal(): Set<string>`

- [ ] **Step 1: Write failing test** `packages/relay/test/terminal-registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { TerminalRegistry, type Viewer } from "../src/terminal-registry.ts";

const launcher = () => ({ sendInput: () => {}, sendResize: () => {} });

describe("TerminalRegistry", () => {
  it("assigns the plain name then dedups with #N", () => {
    const r = new TerminalRegistry();
    expect(r.registerLauncher("alice", launcher())).toBe("alice");
    expect(r.registerLauncher("alice", launcher())).toBe("alice#2");
  });

  it("hasTerminal reflects launcher presence", () => {
    const r = new TerminalRegistry();
    const t = r.registerLauncher("alice", launcher());
    expect(r.hasTerminal(t)).toBe(true);
    r.unregisterLauncher(t);
    expect(r.hasTerminal(t)).toBe(false);
  });

  it("rejects viewers when no launcher, accepts and broadcasts otherwise", () => {
    const r = new TerminalRegistry();
    const seen: string[] = [];
    const v: Viewer = { sendData: (d) => seen.push(d) };
    expect(r.addViewer("ghost", v)).toBe(false);
    r.registerLauncher("alice", launcher());
    expect(r.addViewer("alice", v)).toBe(true);
    r.broadcastData("alice", "Zm9v");
    expect(seen).toEqual(["Zm9v"]);
  });

  it("tracks the primary viewer as the first remaining", () => {
    const r = new TerminalRegistry();
    r.registerLauncher("alice", launcher());
    const v1: Viewer = { sendData: () => {} };
    const v2: Viewer = { sendData: () => {} };
    r.addViewer("alice", v1); r.addViewer("alice", v2);
    expect(r.primaryViewer("alice")).toBe(v1);
    r.removeViewer("alice", v1);
    expect(r.primaryViewer("alice")).toBe(v2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/relay/test/terminal-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `packages/relay/src/terminal-registry.ts`:

```ts
export interface LauncherConn {
  sendInput(dataB64: string): void;
  sendResize(cols: number, rows: number): void;
}

export interface Viewer {
  sendData(dataB64: string): void;
  lastResize?: { cols: number; rows: number };
}

export class TerminalRegistry {
  private launchers = new Map<string, LauncherConn>();
  private viewers = new Map<string, Viewer[]>();

  registerLauncher(name: string, conn: LauncherConn): string {
    let tenant = name;
    let n = 2;
    while (this.launchers.has(tenant)) tenant = `${name}#${n++}`;
    this.launchers.set(tenant, conn);
    return tenant;
  }
  unregisterLauncher(tenant: string): void {
    this.launchers.delete(tenant);
    this.viewers.delete(tenant);
  }
  getLauncher(tenant: string): LauncherConn | undefined { return this.launchers.get(tenant); }
  hasTerminal(tenant: string): boolean { return this.launchers.has(tenant); }

  addViewer(tenant: string, v: Viewer): boolean {
    if (!this.launchers.has(tenant)) return false;
    const arr = this.viewers.get(tenant) ?? [];
    arr.push(v);
    this.viewers.set(tenant, arr);
    return true;
  }
  removeViewer(tenant: string, v: Viewer): void {
    const arr = this.viewers.get(tenant);
    if (!arr) return;
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) this.viewers.delete(tenant);
  }
  primaryViewer(tenant: string): Viewer | undefined { return this.viewers.get(tenant)?.[0]; }
  broadcastData(tenant: string, dataB64: string): void {
    for (const v of this.viewers.get(tenant) ?? []) v.sendData(dataB64);
  }
  tenantsWithTerminal(): Set<string> { return new Set(this.launchers.keys()); }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run packages/relay/test/terminal-registry.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/terminal-registry.ts packages/relay/test/terminal-registry.test.ts
git commit -m "feat(relay): terminal registry with launcher/viewer + primary geometry"
```

---

### Task 3: Relay terminal WS wiring + upgrade routing (`packages/relay`)

**Files:**
- Create: `packages/relay/src/terminal-server.ts`
- Modify: `packages/relay/src/server.ts`
- Test: `packages/relay/test/terminal-integration.test.ts`

**Interfaces:**
- Consumes: `TerminalRegistry` (Task 2), `term_*` frames (Task 1).
- Produces:
  - `function startTerminalServer(wssPty: WebSocketServer, wssViewer: WebSocketServer, registry: TerminalRegistry, token: string): void`
  - `startRelay` now also exposes the `TerminalRegistry` internally and routes upgrades: exact path `/agent` → A2A tunnel, `/pty` → launcher WS, `/agents/{tenant}/terminal` → viewer WS (bearer via subprotocol). The returned object is unchanged (`{ port, close }`).

- [ ] **Step 1: Write failing integration test** `packages/relay/test/terminal-integration.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/relay/test/terminal-integration.test.ts`
Expected: FAIL — viewer/launcher never connect (routes not wired).

- [ ] **Step 3: Implement** `packages/relay/src/terminal-server.ts`:

```ts
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
    const cleanup = () => { if (tenant) registry.unregisterLauncher(tenant); };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });

  // Browser viewers connect here (bearer already checked at upgrade).
  wssViewer.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const tenant = viewerTenant(req);
    if (!tenant) { ws.close(1011, "bad tenant"); return; }
    const viewer: Viewer = { sendData: (data) => { try { ws.send(encodeFrame({ type: "term_data", data })); } catch { /* dropped */ } } };
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
```

- [ ] **Step 4: Wire into** `packages/relay/src/server.ts`. Add imports at the top:

```ts
import { TerminalRegistry } from "./terminal-registry.ts";
import { startTerminalServer } from "./terminal-server.ts";
```

Inside `startRelay`, after the existing `startTunnelServer(...)` block and before `http.on("upgrade", ...)`, add:

```ts
  const terminalRegistry = new TerminalRegistry();
  const wssPty = new WebSocketServer({ noServer: true });
  const wssViewer = new WebSocketServer({ noServer: true, handleProtocols: () => "bearer" });
  startTerminalServer(wssPty, wssViewer, terminalRegistry, opts.token);
```

Replace the entire existing `http.on("upgrade", ...)` handler with:

```ts
  http.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/agent") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      return;
    }
    if (path === "/pty") {
      wssPty.handleUpgrade(req, socket, head, (ws) => wssPty.emit("connection", ws, req));
      return;
    }
    if (/^\/agents\/([^/]+)\/terminal$/.test(path)) {
      const proto = req.headers["sec-websocket-protocol"];
      const parts = typeof proto === "string" ? proto.split(",").map((s) => s.trim()) : [];
      if (parts[0] !== "bearer" || parts[1] !== opts.token) { socket.destroy(); return; }
      wssViewer.handleUpgrade(req, socket, head, (ws) => wssViewer.emit("connection", ws, req));
      return;
    }
    socket.destroy();
  });
```

In the `close` callback, also terminate the terminal sockets. Replace the `close` return field with:

```ts
    close: () => new Promise<void>((r) => {
      for (const client of wss.clients) client.terminate();
      for (const client of wssPty.clients) client.terminate();
      for (const client of wssViewer.clients) client.terminate();
      wss.close(); wssPty.close(); wssViewer.close();
      http.closeAllConnections(); http.close(() => r());
    }),
```

Finally, so Task 4 can reach it, change `startRelay` to return `terminalRegistry` internally by keeping it in scope — it is already in scope for the roster wiring done in Task 4 (same function). No signature change needed now.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run packages/relay/test/terminal-integration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Full relay suite (regression for the routing change)**

Run: `npx vitest run packages/relay`
Expected: PASS (existing A2A tests still green — `/agent` upgrade unaffected).

- [ ] **Step 7: Commit**

```bash
git add packages/relay/src/terminal-server.ts packages/relay/src/server.ts packages/relay/test/terminal-integration.test.ts
git commit -m "feat(relay): terminal WS namespaces (/pty + viewer) with bearer subprotocol auth"
```

---

### Task 4: Roster `terminal` flag (`packages/relay`)

**Files:**
- Modify: `packages/relay/src/http-surface.ts`, `packages/relay/src/server.ts`, `packages/relay/src/index.ts`
- Test: `packages/relay/test/http-surface.test.ts`

**Interfaces:**
- Consumes: `TerminalRegistry.hasTerminal` (Task 2).
- Produces: `GET /agents` now returns `{ agents: [{ tenant, card, terminal: boolean }] }`. `createHttpHandler` gains an optional `hasTerminal` predicate in its `opts`.

- [ ] **Step 1: Add a failing test** — append to `packages/relay/test/http-surface.test.ts` a test that a terminal-backed tenant is flagged. First extend the `beforeEach` handler creation to pass the predicate. In the existing `beforeEach`, replace the `createHttpHandler(registry, pending, "secret")` line with:

```ts
  const handler = createHttpHandler(registry, pending, "secret", { hasTerminal: (t) => t === "backend" });
```

Then add:

```ts
it("marks tenants that have a terminal", async () => {
  const res = await fetch(`${base}/agents`, { headers: { authorization: "Bearer secret" } });
  const body = await res.json();
  expect(body.agents[0].terminal).toBe(true);
});
```

Also update the existing "lists agents" assertion to tolerate the new field:

```ts
expect(body.agents).toEqual([{ tenant: "backend", card, terminal: true }]);
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/relay/test/http-surface.test.ts`
Expected: FAIL — `terminal` is `undefined`.

- [ ] **Step 3: Implement** in `packages/relay/src/http-surface.ts`. Change the `opts` type and the `/agents` handler.

Change the `createHttpHandler` signature options to:

```ts
export function createHttpHandler(
  registry: AgentRegistry,
  pending: PendingRequests,
  token: string,
  opts?: { requestTimeoutMs?: number; hasTerminal?: (tenant: string) => boolean },
) {
```

Replace the `/agents` list line with:

```ts
    if (req.method === "GET" && path === "/agents") {
      const hasTerminal = opts?.hasTerminal ?? (() => false);
      const agents = registry.list().map((a) => ({ ...a, terminal: hasTerminal(a.tenant) }));
      return send(res, 200, { agents });
    }
```

- [ ] **Step 4: Thread the predicate in** `packages/relay/src/server.ts`. Change the `createHttpHandler` call to include the terminal registry. Since `terminalRegistry` is created in Task 3 *after* `handler`, move the `createHttpHandler` call to *after* the `terminalRegistry` creation. Concretely, delete the original:

```ts
  const handler = createHttpHandler(registry, pending, opts.token, { requestTimeoutMs });
  const http = createServer(handler);
```

and instead create the http server with a late-bound handler. Replace with:

```ts
  const terminalRegistry = new TerminalRegistry();
  const handler = createHttpHandler(registry, pending, opts.token, {
    requestTimeoutMs,
    hasTerminal: (t) => terminalRegistry.hasTerminal(t),
  });
  const http = createServer(handler);
```

Then in the Task 3 block, remove the now-duplicate `const terminalRegistry = new TerminalRegistry();` line (it now lives here), keeping only the `wssPty`/`wssViewer`/`startTerminalServer` lines.

- [ ] **Step 5: Update the startup log** in `packages/relay/src/index.ts`:

```ts
startRelay({ port, token }).then(({ port }) => {
  console.log(`pi-comm relay listening on http://127.0.0.1:${port} (agents: ws://.../agent, pty: ws://.../pty, terminal: ws://.../agents/{tenant}/terminal)`);
});
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run packages/relay`
Expected: PASS (http-surface + terminal + existing tests).

- [ ] **Step 7: Commit**

```bash
git add packages/relay && git commit -m "feat(relay): expose terminal availability in the roster"
```

---

### Task 5: PTY-host core (`packages/pty-host`)

**Files:**
- Create: `packages/pty-host/package.json`, `packages/pty-host/src/pty-host.ts`
- Test: `packages/pty-host/test/pty-host.test.ts`

**Interfaces:**
- Consumes: `term_*` frames (Task 1).
- Produces:
  - `type SpawnFn = (file: string, args: string[], opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => PtyLike`
  - `interface PtyLike { onData(cb: (d: string) => void): void; onExit(cb: () => void): void; write(data: string): void; resize(cols: number, rows: number): void; kill(): void; }`
  - `class PtyHost` with `start(): Promise<void>`, `get tenant(): string | null`, `close(): void`. Constructor: `new PtyHost(opts, deps?)` where `opts: { wsUrl; token; name; command; args; cwd; env; cols?; rows? }` and `deps?: { spawn?: SpawnFn }` (defaults to `node-pty`).

- [ ] **Step 1: Create** `packages/pty-host/package.json`:

```json
{
  "name": "@pi-comm/pty-host",
  "version": "0.0.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "pi-comm-pty-host": "src/index.ts" },
  "scripts": { "start": "node --experimental-strip-types src/index.ts" },
  "dependencies": { "@pi-comm/a2a-contract": "*", "ws": "^8.18.0", "node-pty": "^1.0.0" },
  "devDependencies": { "@types/ws": "^8.5.12" }
}
```

- [ ] **Step 2: Write failing test** `packages/pty-host/test/pty-host.test.ts` (uses an in-process relay stub + a fake PTY; no native build needed):

```ts
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
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run packages/pty-host/test/pty-host.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement** `packages/pty-host/src/pty-host.ts`:

```ts
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
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run packages/pty-host/test/pty-host.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Commit**

```bash
git add packages/pty-host && git commit -m "feat(pty-host): node-pty <-> relay pump with injectable spawn"
```

---

### Task 6: PTY-host config + CLI (`packages/pty-host`)

**Files:**
- Create: `packages/pty-host/src/config.ts`, `packages/pty-host/src/index.ts`
- Test: `packages/pty-host/test/config.test.ts`

**Interfaces:**
- Consumes: `PtyHost` (Task 5).
- Produces:
  - `interface PtyHostConfig { wsUrl: string; token: string; name: string; command: string; args: string[]; cwd: string; }`
  - `function resolvePtyConfig(input: { envRelayUrl?: string; envToken?: string; flagName?: string; command?: string; args?: string[]; cwd: string }): PtyHostConfig`
    - Relay URL precedence: `envRelayUrl` > default `http://127.0.0.1:8787`; `wsUrl` = swap `http`→`ws`/`https`→`wss`, strip trailing slashes, append `/pty`.
    - Token: `envToken` (throws `Error("A2A_RELAY_TOKEN not set")` if missing).
    - Name: `flagName` > basename of `cwd`.
    - Command: `command` > default `"pi"`; `args` default `[]`.

- [ ] **Step 1: Write failing test** `packages/pty-host/test/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolvePtyConfig } from "../src/config.ts";

const base = { cwd: "/home/u/alice", envToken: "tok" };

describe("resolvePtyConfig", () => {
  it("defaults relay url and derives the /pty ws url", () => {
    const c = resolvePtyConfig(base);
    expect(c.wsUrl).toBe("ws://127.0.0.1:8787/pty");
  });
  it("derives wss for https relays", () => {
    expect(resolvePtyConfig({ ...base, envRelayUrl: "https://relay.example.com" }).wsUrl).toBe("wss://relay.example.com/pty");
  });
  it("uses cwd basename as default name and pi as default command", () => {
    const c = resolvePtyConfig(base);
    expect(c.name).toBe("alice");
    expect(c.command).toBe("pi");
    expect(c.args).toEqual([]);
  });
  it("prefers flag name and passes through command/args", () => {
    const c = resolvePtyConfig({ ...base, flagName: "api", command: "pi", args: ["-e", "x.ts"] });
    expect(c.name).toBe("api");
    expect(c.args).toEqual(["-e", "x.ts"]);
  });
  it("throws when the token is missing", () => {
    expect(() => resolvePtyConfig({ ...base, envToken: undefined })).toThrow(/A2A_RELAY_TOKEN/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/pty-host/test/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `packages/pty-host/src/config.ts`:

```ts
import { basename } from "node:path";

export interface PtyHostConfig {
  wsUrl: string; token: string; name: string; command: string; args: string[]; cwd: string;
}

export function resolvePtyConfig(input: {
  envRelayUrl?: string; envToken?: string; flagName?: string;
  command?: string; args?: string[]; cwd: string;
}): PtyHostConfig {
  const relayHttpUrl = (input.envRelayUrl || "http://127.0.0.1:8787").replace(/\/+$/, "");
  const wsUrl = relayHttpUrl.replace(/^http/, "ws") + "/pty";
  if (!input.envToken) throw new Error("A2A_RELAY_TOKEN not set");
  const name = input.flagName || basename(input.cwd);
  return {
    wsUrl, token: input.envToken, name,
    command: input.command || "pi",
    args: input.args ?? [],
    cwd: input.cwd,
  };
}
```

- [ ] **Step 4: Implement** `packages/pty-host/src/index.ts` (CLI). Parses `--name <n>` and treats everything after `--` as the command + args (default `pi`):

```ts
import { resolvePtyConfig } from "./config.ts";
import { PtyHost } from "./pty-host.ts";

function parseArgs(argv: string[]): { flagName?: string; command?: string; args?: string[] } {
  let flagName: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") { flagName = argv[++i]; continue; }
    if (a === "--") { rest.push(...argv.slice(i + 1)); break; }
    rest.push(a);
  }
  const [command, ...args] = rest;
  return { flagName, command, args };
}

const parsed = parseArgs(process.argv.slice(2));
let config;
try {
  config = resolvePtyConfig({
    envRelayUrl: process.env.A2A_RELAY_URL,
    envToken: process.env.A2A_RELAY_TOKEN,
    flagName: parsed.flagName,
    command: parsed.command,
    args: parsed.args,
    cwd: process.cwd(),
  });
} catch (e) {
  console.error(`pty-host: ${(e as Error).message}`);
  process.exit(1);
}

const host = new PtyHost({
  wsUrl: config.wsUrl,
  token: config.token,
  name: config.name,
  command: config.command,
  args: config.args,
  cwd: config.cwd,
  env: process.env as Record<string, string>,
});

host.start()
  .then(() => console.log(`pty-host: '${config.command}' attached as terminal tenant '${host.tenant}'`))
  .catch((e) => { console.error(`pty-host: connect failed — ${(e as Error).message}`); process.exit(1); });

process.on("SIGINT", () => { host.close(); process.exit(0); });
process.on("SIGTERM", () => { host.close(); process.exit(0); });
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run packages/pty-host`
Expected: PASS (config + pty-host tests).

- [ ] **Step 6: Commit**

```bash
git add packages/pty-host && git commit -m "feat(pty-host): config resolution + CLI entrypoint"
```

---

### Task 7: Web terminal client (`apps/web`)

**Files:**
- Create: `apps/web/src/terminal-client.ts`
- Test: `apps/web/test/terminal-client.test.ts`

**Interfaces:**
- Produces:
  - `interface TerminalHandlers { onData: (bytes: Uint8Array) => void; onClose: () => void; }`
  - `class TerminalClient` with `constructor(opts: { wsBaseUrl: string; token: string; tenant: string })`, `connect(handlers: TerminalHandlers): void`, `sendInput(data: string): void`, `sendResize(cols: number, rows: number): void`, `close(): void`.
  - Wire format matches the relay: incoming `{ type: "term_data", data }` (base64) → `onData(bytes)`; outgoing `{ type: "term_input", data }` (base64) and `{ type: "term_resize", cols, rows }`.

- [ ] **Step 1: Write failing test** `apps/web/test/terminal-client.test.ts` (injects a fake global `WebSocket`):

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { TerminalClient } from "../src/terminal-client.ts";

class FakeWS {
  static last: FakeWS | null = null;
  url: string; protocols: string[]; sent: string[] = [];
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
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/web/test/terminal-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `apps/web/src/terminal-client.ts`:

```ts
export interface TerminalHandlers {
  onData: (bytes: Uint8Array) => void;
  onClose: () => void;
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

  constructor(private opts: { wsBaseUrl: string; token: string; tenant: string }) {}

  connect(handlers: TerminalHandlers): void {
    const base = this.opts.wsBaseUrl || location.origin.replace(/^http/, "ws");
    const url = `${base}/agents/${encodeURIComponent(this.opts.tenant)}/terminal`;
    const ws = new WebSocket(url, ["bearer", this.opts.token]);
    this.ws = ws;
    ws.onmessage = (ev: MessageEvent) => {
      let f: { type?: string; data?: string };
      try { f = JSON.parse(ev.data as string); } catch { return; }
      if (f.type === "term_data" && typeof f.data === "string") handlers.onData(base64ToBytes(f.data));
    };
    ws.onclose = () => handlers.onClose();
  }

  sendInput(data: string): void {
    const b64 = bytesToBase64(new TextEncoder().encode(data));
    this.ws?.send(JSON.stringify({ type: "term_input", data: b64 }));
  }
  sendResize(cols: number, rows: number): void {
    this.ws?.send(JSON.stringify({ type: "term_resize", cols, rows }));
  }
  close(): void { this.ws?.close(); }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run apps/web/test/terminal-client.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/terminal-client.ts apps/web/test/terminal-client.test.ts
git commit -m "feat(web): terminal WS client (base64 term_ frames, bearer subprotocol)"
```

---

### Task 8: Web `Terminal.tsx` + tabs + deps + proxy + runbook (`apps/web`)

**Files:**
- Create: `apps/web/src/components/Terminal.tsx`
- Modify: `apps/web/src/App.tsx`, `apps/web/src/a2a-client.ts`, `apps/web/package.json`, `apps/web/vite.config.ts`, `vitest.config.ts`, `docs/RUNBOOK.md`
- Test: `apps/web/test/terminal-component.test.tsx`

**Interfaces:**
- Consumes: `TerminalClient` (Task 7), `@xterm/xterm`, `@xterm/addon-fit`.
- Produces: `<Terminal client={A2AClient|null} baseUrl token tenant />` component; App shows a Chat/Terminal tab per selected tenant. `A2AClient.listAgents()` return type includes `terminal?: boolean`.

- [ ] **Step 1: Add dependencies** to `apps/web/package.json`. Set `dependencies` and `devDependencies` to:

```json
  "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1", "@pi-comm/a2a-contract": "*", "@xterm/xterm": "^5.5.0", "@xterm/addon-fit": "^0.10.0" },
  "devDependencies": { "vite": "^5.4.0", "@vitejs/plugin-react": "^4.3.0", "@types/react": "^18.3.0", "@types/react-dom": "^18.3.0", "jsdom": "^25.0.0", "@testing-library/react": "^16.0.0" }
```

Then run: `cd /home/qmiclap/gitrepos/pi-comm && npm install`
Expected: installs `@xterm/*`, `jsdom`, `@testing-library/react`.

- [ ] **Step 2: Enable the ws proxy** — in `apps/web/vite.config.ts`, add `ws: true` to the `/agents` proxy entry (so terminal WS upgrades reach the relay same-origin):

```ts
      "/agents": {
        target: relayTarget,
        changeOrigin: true,
        ws: true,
```

(keep the existing `configure` block unchanged.)

- [ ] **Step 3: Teach the root test runner about TSX + JSX** — in `vitest.config.ts` (repo root), update the include globs to also match `.test.tsx` and enable the automatic JSX runtime so component tests need no explicit React import. Replace the file with:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Write failing component test** `apps/web/test/terminal-component.test.tsx` (jsdom; mocks xterm and TerminalClient; stubs `ResizeObserver` which jsdom lacks):

```tsx
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Terminal } from "../src/components/Terminal.tsx";

const writes: (string | Uint8Array)[] = [];
let dataHandler: ((d: string) => void) | null = null;

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80; rows = 24;
    open() {}
    write(d: string | Uint8Array) { writes.push(d); }
    onData(cb: (d: string) => void) { dataHandler = cb; }
    dispose() {}
    loadAddon() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

const inputs: string[] = [];
let onDataCb: ((b: Uint8Array) => void) | null = null;
vi.mock("../src/terminal-client.ts", () => ({
  TerminalClient: class {
    connect(h: { onData: (b: Uint8Array) => void }) { onDataCb = h.onData; }
    sendInput(d: string) { inputs.push(d); }
    sendResize() {}
    close() {}
  },
}));

beforeEach(() => {
  writes.length = 0; inputs.length = 0; dataHandler = null; onDataCb = null;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
});

describe("Terminal component", () => {
  it("writes incoming term data to xterm and forwards keystrokes", () => {
    render(<Terminal baseUrl="ws://relay" token="t" tenant="alice" />);
    onDataCb!(new TextEncoder().encode("hello"));
    expect(writes.length).toBeGreaterThan(0);
    dataHandler!("x");
    expect(inputs).toContain("x");
    cleanup();
  });
});
```

- [ ] **Step 5: Run to verify failure**

Run: `npx vitest run apps/web/test/terminal-component.test.tsx`
Expected: FAIL — `Terminal.tsx` not found.

- [ ] **Step 6: Implement** `apps/web/src/components/Terminal.tsx`:

```tsx
import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TerminalClient } from "../terminal-client.ts";

export function Terminal({ baseUrl, token, tenant }: { baseUrl: string; token: string; tenant: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const term = new XTerm({ convertEol: false, fontSize: 13, theme: { background: "#111111" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const client = new TerminalClient({ wsBaseUrl: baseUrl, token, tenant });
    client.connect({
      onData: (bytes) => term.write(bytes),
      onClose: () => term.write("\r\n\x1b[31m[terminal disconnected]\x1b[0m\r\n"),
    });
    client.sendResize(term.cols, term.rows);
    const disposable = term.onData((d) => client.sendInput(d));

    const onResize = () => { fit.fit(); client.sendResize(term.cols, term.rows); };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    return () => { ro.disconnect(); disposable.dispose(); client.close(); term.dispose(); };
  }, [baseUrl, token, tenant]);

  return <div ref={hostRef} style={{ flex: 1, minHeight: 0, background: "#111" }} />;
}
```

- [ ] **Step 7: Add the `terminal` field** to `apps/web/src/a2a-client.ts`. Change the `listAgents` return type and cast:

```ts
  async listAgents(): Promise<Array<{ tenant: string; card: AgentCard; terminal?: boolean }>> {
    const res = await fetch(`${this.opts.baseUrl}/agents`, { headers: this.auth() });
    if (!res.ok) throw new Error(`listAgents HTTP ${res.status}`);
    return (await res.json() as { agents: Array<{ tenant: string; card: AgentCard; terminal?: boolean }> }).agents;
  }
```

- [ ] **Step 8: Wire the tab** in `apps/web/src/App.tsx`. Add the import and a view-mode state, and swap the center pane. Change the imports block to add:

```tsx
import { Terminal } from "./components/Terminal.tsx";
```

Add a `view` state after `selected`:

```tsx
  const [view, setView] = useState<"chat" | "terminal">("chat");
```

Replace the center-pane expression `{selected ? <Chat .../> : <section .../>}` with:

```tsx
        {selected ? (
          <section style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ display: "flex", gap: 8, padding: 8, borderBottom: "1px solid var(--border, #333)" }}>
              <button onClick={() => setView("chat")} disabled={view === "chat"}>Chat</button>
              <button onClick={() => setView("terminal")} disabled={view === "terminal"}>Terminal</button>
            </div>
            {view === "chat"
              ? <Chat key={`chat-${selected}`} client={client} tenant={selected} />
              : <Terminal key={`term-${selected}`} baseUrl={baseUrl} token={token} tenant={selected} />}
          </section>
        ) : (
          <section style={{ flex: 1, display: "grid", placeItems: "center", opacity: 0.6 }}>Select an agent</section>
        )}
```

- [ ] **Step 9: Run to verify pass**

Run: `npx vitest run apps/web`
Expected: PASS (a2a-client + terminal-client + terminal-component tests).

- [ ] **Step 10: Build the web app (smoke)**

Run: `cd /home/qmiclap/gitrepos/pi-comm && npm run build --workspace @pi-comm/web`
Expected: Vite build succeeds (xterm imports resolve).

- [ ] **Step 11: Document in** `docs/RUNBOOK.md` — append a new section:

````markdown
---

## Web terminal (xterm.js) — controlling a remote Pi

> **⚠️ Security:** the web terminal is a *full interactive remote shell* into the Pi
> process. Pi has no sandbox — its tools read/write files and run shell commands with
> the host user's permissions. Only run the relay on `127.0.0.1` (default) unless you
> understand the exposure, and treat `A2A_RELAY_TOKEN` as a shell credential.

### Start the relay (as above), then launch a PTY-host that wraps Pi

```bash
cd ~/tmp/agent-a
A2A_RELAY_TOKEN=dev \
A2A_RELAY_URL=http://127.0.0.1:8787 \
node --experimental-strip-types ~/gitrepos/pi-comm/packages/pty-host/src/index.ts \
  --name alice -- \
  pi -e ~/gitrepos/pi-comm/packages/pi-extension/src/index.ts --a2a-name alice
```

This runs the real `pi` under a PTY as terminal tenant `alice`, while the inner
`pi-extension` still exposes the A2A channel under the same name.

### Open the web app and click "Terminal"

Start the web dev server (`npm run dev --workspace @pi-comm/web`), open it, select
`alice` in the roster, and switch to the **Terminal** tab. You get the full Pi TUI —
`/new`, `/resume`, skills, tool rendering — driven from the browser. Keystrokes and
resizes flow to the PTY; ANSI output streams back to `xterm.js`.

Note: the first browser tab to connect is the geometry "primary" (its size drives the
PTY). Any connected tab can type.
````

- [ ] **Step 12: Commit**

```bash
git add apps/web docs/RUNBOOK.md vitest.config.ts && git commit -m "feat(web): xterm.js terminal tab + pty-host runbook"
```

---

## Final verification

- [ ] Run the full suite: `cd /home/qmiclap/gitrepos/pi-comm && npm test` → all packages green.
- [ ] Typecheck: `npm run typecheck` → no errors.
- [ ] Manual smoke (optional): relay + pty-host wrapping a trivial command (`node --experimental-strip-types packages/pty-host/src/index.ts --name t -- bash`), open the web Terminal tab, confirm a live shell.
