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
    throw new Error(`Invalid A2A Message: ${first?.message ?? "schema mismatch"}`);
  }
  return x as Message;
}

export function validateAgentCard(x: unknown): AgentCard {
  if (!Value.Check(AgentCardSchema, x)) {
    const first = [...Value.Errors(AgentCardSchema, x)][0];
    throw new Error(`Invalid A2A AgentCard: ${first?.message ?? "schema mismatch"}`);
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
