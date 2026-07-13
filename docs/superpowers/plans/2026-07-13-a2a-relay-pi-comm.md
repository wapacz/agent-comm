# A2A Relay for Pi — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a relay that fronts multiple Pi agent sessions as A2A servers, so any A2A client (a web app, another Pi agent, or an external tool) can list connected sessions and send/stream messages to a chosen one — with the relay runnable locally (127.0.0.1) or remotely.

**Architecture:** Pi agents dial *outbound* over WebSocket to the relay and register an A2A `AgentCard` (no inbound ports, NAT-friendly). The relay exposes a standards-shaped A2A HTTP surface (agent-card, roster, `message:send`, `message:stream` via SSE) and routes each request to the right agent's WS tunnel using a path-based `tenant` (the agent's session name). A web app and Pi-to-Pi calls are both just A2A clients of that surface.

**Tech Stack:** TypeScript, Node 20+, `ws` (relay WS server + extension WS client), `typebox` (schema validation), `vitest` (tests), npm workspaces monorepo. Web app: Vite + React. Pi extension uses `@earendil-works/pi-coding-agent` types and is loaded by Pi via jiti (TS runs uncompiled).

## Global Constraints

- Node version floor: **`>=20`** (exact `engines.node: ">=20"` in every `package.json`).
- Language: all code, comments, commit messages, and identifiers in **English**.
- Package manager: **npm workspaces** (no pnpm/yarn). Root `package.json` has `"workspaces": ["packages/*", "apps/*"]`.
- A2A profile is **minimal / message-only**: implement only `AgentCard`, `Message`, `Part`, `Role`, `message:send`, `message:stream`. Do **not** implement Task lifecycle, Artifacts, push notifications, gRPC, or OAuth in this plan.
- A2A JSON field naming is **camelCase** (`contextId`, `messageId`, `defaultInputModes`). Role enum values are the ProtoJSON strings **`"ROLE_USER"` / `"ROLE_AGENT"`**.
- Tenant addressing is **path-based**: `/agents/{tenant}/...`. `tenant` equals the agent's registered session name (unique per relay, deduped with a `#N` suffix).
- Client auth is a **static bearer token** the relay reads from env `A2A_RELAY_TOKEN`; clients send `Authorization: Bearer <token>`; agents send the same token in the WS `register` frame. No OAuth.
- Streaming binding relaxation (documented, intentional): `message:stream` emits a sequence of `StreamResponse` frames each carrying a partial `{ message }`, terminated by a frame with `metadata.final === true` then SSE `[DONE]`. Strict external clients that need one-shot use `message:send`.
- No secrets in code or logs. Never log the bearer token or full message bodies at info level.

---

## File Structure

```
pi-comm/
  package.json                      # workspaces root
  tsconfig.base.json                # shared TS config
  vitest.config.ts                  # shared test config
  packages/
    a2a-contract/                   # shared: A2A types + tunnel protocol + validators
      package.json
      src/a2a.ts                    # AgentCard, Message, Part, Role, StreamResponse (typebox schemas + types)
      src/tunnel.ts                 # agent<->relay WS frame schemas + types
      src/index.ts                  # re-exports
      test/a2a.test.ts
      test/tunnel.test.ts
    relay/                          # the relay server
      package.json
      src/registry.ts               # in-memory agent registry (tenant -> connection)
      src/tunnel-server.ts          # WS server for agents (register, heartbeat, request/response bridge)
      src/http-surface.ts           # HTTP A2A surface (roster, agent-card, message:send, message:stream)
      src/auth.ts                   # bearer token check
      src/server.ts                 # wires tunnel + http on one port
      src/index.ts                  # CLI entrypoint (reads env, starts server)
      test/registry.test.ts
      test/http-surface.test.ts
      test/integration.test.ts      # agent WS + client HTTP end-to-end (in-process)
    pi-extension/                   # the Pi extension
      package.json
      src/config.ts                 # resolve relay url/token/name/card from flags+frontmatter+env
      src/relay-client.ts           # WS client: connect, register, serve requests, heartbeat, reconnect
      src/inbound.ts                # turn an inbound A2A request into a Pi turn + capture the reply
      src/tools.ts                  # a2a_list / a2a_send tools (Pi-as-A2A-client)
      src/index.ts                  # default export: wires everything into ExtensionAPI
      test/config.test.ts
      test/inbound.test.ts
  apps/
    web/                            # web app (A2A client)
      package.json
      index.html
      vite.config.ts
      src/main.tsx
      src/a2a-client.ts             # fetch-based A2A client (roster, send, stream)
      src/App.tsx                   # roster + chat + tool-call panel
      src/components/Roster.tsx
      src/components/Chat.tsx
      src/components/ToolCallPanel.tsx
      test/a2a-client.test.ts
```

---

