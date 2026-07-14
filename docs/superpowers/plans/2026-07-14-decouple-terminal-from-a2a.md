# Decouple Terminal Discovery from A2A — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pty-host a self-sufficient terminal registrant that powers the web roster via a dedicated `GET /terminals`, and make A2A (`/agents` + messaging) fully orthogonal — no shared-name dependency between the terminal and A2A roles.

**Architecture:** The relay runs two independent roles in parallel: a Terminal role (`TerminalRegistry`, fed by pty-host `term_register` on `/pty`, served by `GET /terminals` + `/agents/{tenant}/terminal`) and an A2A role (`AgentRegistry`, fed by the pi-extension on `/agent`, served by `GET /agents` + `message:send/stream`). The web reads `/terminals`.

**Tech Stack:** TypeScript, Node 20+, `ws`, `node-pty`, `@xterm/xterm`, `typebox`, `vitest`, Vite + React, npm workspaces.

## Global Constraints

- Node `>=20`; English code/comments/commit messages; npm workspaces.
- Tunnel frames are JSON with a `type` discriminator; extend `parseTunnelFrame`/`encodeFrame`/`KNOWN` together where relevant.
- Auth: bearer token — launchers send it in `term_register`; browser viewers send subprotocol `["bearer", <token>]`; HTTP clients send `Authorization: Bearer <token>`. `GET /terminals` is bearer-gated. Never log the token or terminal bytes.
- After decoupling: `GET /agents` returns pure A2A `{ agents: [{ tenant, card }] }` (NO `terminal` field). `GET /terminals` returns `{ terminals: [{ tenant, description }] }`.
- pty-host must not statically import `node-pty` (lazy dynamic import only), and must avoid TS parameter properties (unsupported by `node --experimental-strip-types`).
- Do not break existing tests; run the full suite before each commit.

---

## File Structure

```
packages/a2a-contract/src/tunnel.ts          # MODIFY: term_register gains description?
packages/relay/src/terminal-registry.ts      # MODIFY: store description, add listTerminals()
packages/relay/src/terminal-server.ts        # MODIFY: pass description into registerLauncher
packages/relay/src/http-surface.ts           # MODIFY: GET /terminals; drop terminal flag + hasTerminal
packages/relay/src/server.ts                 # MODIFY: pass listTerminals accessor to the handler
packages/relay/src/index.ts                  # (unchanged; log already mentions endpoints)
packages/pty-host/src/config.ts              # MODIFY: resolve description (default = command name)
packages/pty-host/src/pty-host.ts            # MODIFY: send description in term_register
packages/pty-host/src/index.ts               # MODIFY: --description flag
apps/web/src/a2a-client.ts                    # MODIFY: add listTerminals()
apps/web/src/components/Roster.tsx            # MODIFY: read listTerminals()
apps/web/src/App.tsx                          # MODIFY: drop selectedHasTerminal
```

---

### Task 1: Contract — `term_register` gains `description` (`packages/a2a-contract`)

**Files:**
- Modify: `packages/a2a-contract/src/tunnel.ts`
- Test: `packages/a2a-contract/test/tunnel.test.ts`

**Interfaces:**
- Produces: `TermRegisterFrame = { type: "term_register"; token: string; name: string; description?: string }`.

- [ ] **Step 1: Add failing test** — append to `packages/a2a-contract/test/tunnel.test.ts`:

```ts
it("round-trips a term_register frame with a description", () => {
  const f = { type: "term_register", token: "t", name: "alice", description: "pi session" } as const;
  expect(parseTunnelFrame(encodeFrame(f))).toEqual(f);
});
```

- [ ] **Step 2: Run to verify** — `npx vitest run packages/a2a-contract/test/tunnel.test.ts` — the new test should PASS structurally only after the type allows `description`. First confirm current suite: it will pass at runtime (parseTunnelFrame does not strip fields), but TypeScript must accept the field. Proceed to Step 3 to make the type correct.

- [ ] **Step 3: Implement** — in `packages/a2a-contract/src/tunnel.ts` change the interface:

```ts
export interface TermRegisterFrame { type: "term_register"; token: string; name: string; description?: string; }
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run packages/a2a-contract` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/a2a-contract && git commit -m "feat(contract): term_register carries an optional description"
```

---

### Task 2: Terminal registry — store description + `listTerminals()` (`packages/relay`)

**Files:**
- Modify: `packages/relay/src/terminal-registry.ts`
- Test: `packages/relay/test/terminal-registry.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `registerLauncher(name: string, conn: LauncherConn, meta?: { description?: string }): string`
  - `listTerminals(): Array<{ tenant: string; description?: string }>`
  - All other methods unchanged (`getLauncher`, `hasTerminal`, `addViewer`, `removeViewer`, `primaryViewer`, `broadcastData`, `unregisterLauncher` returning `Viewer[]`, `tenantsWithTerminal`).

