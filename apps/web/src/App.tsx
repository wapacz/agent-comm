import { useMemo, useState } from "react";
import { A2AClient } from "./a2a-client.ts";
import { Roster } from "./components/Roster.tsx";
import { Terminal } from "./components/Terminal.tsx";

export function App() {
  // Empty base URL = same-origin relative requests, served by the Vite dev
  // proxy (see vite.config.ts). Leave blank in dev; set an absolute URL only to
  // hit a relay directly (e.g. a production/remote relay).
  const [baseUrl, setBaseUrl] = useState(localStorage.getItem("a2a.url") ?? "");
  const [token, setToken] = useState(localStorage.getItem("a2a.token") ?? "");
  const [selected, setSelected] = useState<string | null>(null);
  const client = useMemo(() => new A2AClient({ baseUrl, token }), [baseUrl, token]);

  function save() { localStorage.setItem("a2a.url", baseUrl); localStorage.setItem("a2a.token", token); }

  return (
    <div style={{ fontFamily: "system-ui", height: "100vh", display: "flex", flexDirection: "column", color: "var(--text, #eee)", background: "var(--layer0, #111)" }}>
      <header style={{ display: "flex", gap: 8, padding: 8, borderBottom: "1px solid var(--border, #333)" }}>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="relay url (blank = use dev proxy)" style={{ flex: 1, padding: 6 }} />
        <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="token" type="password" style={{ width: 160, padding: 6 }} />
        <button onClick={save}>Save</button>
      </header>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <Roster client={client} selected={selected} onSelect={(t) => setSelected(t)} />
        {selected ? (
          <Terminal key={`term-${selected}`} baseUrl={baseUrl} token={token} tenant={selected} />
        ) : (
          <section style={{ flex: 1, display: "grid", placeItems: "center", opacity: 0.6 }}>Select a terminal</section>
        )}
      </div>
    </div>
  );
}