### Task 0: Monorepo scaffold

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.config.ts`, `.gitignore`

**Interfaces:**
- Produces: npm workspaces root resolving `packages/*` and `apps/*`; `npm test` runs vitest across workspaces.

- [ ] **Step 1: Create root `package.json`**

```json
{
  "name": "pi-comm",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "workspaces": ["packages/*", "apps/*"],
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b --pretty"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "@types/node": "^20.16.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "verbatimModuleSyntax": true,
    "lib": ["ES2022", "DOM"]
  }
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts"], environment: "node" },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
*.log
.env
```

- [ ] **Step 5: Install and verify**

Run: `cd /home/qmiclap/gitrepos/pi-comm && npm install`
Expected: installs without error, creates `package-lock.json`.

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "chore: scaffold npm workspaces monorepo"
```

---

### Task 1: A2A contract — data model (`packages/a2a-contract`)

**Files:**
- Create: `packages/a2a-contract/package.json`, `packages/a2a-contract/src/a2a.ts`, `packages/a2a-contract/src/index.ts`
- Test: `packages/a2a-contract/test/a2a.test.ts`

**Interfaces:**
- Produces:
  - Type `Role = "ROLE_USER" | "ROLE_AGENT"`.
  - Type `Part = { text: string } | { data: unknown } | { url: string; mediaType?: string; filename?: string }` (exactly one of text/data/url), all with optional `metadata`.
  - Type `Message = { messageId: string; role: Role; parts: Part[]; contextId?: string; taskId?: string; metadata?: Record<string, unknown> }`.
  - Type `AgentCard = { name: string; description: string; version: string; capabilities: { streaming: boolean }; defaultInputModes: string[]; defaultOutputModes: string[]; skills: AgentSkill[]; provider?: { organization: string; url: string } }`.
  - Type `AgentSkill = { id: string; name: string; description: string; tags: string[] }`.
  - Type `StreamResponse = { message?: Message; metadata?: Record<string, unknown> }` (message-only profile).
  - Value `MessageSchema`, `AgentCardSchema` (typebox `TSchema`) plus `validateMessage(x): Message` and `validateAgentCard(x): AgentCard` that throw `Error` with a readable message on invalid input.
  - Helper `textMessage(role: Role, text: string, opts?: { messageId?: string; contextId?: string }): Message`.

- [ ] **Step 1: Create `packages/a2a-contract/package.json`**

```json
{
  "name": "@pi-comm/a2a-contract",
  "version": "0.0.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "main": "src/index.ts",
  "dependencies": { "typebox": "^0.34.0" }
}
```

- [ ] **Step 2: Write the failing test `test/a2a.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { validateMessage, validateAgentCard, textMessage } from "../src/index.ts";

describe("a2a contract", () => {
  it("accepts a valid text message", () => {
    const m = textMessage("ROLE_USER", "hello", { messageId: "m1" });
    expect(validateMessage(m)).toEqual(m);
    expect(m.parts[0]).toEqual({ text: "hello" });
  });

  it("rejects a message with no parts", () => {
    expect(() => validateMessage({ messageId: "m1", role: "ROLE_USER", parts: [] }))
      .toThrow();
  });

  it("rejects a part with both text and url", () => {
    expect(() => validateMessage({ messageId: "m1", role: "ROLE_USER", parts: [{ text: "x", url: "y" }] }))
      .toThrow();
  });

  it("accepts a minimal agent card", () => {
    const card = {
      name: "backend", description: "backend agent", version: "1.0.0",
      capabilities: { streaming: true },
      defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
      skills: [{ id: "chat", name: "Chat", description: "general chat", tags: ["chat"] }],
    };
    expect(validateAgentCard(card)).toEqual(card);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/a2a-contract`
Expected: FAIL — cannot resolve `../src/index.ts`.

- [ ] **Step 4: Implement `src/a2a.ts`**

```ts
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const RoleSchema = Type.Union([Type.Literal("ROLE_USER"), Type.Literal("ROLE_AGENT")]);
export type Role = Static<typeof RoleSchema>;

// A Part MUST contain exactly one of: text | data | url. We model as a union.
const TextPart = Type.Object({ text: Type.String(), metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())) });
const DataPart = Type.Object({ data: Type.Unknown(), metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())) });
const UrlPart = Type.Object({
  url: Type.String(),
  mediaType: Type.Optional(Type.String()),
  filename: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export const PartSchema = Type.Union([TextPart, DataPart, UrlPart]);
export type Part = Static<typeof PartSchema>;

export const MessageSchema = Type.Object({
  messageId: Type.String(),
  role: RoleSchema,
  parts: Type.Array(PartSchema, { minItems: 1 }),
  contextId: Type.Optional(Type.String()),
  taskId: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type Message = Static<typeof MessageSchema>;

export const AgentSkillSchema = Type.Object({
  id: Type.String(), name: Type.String(), description: Type.String(), tags: Type.Array(Type.String()),
});
export type AgentSkill = Static<typeof AgentSkillSchema>;

export const AgentCardSchema = Type.Object({
  name: Type.String(),
  description: Type.String(),
  version: Type.String(),
  capabilities: Type.Object({ streaming: Type.Boolean() }),
  defaultInputModes: Type.Array(Type.String()),
  defaultOutputModes: Type.Array(Type.String()),
  skills: Type.Array(AgentSkillSchema),
  provider: Type.Optional(Type.Object({ organization: Type.String(), url: Type.String() })),
});
export type AgentCard = Static<typeof AgentCardSchema>;

export interface StreamResponse { message?: Message; metadata?: Record<string, unknown>; }

function assertExactlyOnePartKind(parts: unknown): void {
  if (!Array.isArray(parts)) return;
  for (const p of parts) {
    if (p && typeof p === "object") {
      const kinds = ["text", "data", "url"].filter((k) => k in (p as Record<string, unknown>));
      if (kinds.length !== 1) throw new Error(`A2A Part must contain exactly one of text|data|url, got: [${kinds.join(",")}]`);
    }
  }
}

export function validateMessage(x: unknown): Message {
  assertExactlyOnePartKind((x as { parts?: unknown })?.parts);
  if (!Value.Check(MessageSchema, x)) {
    const first = [...Value.Errors(MessageSchema, x)][0];
    throw new Error(`Invalid A2A Message: ${first ? `${first.path} ${first.message}` : "schema mismatch"}`);
  }
  return x as Message;
}

export function validateAgentCard(x: unknown): AgentCard {
  if (!Value.Check(AgentCardSchema, x)) {
    const first = [...Value.Errors(AgentCardSchema, x)][0];
    throw new Error(`Invalid A2A AgentCard: ${first ? `${first.path} ${first.message}` : "schema mismatch"}`);
  }
  return x as AgentCard;
}

export function textMessage(role: Role, text: string, opts?: { messageId?: string; contextId?: string }): Message {
  return {
    messageId: opts?.messageId ?? crypto.randomUUID(),
    role,
    parts: [{ text }],
    ...(opts?.contextId ? { contextId: opts.contextId } : {}),
  };
}
```

- [ ] **Step 5: Implement `src/index.ts`**

```ts
export * from "./a2a.ts";
export * from "./tunnel.ts";
```

Note: `tunnel.ts` is created in Task 2. Until then, temporarily comment out the `./tunnel.ts` re-export line, or do Task 2 before running the full suite. Prefer: create an empty `export {};` in `src/tunnel.ts` now to keep imports resolvable.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run packages/a2a-contract`
Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(contract): A2A minimal data model with validation"
```

---

### Task 2: Agent↔relay tunnel protocol (`packages/a2a-contract/src/tunnel.ts`)

**Files:**
- Modify: `packages/a2a-contract/src/tunnel.ts`
- Test: `packages/a2a-contract/test/tunnel.test.ts`

**Interfaces:**
- Produces (frames are JSON objects with a `type` discriminator):
  - Agent→Relay: `RegisterFrame = { type: "register"; token: string; name: string; card: AgentCard }`
  - Relay→Agent: `RegisteredFrame = { type: "registered"; tenant: string }`
  - Relay→Agent: `RequestFrame = { type: "request"; reqId: string; stream: boolean; message: Message }`
  - Agent→Relay: `ChunkFrame = { type: "chunk"; reqId: string; message: Message; final: boolean }`
  - Agent→Relay: `ErrorFrame = { type: "error"; reqId: string; error: string }`
  - Both: `PingFrame = { type: "ping" }`, `PongFrame = { type: "pong" }`
  - Union `TunnelFrame` of all the above.
  - `parseTunnelFrame(raw: string): TunnelFrame` (throws on unknown/invalid) and `encodeFrame(f: TunnelFrame): string`.

- [ ] **Step 1: Write the failing test `test/tunnel.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parseTunnelFrame, encodeFrame } from "../src/tunnel.ts";

describe("tunnel protocol", () => {
  it("round-trips a request frame", () => {
    const f = { type: "request", reqId: "r1", stream: true,
      message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "hi" }] } } as const;
    expect(parseTunnelFrame(encodeFrame(f))).toEqual(f);
  });

  it("rejects an unknown frame type", () => {
    expect(() => parseTunnelFrame(JSON.stringify({ type: "nope" }))).toThrow();
  });

  it("rejects malformed JSON", () => {
    expect(() => parseTunnelFrame("{not json")).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/a2a-contract/test/tunnel.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Implement `src/tunnel.ts`**

```ts
import type { AgentCard, Message } from "./a2a.ts";

export interface RegisterFrame { type: "register"; token: string; name: string; card: AgentCard; }
export interface RegisteredFrame { type: "registered"; tenant: string; }
export interface RequestFrame { type: "request"; reqId: string; stream: boolean; message: Message; }
export interface ChunkFrame { type: "chunk"; reqId: string; message: Message; final: boolean; }
export interface ErrorFrame { type: "error"; reqId: string; error: string; }
export interface PingFrame { type: "ping"; }
export interface PongFrame { type: "pong"; }

export type TunnelFrame =
  | RegisterFrame | RegisteredFrame | RequestFrame | ChunkFrame | ErrorFrame | PingFrame | PongFrame;

const KNOWN = new Set(["register", "registered", "request", "chunk", "error", "ping", "pong"]);

export function parseTunnelFrame(raw: string): TunnelFrame {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { throw new Error("tunnel: invalid JSON frame"); }
  if (!obj || typeof obj !== "object" || !("type" in obj)) throw new Error("tunnel: frame missing type");
  const type = (obj as { type: unknown }).type;
  if (typeof type !== "string" || !KNOWN.has(type)) throw new Error(`tunnel: unknown frame type ${String(type)}`);
  return obj as TunnelFrame;
}

export function encodeFrame(f: TunnelFrame): string { return JSON.stringify(f); }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/a2a-contract`
Expected: PASS (all contract + tunnel tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(contract): agent<->relay tunnel frame protocol"
```

---

### Task 3: Relay — registry + WS tunnel server (`packages/relay`)

**Files:**
- Create: `packages/relay/package.json`, `packages/relay/src/registry.ts`, `packages/relay/src/tunnel-server.ts`
- Test: `packages/relay/test/registry.test.ts`

**Interfaces:**
- Produces:
  - `class AgentRegistry`:
    - `register(name: string, card: AgentCard, conn: AgentConn): string` — returns the assigned unique tenant (dedup: `name`, then `name#2`, `name#3`, …).
    - `unregister(tenant: string): void`
    - `get(tenant: string): AgentConn | undefined`
    - `list(): Array<{ tenant: string; card: AgentCard }>`
  - `interface AgentConn { card: AgentCard; send(frame: TunnelFrame): void; }`
  - `function startTunnelServer(wss: WebSocketServer, registry: AgentRegistry, token: string, deps: { onChunk: (tenant: string, f: ChunkFrame | ErrorFrame) => void }): void` — handles `register` (auth-checks token, assigns tenant, replies `registered`), routes `chunk`/`error` frames to `deps.onChunk`, answers `ping` with `pong`, and unregisters on socket close.

- [ ] **Step 1: Create `packages/relay/package.json`**

```json
{
  "name": "@pi-comm/relay",
  "version": "0.0.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "bin": { "pi-comm-relay": "src/index.ts" },
  "scripts": { "start": "node --experimental-strip-types src/index.ts" },
  "dependencies": { "@pi-comm/a2a-contract": "*", "ws": "^8.18.0" },
  "devDependencies": { "@types/ws": "^8.5.12" }
}
```

- [ ] **Step 2: Write the failing test `test/registry.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { AgentRegistry } from "../src/registry.ts";

const card = {
  name: "backend", description: "d", version: "1.0.0",
  capabilities: { streaming: true }, defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"], skills: [{ id: "c", name: "C", description: "d", tags: [] }],
};
const conn = () => ({ card, send: () => {} });

describe("AgentRegistry", () => {
  it("assigns the plain name for the first registration", () => {
    const r = new AgentRegistry();
    expect(r.register("backend", card, conn())).toBe("backend");
  });
  it("dedups colliding names with #N suffix", () => {
    const r = new AgentRegistry();
    r.register("backend", card, conn());
    expect(r.register("backend", card, conn())).toBe("backend#2");
    expect(r.register("backend", card, conn())).toBe("backend#3");
  });
  it("frees the tenant on unregister", () => {
    const r = new AgentRegistry();
    const t = r.register("backend", card, conn());
    r.unregister(t);
    expect(r.get(t)).toBeUndefined();
    expect(r.list()).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/relay/test/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/registry.ts`**

```ts
import type { AgentCard } from "@pi-comm/a2a-contract";
import type { TunnelFrame } from "@pi-comm/a2a-contract";

export interface AgentConn { card: AgentCard; send(frame: TunnelFrame): void; }

export class AgentRegistry {
  private byTenant = new Map<string, AgentConn>();

  register(name: string, card: AgentCard, conn: AgentConn): string {
    let tenant = name;
    let n = 2;
    while (this.byTenant.has(tenant)) tenant = `${name}#${n++}`;
    this.byTenant.set(tenant, { ...conn, card });
    return tenant;
  }
  unregister(tenant: string): void { this.byTenant.delete(tenant); }
  get(tenant: string): AgentConn | undefined { return this.byTenant.get(tenant); }
  list(): Array<{ tenant: string; card: AgentCard }> {
    return [...this.byTenant.entries()].map(([tenant, c]) => ({ tenant, card: c.card }));
  }
}
```

- [ ] **Step 5: Implement `src/tunnel-server.ts`**

```ts
import type { WebSocketServer, WebSocket } from "ws";
import {
  parseTunnelFrame, encodeFrame, validateAgentCard,
  type ChunkFrame, type ErrorFrame,
} from "@pi-comm/a2a-contract";
import type { AgentRegistry } from "./registry.ts";

export function startTunnelServer(
  wss: WebSocketServer,
  registry: AgentRegistry,
  token: string,
  deps: { onChunk: (tenant: string, f: ChunkFrame | ErrorFrame) => void },
): void {
  wss.on("connection", (ws: WebSocket) => {
    let tenant: string | null = null;
    ws.on("message", (raw) => {
      let frame;
      try { frame = parseTunnelFrame(raw.toString()); }
      catch { ws.close(1002, "bad frame"); return; }

      if (frame.type === "ping") { ws.send(encodeFrame({ type: "pong" })); return; }

      if (frame.type === "register") {
        if (frame.token !== token) { ws.close(1008, "unauthorized"); return; }
        let card;
        try { card = validateAgentCard(frame.card); } catch { ws.close(1002, "bad card"); return; }
        tenant = registry.register(frame.name, card, {
          card,
          send: (f) => { try { ws.send(encodeFrame(f)); } catch { /* dropped */ } },
        });
        ws.send(encodeFrame({ type: "registered", tenant }));
        return;
      }

      if (frame.type === "chunk" || frame.type === "error") {
        if (tenant) deps.onChunk(tenant, frame);
        return;
      }
    });
    ws.on("close", () => { if (tenant) registry.unregister(tenant); });
    ws.on("error", () => { if (tenant) registry.unregister(tenant); });
  });
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run packages/relay/test/registry.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(relay): agent registry + WS tunnel server"
```

---

### Task 4: Relay — HTTP A2A surface + auth + request routing (`packages/relay`)

**Files:**
- Create: `packages/relay/src/auth.ts`, `packages/relay/src/http-surface.ts`
- Test: `packages/relay/test/http-surface.test.ts`

**Interfaces:**
- Consumes: `AgentRegistry` (Task 3), tunnel frames (Task 2).
- Produces:
  - `function checkBearer(header: string | undefined, token: string): boolean`
  - `class PendingRequests`: `create(): { reqId: string; promise: Promise<Message>; push(msg: Message, final: boolean): void; fail(err: string): void }` and `stream(reqId)` async iterator of `{ message: Message; final: boolean }`; used for both blocking and streaming. Minimal shape:
    - `open(reqId: string): void`
    - `push(reqId: string, msg: Message, final: boolean): void`
    - `fail(reqId: string, err: string): void`
    - `awaitFinal(reqId: string): Promise<Message>` (resolves on final chunk; rejects on error)
    - `iterate(reqId: string): AsyncGenerator<{ message: Message; final: boolean }>`
  - `function createHttpHandler(registry: AgentRegistry, pending: PendingRequests, token: string): (req: IncomingMessage, res: ServerResponse) => void` implementing:
    - `GET /agents` → `{ agents: [{ tenant, card }] }`
    - `GET /agents/{tenant}/.well-known/agent-card.json` → the card (404 if unknown tenant)
    - `POST /agents/{tenant}/message:send` → body `{ message }`; forwards `RequestFrame{stream:false}` to the agent, waits for final chunk, returns `{ message }` (A2A message-only response). 404 unknown tenant, 401 bad token, 400 invalid message.
    - `POST /agents/{tenant}/message:stream` → SSE; forwards `RequestFrame{stream:true}`, writes each chunk as `data: {"message":...}` and closes with `data: [DONE]`.

- [ ] **Step 1: Write the failing test `test/http-surface.test.ts`**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { AgentRegistry } from "../src/registry.ts";
import { PendingRequests, createHttpHandler, checkBearer } from "../src/http-surface.ts";
import { createServer, type Server } from "node:http";
import type { TunnelFrame } from "@pi-comm/a2a-contract";

const card = {
  name: "backend", description: "d", version: "1.0.0",
  capabilities: { streaming: true }, defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"], skills: [{ id: "c", name: "C", description: "d", tags: [] }],
};

let server: Server; let base: string; let registry: AgentRegistry; let pending: PendingRequests;
let lastFrame: TunnelFrame | null = null;

beforeEach(async () => {
  registry = new AgentRegistry();
  pending = new PendingRequests();
  // Fake agent: whatever request arrives, immediately answer via pending.
  registry.register("backend", card, {
    card,
    send: (f) => {
      lastFrame = f;
      if (f.type === "request") {
        pending.push(f.reqId, { messageId: "a1", role: "ROLE_AGENT", parts: [{ text: "pong" }] }, true);
      }
    },
  });
  const handler = createHttpHandler(registry, pending, "secret");
  server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

describe("checkBearer", () => {
  it("passes only for the exact token", () => {
    expect(checkBearer("Bearer secret", "secret")).toBe(true);
    expect(checkBearer("Bearer nope", "secret")).toBe(false);
    expect(checkBearer(undefined, "secret")).toBe(false);
  });
});

describe("http surface", () => {
  it("lists agents", async () => {
    const res = await fetch(`${base}/agents`, { headers: { authorization: "Bearer secret" } });
    const body = await res.json();
    expect(body.agents).toEqual([{ tenant: "backend", card }]);
  });

  it("serves an agent card", async () => {
    const res = await fetch(`${base}/agents/backend/.well-known/agent-card.json`, { headers: { authorization: "Bearer secret" } });
    expect(await res.json()).toEqual(card);
  });

  it("rejects without a bearer token", async () => {
    const res = await fetch(`${base}/agents`);
    expect(res.status).toBe(401);
  });

  it("routes message:send to the agent and returns its reply", async () => {
    const res = await fetch(`${base}/agents/backend/message:send`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "ping" }] } }),
    });
    const body = await res.json();
    expect(body.message.parts[0]).toEqual({ text: "pong" });
    expect(lastFrame?.type).toBe("request");
  });

  it("404s for an unknown tenant", async () => {
    const res = await fetch(`${base}/agents/ghost/message:send`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({ message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "ping" }] } }),
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/relay/test/http-surface.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/auth.ts`**

