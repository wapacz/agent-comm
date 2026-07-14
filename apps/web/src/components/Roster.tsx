import { useEffect, useState } from "react";
import type { A2AClient } from "../a2a-client.ts";

export function Roster({ client, selected, onSelect }: {
  client: A2AClient;
  selected: string | null;
  onSelect: (t: string) => void;
}) {
  const [terminals, setTerminals] = useState<Array<{ tenant: string; description?: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const a = await client.listTerminals(); if (live) { setTerminals(a); setError(null); } }
      catch (e) { if (live) setError((e as Error).message); }
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { live = false; clearInterval(id); };
  }, [client]);

  return (
    <>
      <div className="drawer__head">Terminals</div>
      {error && <div className="drawer__error">{error}</div>}
      {terminals.length === 0 && !error && (
        <div className="drawer__error" style={{ color: "var(--gray-text)" }}>No terminals connected</div>
      )}
      {terminals.map((a) => (
        <button
          key={a.tenant}
          className={`term-row${a.tenant === selected ? " term-row--active" : ""}`}
          onClick={() => onSelect(a.tenant)}
        >
          <div className="term-row__name">{a.tenant}</div>
          {a.description ? <div className="term-row__desc">{a.description}</div> : null}
        </button>
      ))}
    </>
  );
}
