# Web Terminal Passthrough for Pi via Relay — Design

**Status:** Approved for planning
**Date:** 2026-07-14

## Goal

Let a web browser act as a **full remote control** of a real Pi agent running on a
host, by mirroring Pi's terminal (TUI) into an `xterm.js` view in the browser and
forwarding keystrokes back. This exposes **everything** Pi offers — slash commands
(`/new`, `/resume`, `/tree`), skills, tool rendering, colors, spinners — because the
browser is driving the actual Pi process, not a re-implementation of it.

This runs as a **new, parallel channel alongside the existing A2A message surface**.
An agent may expose both channels at once: the A2A message surface (agent-to-agent,
programmatic) and the terminal channel (human control from the web).

## Key Architectural Facts (why this shape)

- **Pi's core cannot run in the browser.** Tools (bash, file edits), skills, sessions
  (`/new`, `/resume` read/write files on disk), and extensions all require the host's
  filesystem and shell. Real Pi must run on the host.
- **Pi's TUI speaks ANSI, and `xterm.js` renders ANSI.** `pi-tui` components expose
  `render(width): string[]` (ANSI lines) and `handleInput(data)`. So mirroring the
  real TUI's byte stream into `xterm.js` yields a pixel-faithful view with zero
  re-implementation and no drift from upstream Pi.
- **The existing `pi-extension` cannot capture Pi's own stdout** — it runs *inside*
  Pi. Capturing the terminal requires wrapping Pi from the outside under a PTY.
- **pi ↔ relay is NOT A2A.** It is our own WebSocket tunnel frame protocol
  (`tunnel.ts`). We are free to add terminal frames there. A2A is only the relay's
  HTTP surface to clients.

## Architecture

Three cooperating parts, plus the unchanged A2A path.

### a) PTY-host (new package `packages/pty-host`)

A small launcher process that runs on the agent's host:

- Spawns the real `pi` process under a pseudo-terminal (`node-pty`).
- Connects to the relay over WebSocket and registers a tenant (reusing the token auth).
- Pumps bytes both ways:
  - PTY stdout → relay as `term_data`
  - relay `term_input` → PTY stdin
  - relay `term_resize` → `pty.resize(cols, rows)`
- Reconnect with backoff and heartbeat, following the existing `RelayClient` pattern.

The in-Pi `pi-extension` continues to handle A2A independently. For a single logical
agent this means **two WebSocket connections to the relay**: one from the PTY-host
(terminal) and one from the `pi-extension` (A2A). They are linked by sharing the same
agent name.

### b) Relay (extend `packages/relay`)

- New `TerminalRegistry` mapping `tenant -> PTY connection`, independent of the A2A
  `AgentRegistry`.
- New WS namespaces on the existing HTTP server upgrade path:
  - `ws://relay/pty` — PTY-host launchers connect here (`term_register`, `term_data`,
    ...).
  - `ws://relay/agents/{tenant}/terminal` — web browsers connect here to view/control.
- Fan-out: relay bridges bytes between the one PTY connection for a tenant and any
  connected web clients.
- `GET /agents` roster gains a `terminal: boolean` field per tenant so the web knows a
  terminal is available to open.

### c) Web (extend `apps/web`)

- New `Terminal.tsx` component: `@xterm/xterm` + fit addon.
- Opens `ws://.../agents/{tenant}/terminal`; on open sends initial `cols/rows`.
- `term_data` → `term.write()`; `term.onData()` → `term_input`; fit/resize →
  `term_resize`.
- Sits alongside the existing `Chat.tsx`; a per-tenant tab/toggle switches between
  "Chat" (A2A) and "Terminal" (xterm.js).

## Tunnel Protocol Additions (`packages/a2a-contract/src/tunnel.ts`)

New frame types (JSON, `type`-discriminated, same style as existing frames):

- launcher → relay: `term_register { type: "term_register"; token: string; name: string }`
- relay → launcher: `term_registered { type: "term_registered"; tenant: string }`
- launcher → relay: `term_data { type: "term_data"; data: string }` — `data` is
  base64-encoded PTY bytes (JSON-safe binary).
- relay → launcher: `term_input { type: "term_input"; data: string }` — base64 keystrokes.
- relay → launcher: `term_resize { type: "term_resize"; cols: number; rows: number }`

`parseTunnelFrame` / `encodeFrame` extended; `KNOWN` set updated. Web ↔ relay uses the
same `term_data` / `term_input` / `term_resize` shapes (the relay just relays them; it
does not need to decode base64).

## Data Flow

1. PTY-host connects to `/pty`, sends `term_register` → relay assigns tenant, replies
   `term_registered`, sets status.
2. Web opens `/agents/{tenant}/terminal`; `xterm.js` sends an initial `term_resize`
   with its `cols/rows`.
3. Relay links web ↔ launcher for that tenant. PTY output flows to the web
   (`term.write`); web keystrokes flow to the PTY (`term_input`).
4. On disconnect, relay cleans up the mapping; PTY-host keeps Pi alive (a dropped web
   viewer must not kill the session); PTY-host reconnects to relay on relay loss.

## Multiple Viewers & Geometry

A PTY has a single size, so:

- **First connected viewer is "primary"** — its `cols/rows` drive `pty.resize`.
- Additional viewers see the same stream and may letterbox (black margins) if their
  window differs.
- Per the chosen control mode (full control), **any connected viewer can type**. A
  "take control" lock is explicitly out of scope for v1 (YAGNI); can be added later.

## Security (acknowledged risk)

- Interactive web control is a **remote shell** with the permissions of the Pi process.
  Pi has **no sandbox**; built-in tools read/write files and run shell commands.
- Gate: the same `A2A_RELAY_TOKEN` Bearer is **required on the terminal WS** (both
  `/pty` and `/agents/{tenant}/terminal`), exactly as for the A2A surface.
- Never log the token or raw terminal bytes at info level.
- Relay defaults to binding `127.0.0.1`. Remote exposure is the operator's explicit,
  documented choice.
- The RUNBOOK documents this as the primary risk of the feature.

## Testing

- **Contract:** round-trip of every new `term_*` frame through
  `parseTunnelFrame`/`encodeFrame`; rejection of malformed frames.
- **Relay fan-out:** a fake launcher WS + a fake web WS; assert PTY bytes reach the web
  client, web keystrokes reach the launcher, `term_resize` is forwarded, and cleanup
  happens on disconnect (viewer drop does not unregister the terminal).
- **PTY-host:** spawn a dummy command under a PTY (e.g. `cat` or `node -e`), send input
  through the relay path, assert it echoes back as `term_data`; assert `resize` calls
  `pty.resize`.
- **Web:** `Terminal.tsx` mounts an `xterm.js` instance (mocked) in jsdom; assert
  `onmessage` with `term_data` calls `term.write`, and `term.onData` sends `term_input`.

## Out of Scope (v1)

- "Take control" locking / read-only viewers (all viewers can type).
- Per-viewer independent geometry (only primary drives PTY size).
- Session recording/replay, scrollback persistence server-side.
- Authn beyond the shared bearer token (no per-user identity/RBAC).