```ts
export function checkBearer(header: string | undefined, token: string): boolean {
  if (!header) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return !!m && m[1] === token;
}
```

- [ ] **Step 4: Implement `src/http-surface.ts`**

```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { validateMessage, type Message } from "@pi-comm/a2a-contract";
import type { AgentRegistry } from "./registry.ts";
import { checkBearer } from "./auth.ts";

export { checkBearer } from "./auth.ts";

interface Waiter {
  push: (msg: Message, final: boolean) => void;
  fail: (err: string) => void;
}

export class PendingRequests {
  private finalResolvers = new Map<string, { resolve: (m: Message) => void; reject: (e: Error) => void }>();
  private streamSinks = new Map<string, (v: { message: Message; final: boolean } | { error: string }) => void>();

  open(reqId: string): void { /* reserved for symmetry; state created lazily */ }

  push(reqId: string, msg: Message, final: boolean): void {
    const sink = this.streamSinks.get(reqId);
    if (sink) sink({ message: msg, final });
    if (final) {
      this.finalResolvers.get(reqId)?.resolve(msg);
      this.finalResolvers.delete(reqId);
    }
  }
  fail(reqId: string, err: string): void {
    this.streamSinks.get(reqId)?.({ error: err });
    this.finalResolvers.get(reqId)?.reject(new Error(err));
    this.finalResolvers.delete(reqId);
  }
  awaitFinal(reqId: string): Promise<Message> {
    return new Promise((resolve, reject) => this.finalResolvers.set(reqId, { resolve, reject }));
  }
  async *iterate(reqId: string): AsyncGenerator<{ message: Message; final: boolean }> {
    const queue: Array<{ message: Message; final: boolean } | { error: string }> = [];
    let notify: (() => void) | null = null;
    this.streamSinks.set(reqId, (v) => { queue.push(v); notify?.(); });
    try {
      while (true) {
        if (queue.length === 0) await new Promise<void>((r) => (notify = r));
        while (queue.length) {
          const v = queue.shift()!;
          if ("error" in v) throw new Error(v.error);
          yield v;
          if (v.final) return;
        }
      }
    } finally { this.streamSinks.delete(reqId); }
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

export function createHttpHandler(registry: AgentRegistry, pending: PendingRequests, token: string) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    // CORS for the web app.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "authorization,content-type");
    res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    if (!checkBearer(req.headers.authorization, token)) return send(res, 401, { error: "unauthorized" });

    if (req.method === "GET" && path === "/agents") return send(res, 200, { agents: registry.list() });

    const cardMatch = /^\/agents\/([^/]+)\/\.well-known\/agent-card\.json$/.exec(path);
    if (req.method === "GET" && cardMatch) {
      const conn = registry.get(decodeURIComponent(cardMatch[1]));
      if (!conn) return send(res, 404, { error: "unknown tenant" });
      return send(res, 200, conn.card);
    }

    const sendMatch = /^\/agents\/([^/]+)\/message:send$/.exec(path);
    if (req.method === "POST" && sendMatch) {
      const conn = registry.get(decodeURIComponent(sendMatch[1]));
      if (!conn) return send(res, 404, { error: "unknown tenant" });
      let message: Message;
      try { message = validateMessage((await readJson(req) as { message: unknown }).message); }
      catch (e) { return send(res, 400, { error: (e as Error).message }); }
      const reqId = randomUUID();
      const final = pending.awaitFinal(reqId);
      conn.send({ type: "request", reqId, stream: false, message });
      try { return send(res, 200, { message: await final }); }
      catch (e) { return send(res, 502, { error: (e as Error).message }); }
    }

    const streamMatch = /^\/agents\/([^/]+)\/message:stream$/.exec(path);
    if (req.method === "POST" && streamMatch) {
      const conn = registry.get(decodeURIComponent(streamMatch[1]));
      if (!conn) return send(res, 404, { error: "unknown tenant" });
      let message: Message;
      try { message = validateMessage((await readJson(req) as { message: unknown }).message); }
      catch (e) { return send(res, 400, { error: (e as Error).message }); }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const reqId = randomUUID();
      conn.send({ type: "request", reqId, stream: true, message });
      try {
        for await (const { message: m } of pending.iterate(reqId)) {
          res.write(`data: ${JSON.stringify({ message: m })}\n\n`);
        }
      } catch (e) {
        res.write(`data: ${JSON.stringify({ error: (e as Error).message })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    return send(res, 404, { error: "not found" });
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/relay/test/http-surface.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(relay): HTTP A2A surface (roster, card, send, stream) + bearer auth"
```

---

### Task 5: Relay — server entrypoint + end-to-end integration (`packages/relay`)

**Files:**
- Create: `packages/relay/src/server.ts`, `packages/relay/src/index.ts`
- Test: `packages/relay/test/integration.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 4.
- Produces:
  - `function startRelay(opts: { port: number; token: string }): Promise<{ port: number; close: () => Promise<void> }>` — one HTTP server that upgrades `/agent` to the WS tunnel and serves the A2A surface on all other paths. Wires `PendingRequests` so `chunk`/`error` frames from agents resolve HTTP requests.
  - `src/index.ts` reads `A2A_RELAY_PORT` (default `8787`) and `A2A_RELAY_TOKEN` (required) and calls `startRelay`, logging the URL.

- [ ] **Step 1: Write the failing integration test `test/integration.test.ts`**

```ts
import { describe, it, expect, afterEach } from "vitest";
import WebSocket from "ws";
import { startRelay } from "../src/server.ts";
import { parseTunnelFrame, encodeFrame } from "@pi-comm/a2a-contract";

const card = {
  name: "worker", description: "echo", version: "1.0.0",
  capabilities: { streaming: true }, defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"], skills: [{ id: "echo", name: "Echo", description: "echoes", tags: [] }],
};

let relay: { port: number; close: () => Promise<void> };
afterEach(async () => { await relay?.close(); });

async function connectEchoAgent(port: number): Promise<void> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/agent`);
  await new Promise<void>((r) => ws.on("open", () => r()));
  ws.send(encodeFrame({ type: "register", token: "t", name: "worker", card }));
  ws.on("message", (raw) => {
    const f = parseTunnelFrame(raw.toString());
    if (f.type === "request") {
      const inText = f.message.parts[0] && "text" in f.message.parts[0] ? (f.message.parts[0] as { text: string }).text : "";
      ws.send(encodeFrame({ type: "chunk", reqId: f.reqId, final: true,
        message: { messageId: "a", role: "ROLE_AGENT", parts: [{ text: `echo:${inText}` }] } }));
    }
  });
  await new Promise((r) => setTimeout(r, 50)); // allow register round-trip
}

