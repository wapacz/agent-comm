# Decouple Terminal Discovery from A2A — Design

**Status:** Approved for planning
**Date:** 2026-07-14

## Problem

The web UI is terminal-only, yet it discovers agents through the **A2A** registry:
`GET /agents` lists `AgentRegistry` entries (populated by the inner **pi-extension**),
and the terminal availability is a `terminal` flag bolted onto each entry via
`TerminalRegistry.hasTerminal(tenant)`. Consequences:

- An agent (and its terminal) appears in the UI **only if the inner extension
  registered A2A** under the same name as the external pty-host.
- The terminal path — the one thing the UI actually uses — depends on A2A, which the
  UI no longer uses for anything else.
- You cannot wrap an arbitrary command (e.g. `bash`, or `pi` without the extension)
  with the pty-host and see it in the UI.

The terminal **streaming** path is already independent (`/agents/{tenant}/terminal`
reads `TerminalRegistry`). Only **discovery/roster** is coupled.

## Goal

Two independent relay roles, two registries, two endpoints. The **pty-host** (external)
self-registers a terminal identity and powers the UI roster; **A2A** (inner extension)
is orthogonal, for agent-to-agent messaging. Neither depends on the other; they need
not share a name.

## Design

### 1. Contract (`packages/a2a-contract/src/tunnel.ts`)

`TermRegisterFrame` gains an optional `description`:
`{ type: "term_register"; token: string; name: string; description?: string }`.

### 2. Relay terminal registry (`packages/relay/src/terminal-registry.ts`)

- `registerLauncher(name, conn, meta?: { description?: string }): string` stores the
  optional description alongside the connection.
- New `listTerminals(): Array<{ tenant: string; description?: string }>`.
- Existing methods (`getLauncher`, `hasTerminal`, viewer methods, `unregisterLauncher`
  returning removed viewers, `primaryViewer`, `broadcastData`) unchanged.

### 3. Relay terminal server (`packages/relay/src/terminal-server.ts`)

Pass `description` from the `term_register` frame into `registerLauncher`.

### 4. Relay HTTP surface (`packages/relay/src/http-surface.ts`, `server.ts`)

- Add `GET /terminals` (bearer-protected) → `{ terminals: [{ tenant, description }] }`
  from `TerminalRegistry.listTerminals()`.
- **Remove** the `terminal` field from `GET /agents` — `/agents` returns pure A2A
  (`{ agents: [{ tenant, card }] }`). Drop the `hasTerminal` predicate from
  `createHttpHandler`; add a `listTerminals` accessor instead.
- `message:send` / `message:stream` unchanged.

### 5. Web (`apps/web`)

- Client: add `listTerminals(): Promise<Array<{ tenant: string; description?: string }>>`
  hitting `GET /terminals`.
- `Roster.tsx`: read `listTerminals()` instead of `listAgents()`; render `tenant`
  (+ `description`); `onSelect(tenant)` (every listed entry has a terminal).
- `App.tsx`: drop `selectedHasTerminal`; a selected agent always renders `<Terminal>`.

### 6. pty-host (`packages/pty-host`)

- Config gains `description` (default: the wrapped command name, e.g. `pi` or `bash`);
  optional `--description` CLI flag.
- `PtyHost` sends `description` in `term_register`.
- No dependency on the inner extension.

## Registry / role model

The relay runs **both roles in parallel** (no startup mode switch):

| Role | Registry | Register via | Read/served via |
|------|----------|--------------|-----------------|
| Terminal | `TerminalRegistry` | pty-host `term_register` (WS `/pty`) | `GET /terminals`, `/agents/{tenant}/terminal` |
| A2A | `AgentRegistry` | pi-extension `register` (WS `/agent`) | `GET /agents`, `message:send/stream` |

An agent may appear in either, both, or neither; the two are keyed independently and
carry no cross-dependency.

## Out of Scope

- Unified roster view combining both registries (explicitly rejected: split chosen).
- Startup `--mode` flag (relay always serves both roles).
- Removing the now-unused `Chat.tsx` / `ToolCallPanel.tsx` / A2A client send/stream
  methods (kept for possible reuse).
- Auth changes (same bearer token gates `/terminals`).

## Testing

- Contract: `term_register` with `description` round-trips.
- Terminal registry: `listTerminals()` returns registered tenants with descriptions;
  dedup naming still applies.
- Relay HTTP: `GET /terminals` lists terminal tenants (bearer-gated, 401 without token);
  `GET /agents` no longer carries a `terminal` field.
- pty-host: `description` is included in the `term_register` frame; config default is the
  command name.
- Web: `listTerminals()` parses the `/terminals` payload; `Roster` renders terminal
  entries.