- [ ] **Step 1: Add failing test** — append to `packages/relay/test/terminal-registry.test.ts`:

```ts
it("lists terminals with their descriptions", () => {
  const r = new TerminalRegistry();
  r.registerLauncher("alice", launcher(), { description: "pi" });
  r.registerLauncher("alice", launcher());
  expect(r.listTerminals()).toEqual([
    { tenant: "alice", description: "pi" },
    { tenant: "alice#2", description: undefined },
  ]);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run packages/relay/test/terminal-registry.test.ts` — Expected: FAIL (`listTerminals` not a function / arg mismatch).

- [ ] **Step 3: Implement** — in `packages/relay/src/terminal-registry.ts`. Change the internal launcher map to hold the conn plus description, and add `listTerminals`. Replace the `launchers` field and `registerLauncher`/`getLauncher`/`hasTerminal`/`unregisterLauncher` accessors so they read `.conn`:

```ts
interface LauncherEntry { conn: LauncherConn; description?: string; }

export class TerminalRegistry {
  private launchers = new Map<string, LauncherEntry>();
  private viewers = new Map<string, Viewer[]>();

  registerLauncher(name: string, conn: LauncherConn, meta?: { description?: string }): string {
    let tenant = name;
    let n = 2;
    while (this.launchers.has(tenant)) tenant = `${name}#${n++}`;
    this.launchers.set(tenant, { conn, description: meta?.description });
    return tenant;
  }
  unregisterLauncher(tenant: string): Viewer[] {
    this.launchers.delete(tenant);
    const gone = this.viewers.get(tenant) ?? [];
    this.viewers.delete(tenant);
    return gone;
  }
  getLauncher(tenant: string): LauncherConn | undefined { return this.launchers.get(tenant)?.conn; }
  hasTerminal(tenant: string): boolean { return this.launchers.has(tenant); }
  listTerminals(): Array<{ tenant: string; description?: string }> {
    return [...this.launchers.entries()].map(([tenant, e]) => ({ tenant, description: e.description }));
  }
  // ... addViewer / removeViewer / primaryViewer / broadcastData / tenantsWithTerminal UNCHANGED ...
}
```

Keep the `LauncherConn` and `Viewer` interfaces and the viewer methods exactly as they are; only the launcher storage shape and the three accessors above change, plus the new `listTerminals`.

- [ ] **Step 4: Run to verify pass** — `npx vitest run packages/relay/test/terminal-registry.test.ts` — Expected: PASS. Then `npx vitest run packages/relay` — Expected: PASS (getLauncher/hasTerminal still work via `.conn`).

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/terminal-registry.ts packages/relay/test/terminal-registry.test.ts
git commit -m "feat(relay): terminal registry stores descriptions + listTerminals()"
```

---

### Task 3: Relay wiring — `GET /terminals`, pass description, drop `terminal` flag (`packages/relay`)

**Files:**
- Modify: `packages/relay/src/terminal-server.ts`, `packages/relay/src/http-surface.ts`, `packages/relay/src/server.ts`
- Test: `packages/relay/test/http-surface.test.ts`, `packages/relay/test/terminal-integration.test.ts`

**Interfaces:**
- Consumes: `TerminalRegistry.listTerminals()` (Task 2), `term_register.description` (Task 1).
- Produces:
  - `createHttpHandler(registry, pending, token, opts?: { requestTimeoutMs?: number; listTerminals?: () => Array<{ tenant: string; description?: string }> })`.
  - `GET /terminals` → `{ terminals: [...] }` (bearer-gated).
  - `GET /agents` → `{ agents: [{ tenant, card }] }` (NO `terminal` field).

- [ ] **Step 1: Update http-surface tests** — in `packages/relay/test/http-surface.test.ts`:
  - In `beforeEach`, replace the handler-creation line
    `createHttpHandler(registry, pending, "secret", { hasTerminal: (t) => t === "backend" })`
    with `createHttpHandler(registry, pending, "secret", { listTerminals: () => [{ tenant: "backend", description: "d" }] })`.
  - Update the "lists agents" assertion to drop the terminal field:
    `expect(body.agents).toEqual([{ tenant: "backend", card }]);`
  - Replace the "marks tenants that have a terminal" test with:

```ts
it("lists terminals on GET /terminals", async () => {
  const res = await fetch(`${base}/terminals`, { headers: { authorization: "Bearer secret" } });
  expect(res.status).toBe(200);
  expect((await res.json()).terminals).toEqual([{ tenant: "backend", description: "d" }]);
});

it("rejects GET /terminals without a bearer token", async () => {
  const res = await fetch(`${base}/terminals`);
  expect(res.status).toBe(401);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run packages/relay/test/http-surface.test.ts` — Expected: FAIL (`terminal` still present / `/terminals` 404).

- [ ] **Step 3: Implement http-surface** — in `packages/relay/src/http-surface.ts`:
  - Change the opts type:

```ts
export function createHttpHandler(
  registry: AgentRegistry,
  pending: PendingRequests,
  token: string,
  opts?: { requestTimeoutMs?: number; listTerminals?: () => Array<{ tenant: string; description?: string }> },
) {
```

  - Replace the `/agents` handler with the pure-A2A version:

```ts
    if (req.method === "GET" && path === "/agents") return send(res, 200, { agents: registry.list() });
```

  - Add a `/terminals` handler (right after `/agents`):

```ts
    if (req.method === "GET" && path === "/terminals") {
      const terminals = opts?.listTerminals?.() ?? [];
      return send(res, 200, { terminals });
    }
```

- [ ] **Step 4: Wire server.ts** — in `packages/relay/src/server.ts`, change the `createHttpHandler` call to pass `listTerminals` instead of `hasTerminal`:

```ts
  const handler = createHttpHandler(registry, pending, opts.token, {
    requestTimeoutMs,
    listTerminals: () => terminalRegistry.listTerminals(),
  });
```

(The `terminalRegistry` is already declared before this call from the prior branch. Leave the rest of `server.ts` unchanged.)

- [ ] **Step 5: Pass description in terminal-server** — in `packages/relay/src/terminal-server.ts`, in the launcher `term_register` branch, pass the description:

```ts
        tenant = registry.registerLauncher(f.name, {
          sendInput: (data) => { try { ws.send(encodeFrame({ type: "term_input", data })); } catch { /* dropped */ } },
          sendResize: (cols, rows) => { try { ws.send(encodeFrame({ type: "term_resize", cols, rows })); } catch { /* dropped */ } },
        }, { description: f.description });
```

- [ ] **Step 6: Add an integration assertion** — append to `packages/relay/test/terminal-integration.test.ts` a test that a registered terminal (with description) shows up on `GET /terminals`:

```ts
it("exposes a registered launcher on GET /terminals", async () => {
  relay = await startRelay({ port: 0, token: "t" });
  const launcher = new WebSocket(`ws://127.0.0.1:${relay.port}/pty`);
  await waitOpen(launcher);
  launcher.send(encodeFrame({ type: "term_register", token: "t", name: "alice", description: "pi" }));
  await new Promise((r) => setTimeout(r, 50));
  const res = await fetch(`http://127.0.0.1:${relay.port}/terminals`, { headers: { authorization: "Bearer t" } });
  expect((await res.json()).terminals).toEqual([{ tenant: "alice", description: "pi" }]);
});
```

(Reuse the existing `waitOpen` helper in that file.)

- [ ] **Step 7: Run to verify pass** — `npx vitest run packages/relay` — Expected: PASS (http-surface + terminal-integration + registry + existing A2A tests).

- [ ] **Step 8: Commit**

```bash
git add packages/relay && git commit -m "feat(relay): GET /terminals role; /agents back to pure A2A (no terminal flag)"
```

---

### Task 4: pty-host — send a description (`packages/pty-host`)

**Files:**
- Modify: `packages/pty-host/src/config.ts`, `packages/pty-host/src/pty-host.ts`, `packages/pty-host/src/index.ts`
- Test: `packages/pty-host/test/config.test.ts`, `packages/pty-host/test/pty-host.test.ts`

**Interfaces:**
- Produces:
  - `PtyHostConfig` gains `description: string`.
  - `resolvePtyConfig(input: { ...; flagDescription?: string })` sets `description = flagDescription || command` (the resolved command name).
  - `PtyHostOptions` gains `description?: string`; `PtyHost` sends it in `term_register`.

- [ ] **Step 1: Add failing config test** — append to `packages/pty-host/test/config.test.ts`:

```ts
it("defaults description to the command and honors the flag", () => {
  expect(resolvePtyConfig(base).description).toBe("pi");
  expect(resolvePtyConfig({ ...base, command: "bash" }).description).toBe("bash");
  expect(resolvePtyConfig({ ...base, flagDescription: "my session" }).description).toBe("my session");
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run packages/pty-host/test/config.test.ts` — Expected: FAIL.

- [ ] **Step 3: Implement config** — in `packages/pty-host/src/config.ts`:
  - Add `description: string;` to `PtyHostConfig`.
  - Add `flagDescription?: string;` to the input type.
  - Compute and return description:

```ts
  const command = input.command || "pi";
  return {
    wsUrl, token: input.envToken, name,
    command,
    args: input.args ?? [],
    cwd: input.cwd,
    description: input.flagDescription || command,
  };
```

(Remove the old `command: input.command || "pi"` inline in the return if it duplicates; use the `command` const.)

- [ ] **Step 4: Add failing pty-host test** — append to `packages/pty-host/test/pty-host.test.ts` a test that `term_register` carries the description. In the relay stub's `on("message")`, capture the register frame; then assert. Add a new `it`:

```ts
it("sends the description in term_register", async () => {
  const { port, socket } = await startStub();
  const fake = makeFakePty();
  const host = new PtyHost(
    { wsUrl: `ws://127.0.0.1:${port}`, token: "t", name: "alice", command: "pi", args: [], cwd: "/tmp", env: {}, description: "pi session" },
    { spawn: () => fake.pty },
  );
  let registerFrame: { description?: string } | null = null;
  const ws = await socket;
  ws.on("message", (raw) => { const f = parseTunnelFrame(raw.toString()); if (f.type === "term_register") registerFrame = f; });
  await host.start();
  await new Promise((r) => setTimeout(r, 30));
  expect(registerFrame?.description).toBe("pi session");
  host.close();
});
```

Note: the stub replies `term_registered` on `term_register` already; attaching a second listener before `host.start()` requires the socket promise to resolve first. If ordering is awkward, capture the frame inside `startStub` instead — adjust minimally to make the assertion reliable.

- [ ] **Step 5: Implement pty-host** — in `packages/pty-host/src/pty-host.ts`:
  - Add `description?: string;` to `PtyHostOptions`.
  - In `connect()`, include it in the register frame:

```ts
      ws.on("open", () => ws.send(encodeFrame({ type: "term_register", token: this.opts.token, name: this.opts.name, description: this.opts.description })));
```

- [ ] **Step 6: Wire index.ts** — in `packages/pty-host/src/index.ts`:
  - Parse `--description <text>` in `parseArgs` (same style as `--name`), returning `flagDescription`.
  - Pass `flagDescription` into `resolvePtyConfig` and `description: config.description` into the `PtyHost` options.

```ts
// in parseArgs: add alongside --name
    if (a === "--description") { flagDescription = argv[++i]; continue; }
// return { flagName, flagDescription, command, args };
// in resolvePtyConfig call: flagDescription: parsed.flagDescription,
// in new PtyHost({...}): description: config.description,
```

- [ ] **Step 7: Run to verify pass** — `npx vitest run packages/pty-host` — Expected: PASS (config + pty-host tests).

- [ ] **Step 8: Commit**

```bash
git add packages/pty-host && git commit -m "feat(pty-host): register a description (default = wrapped command)"
```

---

### Task 5: Web — read `/terminals` (`apps/web`)

**Files:**
- Modify: `apps/web/src/a2a-client.ts`, `apps/web/src/components/Roster.tsx`, `apps/web/src/App.tsx`
- Test: `apps/web/test/a2a-client.test.ts`

**Interfaces:**
- Produces: `A2AClient.listTerminals(): Promise<Array<{ tenant: string; description?: string }>>` (GET `/terminals`).
- `Roster` reads `listTerminals()`; `onSelect(tenant: string)` (no `hasTerminal` arg).
- `App` renders `<Terminal>` for any selected tenant.

- [ ] **Step 1: Add failing client test** — append to `apps/web/test/a2a-client.test.ts` (follow the existing fetch-mock pattern in that file). Add a test that `listTerminals()` GETs `/terminals` with the bearer header and returns the parsed `terminals` array. Mirror the existing `listAgents` test structure:

```ts
it("listTerminals GETs /terminals and returns the list", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ terminals: [{ tenant: "alice", description: "pi" }] }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const client = new A2AClient({ baseUrl: "", token: "t" });
  const list = await client.listTerminals();
  expect(list).toEqual([{ tenant: "alice", description: "pi" }]);
  expect(fetchMock).toHaveBeenCalledWith("/terminals", { headers: { authorization: "Bearer t" } });
  vi.unstubAllGlobals();
});
```

(If the existing tests use a different mock style, match it — the assertion that matters is the URL `/terminals`, the bearer header, and the parsed return.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run apps/web/test/a2a-client.test.ts` — Expected: FAIL (`listTerminals` not a function).