describe("relay end-to-end", () => {
  it("routes a client message to a connected agent and back", async () => {
    relay = await startRelay({ port: 0, token: "t" });
    await connectEchoAgent(relay.port);
    const res = await fetch(`http://127.0.0.1:${relay.port}/agents/worker/message:send`, {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "hi" }] } }),
    });
    const body = await res.json();
    expect(body.message.parts[0]).toEqual({ text: "echo:hi" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/relay/test/integration.test.ts`
Expected: FAIL — `../src/server.ts` not found.

- [ ] **Step 3: Implement `src/server.ts`**

```ts
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { AgentRegistry } from "./registry.ts";
import { startTunnelServer } from "./tunnel-server.ts";
import { PendingRequests, createHttpHandler } from "./http-surface.ts";

export async function startRelay(opts: { port: number; token: string }): Promise<{ port: number; close: () => Promise<void> }> {
  const registry = new AgentRegistry();
  const pending = new PendingRequests();
  const handler = createHttpHandler(registry, pending, opts.token);
  const http = createServer(handler);

  const wss = new WebSocketServer({ noServer: true });
  startTunnelServer(wss, registry, opts.token, {
    onChunk: (_tenant, f) => {
      if (f.type === "chunk") pending.push(f.reqId, f.message, f.final);
      else pending.fail(f.reqId, f.error);
    },
  });
  http.on("upgrade", (req, socket, head) => {
    if ((req.url ?? "").startsWith("/agent")) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else { socket.destroy(); }
  });

  await new Promise<void>((r) => http.listen(opts.port, r));
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  return {
    port,
    close: () => new Promise<void>((r) => { wss.close(); http.close(() => r()); }),
  };
}
```

- [ ] **Step 4: Implement `src/index.ts`**

```ts
import { startRelay } from "./server.ts";

const port = Number(process.env.A2A_RELAY_PORT ?? "8787");
const token = process.env.A2A_RELAY_TOKEN;
if (!token) { console.error("A2A_RELAY_TOKEN is required"); process.exit(1); }

startRelay({ port, token }).then(({ port }) => {
  console.log(`pi-comm relay listening on http://127.0.0.1:${port} (agents: ws://.../agent)`);
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/relay/test/integration.test.ts`
Expected: PASS (1 test).

- [ ] **Step 6: Manual smoke test**

Run: `A2A_RELAY_TOKEN=dev node --experimental-strip-types packages/relay/src/index.ts`
Expected: logs `pi-comm relay listening on http://127.0.0.1:8787`. Then in another shell: `curl -s -H "authorization: Bearer dev" http://127.0.0.1:8787/agents` → `{"agents":[]}`. Ctrl-C to stop.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(relay): single-port server (WS tunnel + A2A HTTP) with e2e test"
```

---

### Task 6: Pi extension — config resolution (`packages/pi-extension`)

**Files:**
- Create: `packages/pi-extension/package.json`, `packages/pi-extension/src/config.ts`
- Test: `packages/pi-extension/test/config.test.ts`

**Interfaces:**
- Produces:
  - `interface RelayConfig { relayHttpUrl: string; relayWsUrl: string; token: string; name: string; card: AgentCard; }`
  - `function resolveConfig(input: { flagRelayUrl?: string; flagName?: string; envRelayUrl?: string; envToken?: string; frontmatter?: { name?: string; description?: string }; cwd: string; model: string }): RelayConfig`
    - Relay URL precedence: `flagRelayUrl` > `envRelayUrl` > default `http://127.0.0.1:8787`. Derive `relayWsUrl` by swapping `http`→`ws`/`https`→`wss` and appending `/agent`.
    - Name precedence: `flagName` > `frontmatter.name` > basename of `cwd`.
    - Token: `envToken` (throws `Error("A2A_RELAY_TOKEN not set")` if missing).
    - Card: built from name (`AgentCard.name`), `frontmatter.description ?? "Pi agent"`, `version: "1.0.0"`, `capabilities.streaming: true`, input/output modes `["text/plain"]`, one skill `{ id: "chat", name: "Chat", description: "General Pi coding agent session", tags: ["pi","coding"] }`.

- [ ] **Step 1: Create `packages/pi-extension/package.json`**

```json
{
  "name": "@pi-comm/pi-extension",
  "version": "0.0.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "pi": { "extensions": ["./src/index.ts"] },
  "dependencies": { "@pi-comm/a2a-contract": "*", "ws": "^8.18.0" },
  "peerDependencies": { "@earendil-works/pi-coding-agent": "*" },
  "devDependencies": { "@types/ws": "^8.5.12" }
}
```

- [ ] **Step 2: Write the failing test `test/config.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { resolveConfig } from "../src/config.ts";

const base = { cwd: "/home/u/backend", model: "claude", envToken: "tok" };

describe("resolveConfig", () => {
  it("defaults the relay url and derives ws url", () => {
    const c = resolveConfig(base);
    expect(c.relayHttpUrl).toBe("http://127.0.0.1:8787");
    expect(c.relayWsUrl).toBe("ws://127.0.0.1:8787/agent");
  });
  it("derives wss for https relays", () => {
    const c = resolveConfig({ ...base, flagRelayUrl: "https://relay.example.com" });
    expect(c.relayWsUrl).toBe("wss://relay.example.com/agent");
  });
  it("uses cwd basename as default name", () => {
    expect(resolveConfig(base).name).toBe("backend");
  });
  it("prefers flag name over frontmatter over basename", () => {
    expect(resolveConfig({ ...base, flagName: "api", frontmatter: { name: "fm" } }).name).toBe("api");
    expect(resolveConfig({ ...base, frontmatter: { name: "fm" } }).name).toBe("fm");
  });
  it("throws when token is missing", () => {
    expect(() => resolveConfig({ ...base, envToken: undefined })).toThrow(/A2A_RELAY_TOKEN/);
  });
  it("builds a valid card from name + description", () => {
    const c = resolveConfig({ ...base, frontmatter: { description: "does X" } });
    expect(c.card.name).toBe("backend");
    expect(c.card.description).toBe("does X");
    expect(c.card.capabilities.streaming).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/pi-extension/test/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/config.ts`**

```ts
import { basename } from "node:path";
import type { AgentCard } from "@pi-comm/a2a-contract";

export interface RelayConfig {
  relayHttpUrl: string; relayWsUrl: string; token: string; name: string; card: AgentCard;
}

export function resolveConfig(input: {
  flagRelayUrl?: string; flagName?: string; envRelayUrl?: string; envToken?: string;
  frontmatter?: { name?: string; description?: string }; cwd: string; model: string;
}): RelayConfig {
  const relayHttpUrl = (input.flagRelayUrl || input.envRelayUrl || "http://127.0.0.1:8787").replace(/\/+$/, "");
  const relayWsUrl = relayHttpUrl.replace(/^http/, "ws") + "/agent";
  if (!input.envToken) throw new Error("A2A_RELAY_TOKEN not set");
  const name = input.flagName || input.frontmatter?.name || basename(input.cwd);
  const description = input.frontmatter?.description || "Pi agent";
  const card: AgentCard = {
    name, description, version: "1.0.0",
    capabilities: { streaming: true },
    defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
    skills: [{ id: "chat", name: "Chat", description: "General Pi coding agent session", tags: ["pi", "coding"] }],
  };
  return { relayHttpUrl, relayWsUrl, token: input.envToken, name, card };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/pi-extension/test/config.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(extension): relay config resolution"
```

---

### Task 7: Pi extension — inbound request → Pi turn → captured reply (`packages/pi-extension`)

**Files:**
- Create: `packages/pi-extension/src/inbound.ts`
- Test: `packages/pi-extension/test/inbound.test.ts`

**Interfaces:**
- Consumes: A2A `Message` (Task 1).
- Produces:
  - `interface InboundJob { reqId: string; stream: boolean; contextId?: string; done: boolean; }`
  - `class InboundManager`:
    - `begin(reqId: string, message: Message, stream: boolean): { promptText: string; job: InboundJob }` — extracts concatenated text of all text parts as the prompt, records an open job (keyed by reqId), and returns it. Sets `currentContextId = message.contextId`.
    - `oldestOpen(): InboundJob | undefined`
    - `complete(reqId: string): void`
    - `extractPromptText(message: Message): string` (static-like helper; exported separately too).
  - `function extractPromptText(message: Message): string` — joins all `text` parts with `\n`; ignores non-text parts (v1).

- [ ] **Step 1: Write the failing test `test/inbound.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { InboundManager, extractPromptText } from "../src/inbound.ts";
import type { Message } from "@pi-comm/a2a-contract";

const msg = (text: string, id = "m1"): Message => ({ messageId: id, role: "ROLE_USER", parts: [{ text }] });

describe("extractPromptText", () => {
  it("joins text parts and ignores non-text", () => {
    const m: Message = { messageId: "m", role: "ROLE_USER", parts: [{ text: "a" }, { data: { x: 1 } }, { text: "b" }] };
    expect(extractPromptText(m)).toBe("a\nb");
  });
});

describe("InboundManager", () => {
  it("tracks open jobs FIFO and completes them", () => {
    const mgr = new InboundManager();
    const j1 = mgr.begin("r1", msg("first"), false);
    const j2 = mgr.begin("r2", msg("second"), true);
    expect(j1.promptText).toBe("first");
    expect(mgr.oldestOpen()?.reqId).toBe("r1");
    mgr.complete("r1");
    expect(mgr.oldestOpen()?.reqId).toBe("r2");
    expect(j2.job.stream).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/pi-extension/test/inbound.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/inbound.ts`**

```ts
import type { Message } from "@pi-comm/a2a-contract";

export interface InboundJob { reqId: string; stream: boolean; contextId?: string; done: boolean; }

export function extractPromptText(message: Message): string {
  return message.parts
    .filter((p): p is { text: string } => typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("\n");
}

export class InboundManager {
  private jobs: InboundJob[] = [];

  begin(reqId: string, message: Message, stream: boolean): { promptText: string; job: InboundJob } {
    const job: InboundJob = { reqId, stream, contextId: message.contextId, done: false };
    this.jobs.push(job);
    return { promptText: extractPromptText(message), job };
  }
  oldestOpen(): InboundJob | undefined { return this.jobs.find((j) => !j.done); }
  complete(reqId: string): void {
    const j = this.jobs.find((x) => x.reqId === reqId);
    if (j) j.done = true;
    this.jobs = this.jobs.filter((x) => !x.done || x.reqId === reqId).slice(-50);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/pi-extension/test/inbound.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(extension): inbound job manager + prompt extraction"
```

---

### Task 8: Pi extension — relay client + wiring (`packages/pi-extension`)

**Files:**
- Create: `packages/pi-extension/src/relay-client.ts`, `packages/pi-extension/src/tools.ts`, `packages/pi-extension/src/index.ts`

**Interfaces:**
- Consumes: `resolveConfig` (Task 6), `InboundManager`/`extractPromptText` (Task 7), tunnel frames (Task 2), A2A HTTP surface of the relay (Task 4).
- Produces:
  - `class RelayClient` (wraps a `ws` WebSocket): `connect(): Promise<void>` (opens socket, sends `register`, resolves on `registered` capturing `tenant`), `onRequest(cb: (f: RequestFrame) => void)`, `sendChunk(reqId, message, final)`, `sendError(reqId, err)`, `get tenant()`, `close()`, plus 15s ping heartbeat and reconnect-with-backoff on unexpected close.
  - Default export `(pi: ExtensionAPI) => void` in `index.ts` that:
    - Registers flags `--a2a-relay` (string) and `--a2a-name` (string).
    - On `session_start`: resolves config, connects `RelayClient`, sets status `📡 a2a:<tenant>`, wires inbound requests through `InboundManager` → `pi.sendMessage({ customType: "a2a-inbound", content: promptText, display: true }, { deliverAs: "followUp", triggerTurn: true })`.
    - Streaming: on `message_update` (assistant deltas) for a streaming job, call `client.sendChunk(reqId, textMessage("ROLE_AGENT", deltaText), false)`. On `agent_end`, read the final assistant text from `ctx.sessionManager.getBranch()` and call `sendChunk(reqId, finalMessage, true)`, then `mgr.complete(reqId)`. For non-stream jobs, only send the final chunk with `final: true`.
    - On `session_shutdown`: `client.close()` and clear status.
  - `tools.ts` exports `registerA2ATools(pi, getConfig)` adding:
    - `a2a_list` → GET `<relayHttpUrl>/agents`, returns the roster (excluding own tenant).
    - `a2a_send` → POST `<relayHttpUrl>/agents/{target}/message:send` with `{ message: textMessage("ROLE_USER", prompt) }`, returns the agent's reply text.

- [ ] **Step 1: Implement `src/relay-client.ts`**

```ts
import WebSocket from "ws";
import {
  encodeFrame, parseTunnelFrame,
  type RequestFrame, type Message, type AgentCard,
} from "@pi-comm/a2a-contract";

export class RelayClient {
  private ws: WebSocket | null = null;
  private _tenant: string | null = null;
  private requestCb: ((f: RequestFrame) => void) | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private opts: { wsUrl: string; token: string; name: string; card: AgentCard }) {}

  get tenant(): string | null { return this._tenant; }
  onRequest(cb: (f: RequestFrame) => void): void { this.requestCb = cb; }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.wsUrl);
      this.ws = ws;
      ws.on("open", () => {
        ws.send(encodeFrame({ type: "register", token: this.opts.token, name: this.opts.name, card: this.opts.card }));
      });
      ws.on("message", (raw) => {
        let f; try { f = parseTunnelFrame(raw.toString()); } catch { return; }
        if (f.type === "registered") { this._tenant = f.tenant; this.startHeartbeat(); resolve(); }
        else if (f.type === "request") { this.requestCb?.(f); }
        else if (f.type === "pong") { /* alive */ }
      });
      ws.on("error", (e) => { if (!this._tenant) reject(e); });
      ws.on("close", () => { this.stopHeartbeat(); if (!this.closed) this.scheduleReconnect(); });
    });
  }
  sendChunk(reqId: string, message: Message, final: boolean): void {
    this.ws?.send(encodeFrame({ type: "chunk", reqId, message, final }));
  }
  sendError(reqId: string, error: string): void {
    this.ws?.send(encodeFrame({ type: "error", reqId, error }));
  }
  close(): void { this.closed = true; this.stopHeartbeat(); this.ws?.close(); }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => { try { this.ws?.send(encodeFrame({ type: "ping" })); } catch { /* */ } }, 15_000);
    (this.heartbeat as { unref?: () => void }).unref?.();
  }
  private stopHeartbeat(): void { if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null; }
  private scheduleReconnect(): void {
    const t = setTimeout(() => { this.connect().catch(() => this.scheduleReconnect()); }, 1000);
    (t as { unref?: () => void }).unref?.();
  }
}
```

- [ ] **Step 2: Implement `src/tools.ts`**

```ts
import { Type } from "typebox";
import { textMessage } from "@pi-comm/a2a-contract";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RelayConfig } from "./config.ts";

export function registerA2ATools(pi: ExtensionAPI, getConfig: () => RelayConfig | null, getTenant: () => string | null): void {
  pi.registerTool({
    name: "a2a_list",
    label: "A2A List",
    description: "List other Pi agents connected to the relay (name + description).",
    parameters: Type.Object({}),
    async execute() {
      const cfg = getConfig(); if (!cfg) throw new Error("a2a not initialised");
      const res = await fetch(`${cfg.relayHttpUrl}/agents`, { headers: { authorization: `Bearer ${cfg.token}` } });
      const body = await res.json() as { agents: Array<{ tenant: string; card: { description: string } }> };
      const me = getTenant();
      const peers = body.agents.filter((a) => a.tenant !== me);
      const text = peers.length ? peers.map((a) => `- ${a.tenant}: ${a.card.description}`).join("\n") : "No peers.";
      return { content: [{ type: "text", text }], details: { peers } };
    },
  });

  pi.registerTool({
    name: "a2a_send",
    label: "A2A Send",
    description: "Send a prompt to another connected Pi agent (by its relay name) and return its reply.",
    parameters: Type.Object({
      target: Type.String({ description: "Target agent's relay tenant/name (from a2a_list)." }),
      prompt: Type.String({ description: "The message to send." }),
    }),
    async execute(_id, params) {
      const cfg = getConfig(); if (!cfg) throw new Error("a2a not initialised");
      const res = await fetch(`${cfg.relayHttpUrl}/agents/${encodeURIComponent(params.target)}/message:send`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
        body: JSON.stringify({ message: textMessage("ROLE_USER", params.prompt) }),
      });
      if (!res.ok) throw new Error(`a2a_send failed: HTTP ${res.status}`);
      const body = await res.json() as { message: { parts: Array<{ text?: string }> } };
      const text = body.message.parts.map((p) => p.text ?? "").join("");
      return { content: [{ type: "text", text }], details: { target: params.target } };
    },
  });
}
```

- [ ] **Step 3: Implement `src/index.ts`**

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { textMessage, type RequestFrame } from "@pi-comm/a2a-contract";
import { resolveConfig, type RelayConfig } from "./config.ts";
import { RelayClient } from "./relay-client.ts";
import { InboundManager } from "./inbound.ts";
import { registerA2ATools } from "./tools.ts";

export default function (pi: ExtensionAPI): void {
  pi.registerFlag("a2a-relay", { description: "Relay base URL (http/https)", type: "string", default: undefined });
  pi.registerFlag("a2a-name", { description: "Agent name on the relay", type: "string", default: undefined });

  let config: RelayConfig | null = null;
  let client: RelayClient | null = null;
  const mgr = new InboundManager();
  const jobByReqId = new Map<string, RequestFrame>();

  registerA2ATools(pi, () => config, () => client?.tenant ?? null);

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    try {
      config = resolveConfig({
        flagRelayUrl: pi.getFlag("a2a-relay") as string | undefined,
        flagName: pi.getFlag("a2a-name") as string | undefined,
        envRelayUrl: process.env.A2A_RELAY_URL,
        envToken: process.env.A2A_RELAY_TOKEN,
        cwd: ctx.cwd, model: ctx.model?.id ?? "unknown",
      });
    } catch (e) { ctx.ui?.notify?.(`a2a: ${(e as Error).message}`, "error"); return; }

    client = new RelayClient({ wsUrl: config.relayWsUrl, token: config.token, name: config.name, card: config.card });
    client.onRequest((f) => {
      jobByReqId.set(f.reqId, f);
      const { promptText } = mgr.begin(f.reqId, f.message, f.stream);
      pi.sendMessage(
        { customType: "a2a-inbound", content: `[a2a message from relay]\n\n${promptText}`, display: true, details: { reqId: f.reqId } },
        { deliverAs: "followUp", triggerTurn: true },
      );
    });
    try {
      await client.connect();
      ctx.ui?.setStatus?.("a2a", `📡 a2a:${client.tenant}`);
    } catch (e) { ctx.ui?.notify?.(`a2a: connect failed — ${(e as Error).message}`, "error"); }
  });

  pi.on("message_update", async (event) => {
    const job = mgr.oldestOpen();
    if (!job || !job.stream || !client) return;
    const m = event.message as { role?: string; content?: unknown };
    if (m.role !== "assistant") return;
    const delta = typeof m.content === "string" ? m.content : "";
    if (delta) client.sendChunk(job.reqId, textMessage("ROLE_AGENT", delta, { contextId: job.contextId }), false);
  });

  pi.on("agent_end", async (_event, ctx) => {
    const job = mgr.oldestOpen();
    if (!job || !client) return;
    let text = "";
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        const c = (entry.message as { content: unknown }).content;
        if (typeof c === "string") text = c;
        else if (Array.isArray(c)) text = c.filter((b: { type?: string }) => b?.type === "text").map((b: { text?: string }) => b.text ?? "").join("\n");
      }
    }
    client.sendChunk(job.reqId, textMessage("ROLE_AGENT", text, { contextId: job.contextId }), true);
    mgr.complete(job.reqId);
    jobByReqId.delete(job.reqId);
  });

  pi.on("session_shutdown", async (_e, ctx) => { client?.close(); ctx.ui?.setStatus?.("a2a", ""); });
}
```

- [ ] **Step 4: Typecheck the extension**

Run: `cd /home/qmiclap/gitrepos/pi-comm && npx tsc --noEmit -p packages/pi-extension/tsconfig.json` (create a minimal `packages/pi-extension/tsconfig.json` extending `../../tsconfig.base.json` with `"include": ["src"]`).
Expected: no type errors. (Note: `@earendil-works/pi-coding-agent` must be resolvable; if not installed as a workspace dep, install it in the extension package for typecheck only.)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(extension): relay client + inbound serving + a2a tools"
```

