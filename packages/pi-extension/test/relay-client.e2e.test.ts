import { describe, it, expect, afterEach } from "vitest";
import { startRelay } from "@pi-comm/relay";
import { RelayClient } from "../src/relay-client.ts";
import { textMessage, type AgentCard, type Message } from "@pi-comm/a2a-contract";

/** Returns the text of the first text Part, or "" if none. */
function firstText(msg: Message): string {
  for (const p of msg.parts) {
    if ("text" in p) return p.text;
  }
  return "";
}

const card: AgentCard = {
  name: "worker",
  description: "test worker agent",
  version: "0.0.0",
  capabilities: { streaming: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: [],
};

describe("RelayClient e2e round-trip", () => {
  let relay: Awaited<ReturnType<typeof startRelay>> | null = null;
  let client: RelayClient | null = null;
  let client2: RelayClient | null = null;

  afterEach(async () => {
    client?.close();
    client2?.close();
    if (relay) await relay.close();
    relay = null;
    client = null;
    client2 = null;
  });

  it(
    "routes a message through the relay and returns echo reply",
    async () => {
      relay = await startRelay({ port: 0, token: "t" });
      const { port } = relay;

      client = new RelayClient({
        wsUrl: `ws://127.0.0.1:${port}/agent`,
        token: "t",
        name: "worker",
        card,
      });

      client.onRequest((f) => {
        client!.sendChunk(
          f.reqId,
          textMessage("ROLE_AGENT", `echo:${firstText(f.message)}`, {
            contextId: f.message.contextId,
          }),
          true,
        );
      });

      await client.connect();

      const resp = await fetch(`http://127.0.0.1:${port}/agents/worker/message:send`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer t",
        },
        body: JSON.stringify({ message: textMessage("ROLE_USER", "hi") }),
      });

      expect(resp.status).toBe(200);
      const data = (await resp.json()) as { message: Message };
      expect(firstText(data.message)).toBe("echo:hi");
    },
    10_000,
  );

  it(
    "deduplicates name and assigns worker#2 to the second registrant",
    async () => {
      relay = await startRelay({ port: 0, token: "t" });
      const { port } = relay;

      client = new RelayClient({
        wsUrl: `ws://127.0.0.1:${port}/agent`,
        token: "t",
        name: "worker",
        card,
      });
      await client.connect();

      client2 = new RelayClient({
        wsUrl: `ws://127.0.0.1:${port}/agent`,
        token: "t",
        name: "worker",
        card,
      });
      await client2.connect();

      expect(client.tenant).toBe("worker");
      expect(client2.tenant).toBe("worker#2");
    },
    10_000,
  );
});
