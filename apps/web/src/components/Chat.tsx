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