---

### Task 9: Live milestone — two Pi agents talk through a local relay

**Files:** none (manual verification).

- [ ] **Step 1: Start the relay**

Run: `A2A_RELAY_TOKEN=dev node --experimental-strip-types packages/relay/src/index.ts`

- [ ] **Step 2: Launch two Pi sessions with the extension**

In terminal A (dir `~/tmp/agent-a`): `A2A_RELAY_TOKEN=dev A2A_RELAY_URL=http://127.0.0.1:8787 pi -e /home/qmiclap/gitrepos/pi-comm/packages/pi-extension/src/index.ts --a2a-name alice`
In terminal B (dir `~/tmp/agent-b`): same with `--a2a-name bob`.
Expected: each shows status `📡 a2a:alice` / `📡 a2a:bob`.

- [ ] **Step 3: From Alice, list and message Bob**

In terminal A, prompt: `Use a2a_list to see peers, then a2a_send to ask bob: "reply with the word PONG"`.
Expected: Alice's `a2a_send` returns Bob's reply containing `PONG`; Bob's terminal shows an injected `[a2a message from relay]` turn.

- [ ] **Step 4: Verify roster over HTTP**

Run: `curl -s -H "authorization: Bearer dev" http://127.0.0.1:8787/agents | jq '.agents[].tenant'`
Expected: `"alice"` and `"bob"`.

