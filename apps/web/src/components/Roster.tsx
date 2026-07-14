import { useEffect, useState } from "react";
import type { A2AClient } from "../a2a-client.ts";

export function Roster({ client, selected, onSelect }: { client: A2AClient; selected: string | null; onSelect: (t: string) => void }) {
  const [terminals, setTerminals] = useState<Array<{ tenant: string; description?: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const a = await client.listTerminals(); if (live) { setTerminals(a); setError(null); } }
      catch (e) { if (live) setError((e as Error).message); }
    };
    tick(); const id = setInterval(tick, 3000);
    return () => { live = false; clearInterval(id); };
  }, [client]);
  return (
    <aside style={{ width: 240, borderRight: "1px solid var(--border, #333)", padding: 8, overflowY: "auto" }}>
      <h3>Terminals</h3>
      {error && <div style={{ color: "var(--red, tomato)" }}>{error}</div>}
      {terminals.map((a) => (
        <button key={a.tenant} onClick={() => onSelect(a.tenant)}
          style={{ display: "block", width: "100%", textAlign: "left", padding: 6, marginBottom: 4,
            background: a.tenant === selected ? "var(--layer2, #2a2a2a)" : "transparent", color: "inherit", border: "none", cursor: "pointer" }}>
          <strong>{a.tenant}</strong><br /><small>{a.description ?? ""}</small>
        </button>
      ))}
    </aside>
  );
}
