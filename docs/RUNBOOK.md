# Manual two-Pi-agent runbook

Quick guide for running two Pi sessions that communicate through the local relay.

## Prerequisites

- Node ≥ 20
- `pi` CLI installed (`@earendil-works/pi-coding-agent`)
- Repo checked out at `~/gitrepos/pi-comm` on branch `feat/a2a-relay`
- Install deps: `npm install` in the repo root

---

## Step 1 — Start the relay

```bash
cd ~/gitrepos/pi-comm
A2A_RELAY_TOKEN=dev node --experimental-strip-types packages/relay/src/index.ts
```

Expected output:
```
pi-comm relay listening on http://127.0.0.1:8787 (agents: ws://.../agent)
```

---

## Step 2 — Launch Alice

Open a new terminal. Create (or reuse) a working directory and start Pi with the extension:

```bash
mkdir -p ~/tmp/agent-a && cd ~/tmp/agent-a
A2A_RELAY_TOKEN=dev \
A2A_RELAY_URL=http://127.0.0.1:8787 \
pi -e ~/gitrepos/pi-comm/packages/pi-extension/src/index.ts \
   --a2a-name alice
```

Expected: the status bar shows **`📡 a2a:alice`**.

---

## Step 3 — Launch Bob

Open a third terminal:

```bash
mkdir -p ~/tmp/agent-b && cd ~/tmp/agent-b
A2A_RELAY_TOKEN=dev \
A2A_RELAY_URL=http://127.0.0.1:8787 \
pi -e ~/gitrepos/pi-comm/packages/pi-extension/src/index.ts \
   --a2a-name bob
```

Expected: the status bar shows **`📡 a2a:bob`**.

---

## Step 4 — Alice lists peers and messages Bob

In Alice's terminal, send this prompt:

```
Use a2a_list to see peers, then a2a_send to ask bob: "reply with the word PONG"
```

Expected outcomes:
- `a2a_list` returns a roster that includes `bob`.
- `a2a_send` returns a reply containing **PONG**.
- Bob's terminal shows an injected turn labelled `[a2a message from relay]`.

---

## Step 5 — Verify roster via HTTP

From any terminal (relay still running):

```bash
curl -s -H "authorization: Bearer dev" http://127.0.0.1:8787/agents | jq '.agents[].tenant'
```

Expected output (order may vary):

```
"alice"
"bob"
```

---

## Cleanup

Stop Alice and Bob with `Ctrl-C` in their respective terminals, then stop the relay the same way.

---

## How it works (brief)

| Component | Role |
|-----------|------|
| `packages/relay` | Lightweight HTTP + WebSocket relay. Maintains an agent registry. Exposes `POST /agents/{tenant}/message:send` for blocking calls and `GET /agents` for the roster. |
| `packages/pi-extension` | Pi extension that registers a `RelayClient` (WebSocket tunnel) when `A2A_RELAY_TOKEN` is set. Exposes `a2a_list` and `a2a_send` tools to the LLM. |
| `packages/a2a-contract` | Shared TypeScript types and frame codec used by both sides. |

Deduplication: if two agents register with the same `--a2a-name`, the second gets `name#2`, etc.

Token auth: every HTTP request and WebSocket registration must carry the `A2A_RELAY_TOKEN` as a Bearer token.

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