- [ ] **Step 5: Commit a short RUNBOOK**

Create `docs/RUNBOOK.md` documenting steps 1–4, then:
```bash
git add -A && git commit -m "docs: local two-agent runbook"
```

---

> **Frontend protocol note (deferred, see open item 6):** Tasks 10–11 build a small bespoke React chat as the v1 fallback. The intended longer-term frontend is **AG-UI** (agent→UI event stream: `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `STATE_*`) + **A2UI** (server-driven UI), with a reference implementation already available at `/home/qmiclap/gitrepos/e-agentic` (packages `e-agentic-ui`, `e-agentic-sdk`, `e-agentic-gateway`). Do NOT wire AG-UI/A2UI in this plan — the user marked it "for later". Keep Task 10's `A2AClient` isolated so a future AG-UI adapter can replace the transport without touching the relay.

### Task 10: Web app — A2A client + scaffold (`apps/web`)

**Files:**
- Create: `apps/web/package.json`, `apps/web/vite.config.ts`, `apps/web/index.html`, `apps/web/src/a2a-client.ts`, `apps/web/src/main.tsx`
- Test: `apps/web/test/a2a-client.test.ts`

**Interfaces:**
- Produces:
  - `class A2AClient` (constructed with `{ baseUrl: string; token: string }`):
    - `listAgents(): Promise<Array<{ tenant: string; card: AgentCard }>>` — GET `/agents`.
    - `send(tenant: string, text: string): Promise<string>` — POST `message:send`, returns reply text.
    - `stream(tenant: string, text: string, onDelta: (text: string) => void): Promise<void>` — POST `message:stream`, parses SSE via `fetch` + `ReadableStream`, calls `onDelta` per chunk, resolves on `[DONE]`.

- [ ] **Step 1: Create `apps/web/package.json`**

```json
{
  "name": "@pi-comm/web",
  "version": "0.0.0",
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": { "dev": "vite", "build": "vite build", "preview": "vite preview" },
  "dependencies": { "react": "^18.3.1", "react-dom": "^18.3.1", "@pi-comm/a2a-contract": "*" },
  "devDependencies": { "vite": "^5.4.0", "@vitejs/plugin-react": "^4.3.0", "@types/react": "^18.3.0", "@types/react-dom": "^18.3.0" }
}
```

- [ ] **Step 2: Write the failing test `test/a2a-client.test.ts`**

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { A2AClient } from "../src/a2a-client.ts";

afterEach(() => vi.restoreAllMocks());

describe("A2AClient", () => {
  it("lists agents with the bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ agents: [{ tenant: "a", card: {} }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const c = new A2AClient({ baseUrl: "http://r", token: "t" });
    const agents = await c.listAgents();
    expect(agents[0].tenant).toBe("a");
    expect(fetchMock).toHaveBeenCalledWith("http://r/agents", expect.objectContaining({ headers: { authorization: "Bearer t" } }));
  });

  it("returns reply text from send", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { parts: [{ text: "hi " }, { text: "there" }] } }) }));
    const c = new A2AClient({ baseUrl: "http://r", token: "t" });
    expect(await c.send("a", "q")).toBe("hi there");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run apps/web/test/a2a-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `src/a2a-client.ts`**

```ts
import type { AgentCard } from "@pi-comm/a2a-contract";

export class A2AClient {
  constructor(private opts: { baseUrl: string; token: string }) {}
  private auth() { return { authorization: `Bearer ${this.opts.token}` }; }

  async listAgents(): Promise<Array<{ tenant: string; card: AgentCard }>> {
    const res = await fetch(`${this.opts.baseUrl}/agents`, { headers: this.auth() });
    if (!res.ok) throw new Error(`listAgents HTTP ${res.status}`);
    return (await res.json() as { agents: Array<{ tenant: string; card: AgentCard }> }).agents;
  }

  async send(tenant: string, text: string): Promise<string> {
    const res = await fetch(`${this.opts.baseUrl}/agents/${encodeURIComponent(tenant)}/message:send`, {
      method: "POST",
      headers: { ...this.auth(), "content-type": "application/json" },
      body: JSON.stringify({ message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }] } }),
    });
    if (!res.ok) throw new Error(`send HTTP ${res.status}`);
    const body = await res.json() as { message: { parts: Array<{ text?: string }> } };
    return body.message.parts.map((p) => p.text ?? "").join("");
  }

  async stream(tenant: string, text: string, onDelta: (t: string) => void): Promise<void> {
    const res = await fetch(`${this.opts.baseUrl}/agents/${encodeURIComponent(tenant)}/message:stream`, {
      method: "POST",
      headers: { ...this.auth(), "content-type": "application/json" },
      body: JSON.stringify({ message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }] } }),
    });
    if (!res.body) throw new Error("no stream body");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const line = frame.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") return;
        try {
          const parsed = JSON.parse(data) as { message?: { parts: Array<{ text?: string }> } };
          const t = parsed.message?.parts.map((p) => p.text ?? "").join("") ?? "";
          if (t) onDelta(t);
        } catch { /* ignore */ }
      }
    }
  }
}
```

- [ ] **Step 5: Create `vite.config.ts`, `index.html`, `src/main.tsx` (minimal boot)**

`apps/web/vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()] });
```
`apps/web/index.html`:
```html
<!doctype html><html><head><meta charset="utf-8"><title>pi-comm</title></head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
```
`apps/web/src/main.tsx`:
```tsx
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
createRoot(document.getElementById("root")!).render(<App />);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run apps/web/test/a2a-client.test.ts`
Expected: PASS (2 tests). (`App.tsx` is created in Task 11; until then `main.tsx` will fail to build — that's fine, the unit test targets `a2a-client.ts` only.)

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(web): A2A fetch client (roster, send, SSE stream) + scaffold"
```

