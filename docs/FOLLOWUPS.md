# Follow-ups

Tracked improvements deferred during the initial build of the A2A Relay for Pi.
Severity/priority from the final whole-branch review.

## Relay

- **[b] `awaitFinal` / `openStream` request lifetime — no timeout + no fail-on-disconnect.** ✅ ADDRESSED (see below)
  Originally: if a serving agent's WebSocket dropped mid-request, `tunnel-server` only
  called `registry.unregister(tenant)` and never propagated a failure to in-flight
  `reqId`s, so the HTTP client hung forever and the `PendingRequests` resolver/sink leaked.
  Fix: per-request timeout in `PendingRequests` + `failByTenant()` invoked from the
  tunnel server on socket close/error via an `onDisconnect` dep.

- **`checkBearer` uses a non-constant-time comparison.** Fine for a static local/VPN token;
  switch to `crypto.timingSafeEqual` if the relay is ever exposed publicly.

- **`packages/relay/package.json` uses `main` instead of `exports`.** Works for a
  workspace-local ESM package; prefer an explicit `"exports"` map for forward-proofing.

## Extension

- **`agent_end` captures only the LAST assistant message's text per turn** (overwrites on
  each). Benign for single-text chat turns; loses intermediate narration in multi-message
  turns. Consider concatenating or selecting deliberately.

## Web

- **`stream()` swallows relay error frames.** The relay emits `data: {"error":...}` on a
  streaming failure, but the web client only reads `parsed.message`, so stream errors show
  nothing to the user. Surface them (throw / render an error bubble).
- **Array-index React keys** in `Chat.tsx` — fine while turns are append-only; use stable
  keys if turns can ever be removed/reordered.
- **Tenant switch mid-stream** can misroute in-flight deltas into the newly selected chat.
- **`as never` cast** in `Roster.tsx` — replace with a properly typed roster shape.

## Tooling / DX

- **`npm run typecheck` errors** — no root `tsconfig.json` with project references; only
  `tsconfig.base.json` exists and only `pi-extension` has its own tsconfig. Add a root
  `tsconfig.json` referencing every package so `tsc -b` works in CI.

## Product direction (deferred by request — "for later")

- **AG-UI + A2UI frontend.** Replace the bespoke React chat with an AG-UI event stream +
  A2UI server-driven UI, reusing the reference project at `~/gitrepos/e-agentic`
  (`e-agentic-ui`, `e-agentic-sdk`, `e-agentic-gateway`). See open-item #6 in the plan.
- Full A2A: Task/Artifact lifecycle, push notifications, real HTTP+JSON-RPC binding per
  agent (strict external interop), images / non-text Parts, tool-call streaming to the web.
- Pairing/identity (Ed25519) if the relay is exposed beyond localhost/VPN.