- [ ] **Step 3: Implement client** — in `apps/web/src/a2a-client.ts` add:

```ts
  async listTerminals(): Promise<Array<{ tenant: string; description?: string }>> {
    const res = await fetch(`${this.opts.baseUrl}/terminals`, { headers: this.auth() });
    if (!res.ok) throw new Error(`listTerminals HTTP ${res.status}`);
    return (await res.json() as { terminals: Array<{ tenant: string; description?: string }> }).terminals;
  }
```

Also change `listAgents` return type back to pure A2A (drop the `terminal?: boolean` added earlier):

```ts
  async listAgents(): Promise<Array<{ tenant: string; card: AgentCard }>> {
    const res = await fetch(`${this.opts.baseUrl}/agents`, { headers: this.auth() });
    if (!res.ok) throw new Error(`listAgents HTTP ${res.status}`);
    return (await res.json() as { agents: Array<{ tenant: string; card: AgentCard }> }).agents;
  }
```

- [ ] **Step 4: Update Roster** — in `apps/web/src/components/Roster.tsx`:
  - Change the props type: `onSelect: (t: string) => void`.
  - Change state to terminals: `useState<Array<{ tenant: string; description?: string }>>([])`.
  - In the poll, call `client.listTerminals()` instead of `client.listAgents()`.
  - Render each entry’s `tenant` and `description` (fallback empty), and `onClick={() => onSelect(a.tenant)}`. Keep the same styling; replace the `<small>{a.card.description}</small>` with `<small>{a.description ?? ""}</small>`.

```tsx
export function Roster({ client, selected, onSelect }: { client: A2AClient; selected: string | null; onSelect: (t: string) => void }) {
  const [terminals, setTerminals] = useState<Array<{ tenant: string; description?: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const a = await client.listTerminals(); if (live) { setTerminals(a); setError(null); } }
      catch (e) { if (live) setError((e as Error).message); }
    };
    tick(); const id = setInterval(tick, 3000);
    return () => { live = false; clearInterval(id); };
  }, [client]);
  return (
    <aside style={{ width: 240, borderRight: "1px solid var(--border, #333)", padding: 8, overflowY: "auto" }}>
      <h3>Terminals</h3>
      {error && <div style={{ color: "var(--red, tomato)" }}>{error}</div>}
      {terminals.map((a) => (
        <button key={a.tenant} onClick={() => onSelect(a.tenant)}
          style={{ display: "block", width: "100%", textAlign: "left", padding: 6, marginBottom: 4,
            background: a.tenant === selected ? "var(--layer2, #2a2a2a)" : "transparent", color: "inherit", border: "none", cursor: "pointer" }}>
          <strong>{a.tenant}</strong><br /><small>{a.description ?? ""}</small>
        </button>
      ))}
    </aside>
  );
}
```

- [ ] **Step 5: Simplify App** — in `apps/web/src/App.tsx`, drop `selectedHasTerminal`; render Terminal for any selected tenant:

```tsx
        <Roster client={client} selected={selected} onSelect={(t) => setSelected(t)} />
        {selected ? (
          <Terminal key={`term-${selected}`} baseUrl={baseUrl} token={token} tenant={selected} />
        ) : (
          <section style={{ flex: 1, display: "grid", placeItems: "center", opacity: 0.6 }}>Select a terminal</section>
        )}
```

Remove the now-unused `selectedHasTerminal` state line.

- [ ] **Step 6: Run to verify pass + build** — `npx vitest run apps/web` (Expected: PASS) then `npm run build --workspace @pi-comm/web` (Expected: build succeeds).

- [ ] **Step 7: Commit**

```bash
git add apps/web && git commit -m "feat(web): roster reads GET /terminals; terminal-only UI decoupled from A2A"
```

---

## Final verification

- [ ] Full suite: `npm test` → all green.
- [ ] Web build: `npm run build --workspace @pi-comm/web` → succeeds.
- [ ] Manual smoke (optional): relay + a pty-host wrapping `bash` (no A2A extension) with `--description "scratch"`; confirm `GET /terminals` lists it and the web roster shows it and opens the terminal — proving terminal discovery no longer depends on A2A.
