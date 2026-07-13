import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { textMessage } from "@pi-comm/a2a-contract";
import { resolveConfig, type RelayConfig } from "./config.ts";
import { RelayClient } from "./relay-client.ts";
import { InboundManager } from "./inbound.ts";
import { registerA2ATools } from "./tools.ts";

export default function (pi: ExtensionAPI): void {
  pi.registerFlag("a2a-relay", {
    description: "Relay base URL (http/https)",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("a2a-name", {
    description: "Agent name on the relay",
    type: "string",
    default: undefined,
  });

  let config: RelayConfig | null = null;
  let client: RelayClient | null = null;
  const mgr = new InboundManager();

  registerA2ATools(pi, () => config, () => client?.tenant ?? null);

  pi.on("session_start", async (_event, ctx) => {
    try {
      config = resolveConfig({
        flagRelayUrl: pi.getFlag("a2a-relay") as string | undefined,
        flagName: pi.getFlag("a2a-name") as string | undefined,
        envRelayUrl: process.env["A2A_RELAY_URL"],
        envToken: process.env["A2A_RELAY_TOKEN"],
        cwd: ctx.cwd,
        model: ctx.model?.id ?? "unknown",
      });
    } catch (e) {
      ctx.ui.notify(`a2a: ${(e as Error).message}`, "error");
      return;
    }

    client = new RelayClient({
      wsUrl: config.relayWsUrl,
      token: config.token,
      name: config.name,
      card: config.card,
    });

    client.onRequest((f) => {
      const { promptText } = mgr.begin(f.reqId, f.message, f.stream);
      pi.sendMessage(
        {
          customType: "a2a-inbound",
          content: `[a2a message from relay]\n\n${promptText}`,
          display: true,
          details: { reqId: f.reqId },
        },
        { deliverAs: "followUp", triggerTurn: true },
      );
    });

    try {
      await client.connect();
      ctx.ui.setStatus("a2a", `📡 a2a:${client.tenant}`);
    } catch (e) {
      ctx.ui.notify(`a2a: connect failed — ${(e as Error).message}`, "error");
    }
  });

  // Stream assistant deltas back to the requesting agent
  pi.on("message_update", (event) => {
    const job = mgr.oldestOpen();
    if (!job || !job.stream || !client) return;
    // Use assistantMessageEvent to extract the text delta directly
    const ame = event.assistantMessageEvent;
    if (ame.type !== "text_delta") return;
    client.sendChunk(
      job.reqId,
      textMessage("ROLE_AGENT", ame.delta, { contextId: job.contextId }),
      false,
    );
  });

  // Send the final chunk once the agent turn completes
  pi.on("agent_end", (event, _ctx) => {
    const job = mgr.oldestOpen();
    if (!job || !client) return;

    // Extract the last assistant text from the agent messages in this turn
    let text = "";
    for (const m of event.messages) {
      const msg = m as { role?: string; content?: unknown };
      if (msg.role !== "assistant") continue;
      const c = msg.content;
      if (Array.isArray(c)) {
        text = (c as Array<{ type?: string; text?: string }>)
          .filter((b) => b?.type === "text")
          .map((b) => b.text ?? "")
          .join("\n");
      }
    }

    // For streaming jobs the incremental deltas already delivered all content to
    // the client; sending the full accumulated text again as the final chunk
    // would cause append-style clients (e.g. the web UI) to render it twice.
    // For non-streaming jobs no deltas were sent, so the final chunk must carry
    // the full text.
    const finalText = job.stream ? "" : text;
    client.sendChunk(
      job.reqId,
      textMessage("ROLE_AGENT", finalText, { contextId: job.contextId }),
      true,
    );
    mgr.complete(job.reqId);
  });

  pi.on("session_shutdown", (_e, ctx) => {
    client?.close();
    ctx.ui.setStatus("a2a", undefined);
  });
}
