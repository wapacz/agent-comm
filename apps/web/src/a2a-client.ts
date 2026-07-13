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
    if (!res.ok) throw new Error(`stream HTTP ${res.status}`);
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
