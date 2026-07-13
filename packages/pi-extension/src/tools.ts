import { Type } from "typebox";
import { textMessage } from "@pi-comm/a2a-contract";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RelayConfig } from "./config.ts";

export function registerA2ATools(
  pi: ExtensionAPI,
  getConfig: () => RelayConfig | null,
  getTenant: () => string | null,
): void {
  pi.registerTool({
    name: "a2a_list",
    label: "A2A List",
    description: "List other Pi agents connected to the relay (name + description).",
    parameters: Type.Object({}),
    async execute() {
      const cfg = getConfig();
      if (!cfg) throw new Error("a2a not initialised");
      const res = await fetch(`${cfg.relayHttpUrl}/agents`, {
        headers: { authorization: `Bearer ${cfg.token}` },
      });
      if (!res.ok) throw new Error(`a2a_list failed: HTTP ${res.status}`);
      const body = (await res.json()) as {
        agents: Array<{ tenant: string; card: { description: string } }>;
      };
      const me = getTenant();
      const peers = body.agents.filter((a) => a.tenant !== me);
      const text = peers.length
        ? peers.map((a) => `- ${a.tenant}: ${a.card.description}`).join("\n")
        : "No peers.";
      return { content: [{ type: "text" as const, text }], details: { peers } };
    },
  });

  pi.registerTool({
    name: "a2a_send",
    label: "A2A Send",
    description:
      "Send a prompt to another connected Pi agent (by its relay name) and return its reply.",
    parameters: Type.Object({
      target: Type.String({ description: "Target agent's relay tenant/name (from a2a_list)." }),
      prompt: Type.String({ description: "The message to send." }),
    }),
    async execute(_toolCallId, params) {
      const cfg = getConfig();
      if (!cfg) throw new Error("a2a not initialised");
      const res = await fetch(
        `${cfg.relayHttpUrl}/agents/${encodeURIComponent(params.target)}/message:send`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${cfg.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ message: textMessage("ROLE_USER", params.prompt) }),
        },
      );
      if (!res.ok) throw new Error(`a2a_send failed: HTTP ${res.status}`);
      const body = (await res.json()) as { message: { parts: Array<{ text?: string }> } };
      const text = body.message.parts.map((p) => p.text ?? "").join("");
      return { content: [{ type: "text" as const, text }], details: { target: params.target } };
    },
  });
}