---

### Task 11: Web app — roster + chat + tool-call panel (`apps/web`)

**Files:**
- Create: `apps/web/src/App.tsx`, `apps/web/src/components/Roster.tsx`, `apps/web/src/components/Chat.tsx`, `apps/web/src/components/ToolCallPanel.tsx`

**Interfaces:**
- Consumes: `A2AClient` (Task 10).
- Produces: an SPA with a settings bar (relay URL + token, persisted to `localStorage`), a left `Roster` (polls `listAgents` every 3s, click to select a tenant), a `Chat` (message list + input, uses `client.stream` and appends deltas to the current agent bubble), and a `ToolCallPanel` placeholder (renders `data` parts whose `metadata.kind === "tool_call"`, deferred to a later plan — v1 shows an empty panel with a heading).

- [ ] **Step 1: Implement `src/components/Roster.tsx`**

```tsx
import { useEffect, useState } from "react";
import type { A2AClient } from "../a2a-client.ts";

export function Roster({ client, selected, onSelect }: { client: A2AClient; selected: string | null; onSelect: (t: string) => void }) {
  const [agents, setAgents] = useState<Array<{ tenant: string; card: { description: string } }>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const a = await client.listAgents(); if (live) { setAgents(a as never); setError(null); } }
      catch (e) { if (live) setError((e as Error).message); }
    };
    tick(); const id = setInterval(tick, 3000);
    return () => { live = false; clearInterval(id); };
  }, [client]);
  return (
    <aside style={{ width: 240, borderRight: "1px solid var(--border, #333)", padding: 8, overflowY: "auto" }}>
      <h3>Agents</h3>
      {error && <div style={{ color: "var(--red, tomato)" }}>{error}</div>}
      {agents.map((a) => (
        <button key={a.tenant} onClick={() => onSelect(a.tenant)}
          style={{ display: "block", width: "100%", textAlign: "left", padding: 6, marginBottom: 4,
            background: a.tenant === selected ? "var(--layer2, #2a2a2a)" : "transparent", color: "inherit", border: "none", cursor: "pointer" }}>
          <strong>{a.tenant}</strong><br /><small>{a.card.description}</small>
        </button>
      ))}
    </aside>
  );
}
```

