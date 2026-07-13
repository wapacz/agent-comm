import { basename } from "node:path";
import type { AgentCard } from "@pi-comm/a2a-contract";

export interface RelayConfig {
  relayHttpUrl: string;
  relayWsUrl: string;
  token: string;
  name: string;
  card: AgentCard;
}

export function resolveConfig(input: {
  flagRelayUrl?: string;
  flagName?: string;
  envRelayUrl?: string;
  envToken?: string;
  frontmatter?: { name?: string; description?: string };
  cwd: string;
  model: string;
}): RelayConfig {
  const relayHttpUrl = (input.flagRelayUrl || input.envRelayUrl || "http://127.0.0.1:8787").replace(/\/+$/, "");
  const relayWsUrl = relayHttpUrl.replace(/^http/, "ws") + "/agent";

  if (!input.envToken) throw new Error("A2A_RELAY_TOKEN not set");

  const name = input.flagName || input.frontmatter?.name || basename(input.cwd);
  const description = input.frontmatter?.description ?? "Pi agent";

  const card: AgentCard = {
    name,
    description,
    version: "1.0.0",
    capabilities: { streaming: true },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "chat",
        name: "Chat",
        description: "General Pi coding agent session",
        tags: ["pi", "coding"],
      },
    ],
  };

  return { relayHttpUrl, relayWsUrl, token: input.envToken, name, card };
}
