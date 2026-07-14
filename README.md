# pi-comm

A lightweight relay that fronts multiple [Pi](https://github.com/earendil-works/pi-coding-agent) coding-agent sessions and exposes them over two independent channels:

- **Terminal** — control a real Pi session (its full TUI: `/new`, `/resume`, skills, tool rendering) from a browser via [xterm.js](https://xtermjs.org/).
- **A2A** — a minimal, message-only [A2A](https://google.github.io/A2A/) HTTP surface for agent-to-agent (and programmatic) messaging.

Agents dial **outbound** to the relay over WebSocket (no inbound ports, NAT-friendly). The relay runs both roles in parallel and routes each request to the right session.

## Architecture

```
                          ┌───────────────────────── relay ─────────────────────────┐
  browser (xterm.js) ──ws─┤  /agents/{tenant}/terminal  ──┐                          │
                          │  GET /terminals               │  TerminalRegistry        │
                          │                               └── /pty  ◄──ws── pty-host ──┼── spawns ─► real `pi` (PTY)
                          │                                                          │
  A2A client / agent ─http┤  GET /agents, message:send/stream                        │
                          │                               AgentRegistry ◄──ws── /agent ┼── pi-extension (inside pi)
                          └──────────────────────────────────────────────────────────┘
```

- **Terminal role** — the external **pty-host** wraps a real `pi` process under a PTY, registers into `TerminalRegistry`, and streams bytes. The web reads `GET /terminals` and opens `ws /agents/{tenant}/terminal`.
- **A2A role** — the inner **pi-extension** (loaded inside `pi`) registers into `AgentRegistry` and serves `GET /agents` + `message:send/stream`.

The two roles are **independent**: a terminal is discoverable and controllable without A2A, and A2A works without a terminal. They need not share a name.

## Packages (npm workspaces)

| Package | Role |
|---------|------|
| `packages/a2a-contract` | Shared A2A types + agent↔relay WebSocket tunnel frame protocol + validators |
| `packages/relay` | The relay: agent + terminal registries, WS tunnel/terminal servers, HTTP A2A surface |
| `packages/pi-extension` | Pi extension: A2A relay client, inbound serving, `a2a_list` / `a2a_send` tools |
| `packages/pty-host` | External launcher: wraps `pi` under `node-pty` and bridges the terminal to the relay |
| `apps/web` | Vite + React app: terminal roster + xterm.js viewer |

## Quickstart

Requires **Node ≥ 20** and the `pi` CLI (`@earendil-works/pi-coding-agent`).

```bash
npm install
```

**1. Start the relay**

```bash
RELAY_TOKEN=dev node --experimental-strip-types packages/relay/src/index.ts
# → pi-comm relay listening on http://127.0.0.1:8787
```

**2. Launch a PTY-host wrapping a real Pi (terminal + A2A under one name)**

```bash
mkdir -p ~/tmp/agent-a && cd ~/tmp/agent-a
RELAY_TOKEN=dev RELAY_URL=http://127.0.0.1:8787 \
node --experimental-strip-types ~/gitrepos/pi-comm/packages/pty-host/src/index.ts \
  --name alice --description "pi session" -- \
  pi -e ~/gitrepos/pi-comm/packages/pi-extension/src/index.ts --a2a-name alice
```

You can wrap **any** command (the terminal channel needs no A2A extension):

```bash
node --experimental-strip-types packages/pty-host/src/index.ts --name scratch -- bash
```

**3. Start the web app**

```bash
npm run dev --workspace @pi-comm/web
```

Open the printed URL, open **Settings** (gear icon), enter the **token** (`dev`), pick a terminal in the roster.

## Docker (relay + web in one container)

The relay can serve the built web app on its own port (same-origin, no proxy), so a single container runs everything: the web UI, the A2A surface, and the terminal role.

```bash
docker build -t pi-comm .
docker run --rm -e RELAY_TOKEN=<token> -p 8787:8787 pi-comm
```

The image installs only the relay + web + contract workspaces from the public npm registry — it does **not** pull `pi-coding-agent` or build `node-pty` (those belong to the pty-host, which runs on the agent machines). A plain `docker build` works anywhere with public-npm access; the resulting image needs no registry at runtime.

> If your Docker build network cannot reach `registry.npmjs.org` (locked-down corp network), build with host networking: `docker build --network=host -t pi-comm .`

Open `http://localhost:8787`, set the token in **Settings**. Agents connect from their own machines by pointing `RELAY_URL` at the container (e.g. run a pty-host with `RELAY_URL=http://<host>:8787`). Env: `RELAY_TOKEN` (required), `RELAY_PORT` (default `8787`), `RELAY_WEB_DIR` (default `/app/apps/web/dist`).

## HTTP / WS endpoints

| Method | Path | Role |
|--------|------|------|
| `GET` | `/agents` | A2A roster (`{ agents: [{ tenant, card }] }`) |
| `GET` | `/agents/{tenant}/.well-known/agent-card.json` | A2A agent card |
| `POST` | `/agents/{tenant}/message:send` | A2A blocking send |
| `POST` | `/agents/{tenant}/message:stream` | A2A SSE stream |
| `GET` | `/terminals` | Terminal roster (`{ terminals: [{ tenant, description }] }`) |
| `WS` | `/agent` | pi-extension A2A tunnel |
| `WS` | `/pty` | pty-host terminal tunnel |
| `WS` | `/agents/{tenant}/terminal` | browser terminal viewer |

Auth is a static bearer token from `RELAY_TOKEN` (shared by both roles — terminal and A2A): HTTP clients send `Authorization: Bearer <token>`; browser terminal viewers use the WS subprotocol `["bearer", <token>]`; launchers/extensions send it in their register frame. Config env: `RELAY_TOKEN`, `RELAY_URL`, `RELAY_PORT` (the older `A2A_RELAY_*` names still work as fallbacks).

## Security

> **⚠️ The web terminal is a full interactive remote shell** into the Pi process. Pi has no sandbox — its tools read/write files and run shell commands with the host user's permissions. Keep the relay on `127.0.0.1` (default) unless you understand the exposure, and treat `RELAY_TOKEN` as a shell credential. Never commit or log the token.

## Development

```bash
npm test        # vitest across all workspaces
```

See `docs/RUNBOOK.md` for the manual multi-agent runbook, and `docs/superpowers/{specs,plans}/` for design specs and implementation plans.