- [ ] **Step 2: Implement `src/components/Chat.tsx`**

```tsx
import { useState } from "react";
import type { A2AClient } from "../a2a-client.ts";

interface Turn { role: "user" | "agent"; text: string; }

export function Chat({ client, tenant }: { client: A2AClient; tenant: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    const text = input.trim(); if (!text || busy) return;
    setInput(""); setBusy(true);
    setTurns((t) => [...t, { role: "user", text }, { role: "agent", text: "" }]);
    try {
      await client.stream(tenant, text, (delta) => {
        setTurns((t) => { const copy = [...t]; copy[copy.length - 1] = { role: "agent", text: copy[copy.length - 1].text + delta }; return copy; });
      });
    } catch (e) {
      setTurns((t) => { const copy = [...t]; copy[copy.length - 1] = { role: "agent", text: `⚠️ ${(e as Error).message}` }; return copy; });
    } finally { setBusy(false); }
  }

  return (
    <section style={{ flex: 1, display: "flex", flexDirection: "column" }}>
      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {turns.map((t, i) => (
          <div key={i} style={{ margin: "8px 0", textAlign: t.role === "user" ? "right" : "left" }}>
            <span style={{ display: "inline-block", padding: "6px 10px", borderRadius: 8, whiteSpace: "pre-wrap",
              background: t.role === "user" ? "var(--blue, #2b6cb0)" : "var(--layer1, #222)" }}>{t.text || "…"}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", padding: 8, borderTop: "1px solid var(--border, #333)" }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={`Message ${tenant}…`} style={{ flex: 1, padding: 8 }} disabled={busy} />
        <button onClick={submit} disabled={busy} style={{ marginLeft: 8, padding: "8px 16px" }}>Send</button>
      </div>
    </section>
  );
}
```

- [ ] **Step 3: Implement `src/components/ToolCallPanel.tsx`**

```tsx
export function ToolCallPanel() {
  return (
    <aside style={{ width: 260, borderLeft: "1px solid var(--border, #333)", padding: 8 }}>
      <h3>Tool calls</h3>
      <small style={{ opacity: 0.6 }}>Streaming of tool calls is deferred to a later milestone.</small>
    </aside>
  );
}
```

- [ ] **Step 4: Implement `src/App.tsx`**

```tsx
import { useMemo, useState } from "react";
import { A2AClient } from "./a2a-client.ts";
import { Roster } from "./components/Roster.tsx";
import { Chat } from "./components/Chat.tsx";
import { ToolCallPanel } from "./components/ToolCallPanel.tsx";

export function App() {
  const [baseUrl, setBaseUrl] = useState(localStorage.getItem("a2a.url") ?? "http://127.0.0.1:8787");
  const [token, setToken] = useState(localStorage.getItem("a2a.token") ?? "");
  const [selected, setSelected] = useState<string | null>(null);
  const client = useMemo(() => new A2AClient({ baseUrl, token }), [baseUrl, token]);

  function save() { localStorage.setItem("a2a.url", baseUrl); localStorage.setItem("a2a.token", token); }

  return (
    <div style={{ fontFamily: "system-ui", height: "100vh", display: "flex", flexDirection: "column", color: "var(--text, #eee)", background: "var(--layer0, #111)" }}>
      <header style={{ display: "flex", gap: 8, padding: 8, borderBottom: "1px solid var(--border, #333)" }}>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="relay url" style={{ flex: 1, padding: 6 }} />
        <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="token" type="password" style={{ width: 160, padding: 6 }} />
        <button onClick={save}>Save</button>
      </header>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <Roster client={client} selected={selected} onSelect={setSelected} />
        {selected ? <Chat client={client} tenant={selected} /> : <section style={{ flex: 1, display: "grid", placeItems: "center", opacity: 0.6 }}>Select an agent</section>}
        <ToolCallPanel />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Build the web app**

Run: `cd /home/qmiclap/gitrepos/pi-comm && npm run build -w @pi-comm/web`
Expected: Vite build succeeds, emits `apps/web/dist`.

- [ ] **Step 6: Manual verification against the live milestone**

With the relay + Alice + Bob running (Task 9), run `npm run dev -w @pi-comm/web`, open the URL, set relay `http://127.0.0.1:8787` + token `dev`, Save. Expected: roster shows `alice` and `bob`; selecting one and sending a message streams a reply; the target Pi terminal shows the injected turn.

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(web): roster + streaming chat + tool-call panel placeholder"
```

---

## Self-Review Checklist (run before execution)

- **Spec coverage:** relay-fronts-agents ✓ (Tasks 3–5); AgentCard roster ✓ (Task 4 `/agents`); tenant path routing ✓ (Task 4); message:send + message:stream ✓ (Task 4); local-or-remote via URL ✓ (Task 6 config); pi↔pi ✓ (Task 8 tools + Task 9 milestone); web app reaching all sessions ✓ (Tasks 10–11); bearer auth ✓ (Task 4/6). Deferred by design: Task/Artifact lifecycle, push, tool-call streaming to web, images, pairing crypto.
- **Type consistency:** `AgentCard`, `Message`, `Part`, `Role`, `StreamResponse`, tunnel frames defined once in `a2a-contract` (Tasks 1–2) and imported everywhere; `RelayConfig` shape stable across Tasks 6/8; `A2AClient` method names (`listAgents`/`send`/`stream`) match between Tasks 10 and 11.
- **Streaming binding note:** documented relaxation (partial `{message}` frames + `[DONE]`) applied consistently in relay (Task 4) and web client (Task 10).

## Open items intentionally deferred to a future plan

1. Tool-call streaming to the web panel (map Pi `tool_execution_*` events into A2A `Part{data, metadata.kind:"tool_call"}`).
2. Real A2A HTTP+JSON-RPC binding per agent (for strict external interop) alongside the current path-based REST binding.
3. Pairing/identity (Ed25519) if the relay is exposed publicly; today auth is a single shared bearer suitable for localhost/VPN.
4. Reconnect/resume semantics for in-flight streams across relay restarts.
5. Images and non-text `Part`s end-to-end.
6. **AG-UI + A2UI frontend.** Replace the bespoke React chat (Tasks 10–11) with an AG-UI event stream + A2UI server-driven UI, reusing the reference project at `/home/qmiclap/gitrepos/e-agentic` (`e-agentic-ui`, `e-agentic-sdk`, `e-agentic-gateway`). This likely means: (a) a relay adapter that emits AG-UI events instead of / alongside the current SSE `{message}` frames, and (b) mapping Pi tool-call events to AG-UI `TOOL_CALL_*` and A2UI render directives. Evaluate whether the relay speaks AG-UI natively or a thin gateway (like `e-agentic-gateway`) sits between relay and browser.
```
