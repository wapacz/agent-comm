import { basename } from "node:path";

export interface PtyHostConfig {
  wsUrl: string; token: string; name: string; command: string; args: string[]; cwd: string; description: string;
}

export function resolvePtyConfig(input: {
  envRelayUrl?: string; envToken?: string; flagName?: string; flagDescription?: string;
  command?: string; args?: string[]; cwd: string;
}): PtyHostConfig {
  const relayHttpUrl = (input.envRelayUrl || "http://127.0.0.1:8787").replace(/\/+$/, "");
  const wsUrl = relayHttpUrl.replace(/^http/, "ws") + "/pty";
  if (!input.envToken) throw new Error("RELAY_TOKEN not set");
  const name = input.flagName || basename(input.cwd);
  const command = input.command || "pi";
  return {
    wsUrl, token: input.envToken, name,
    command,
    args: input.args ?? [],
    cwd: input.cwd,
    description: input.flagDescription || command,
  };
}
