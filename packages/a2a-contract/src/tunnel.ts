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
