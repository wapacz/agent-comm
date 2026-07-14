import { useMemo, useState } from "react";
import { A2AClient } from "./a2a-client.ts";
import { Roster } from "./components/Roster.tsx";
import { Chat } from "./components/Chat.tsx";
import { ToolCallPanel } from "./components/ToolCallPanel.tsx";
import { Terminal } from "./components/Terminal.tsx";

export function App() {
  // Empty base URL = same-origin relative requests, served by the Vite dev
  // proxy (see vite.config.ts). Leave blank in dev; set an absolute URL only to
  // hit a relay directly (e.g. a production/remote relay).
  const [baseUrl, setBaseUrl] = useState(localStorage.getItem("a2a.url") ?? "");
  const [token, setToken] = useState(localStorage.getItem("a2a.token") ?? "");
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedHasTerminal, setSelectedHasTerminal] = useState(false);
  const [view, setView] = useState<"chat" | "terminal">("chat");
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
        <Roster client={client} selected={selected} onSelect={(t, hasTerminal) => { setSelected(t); setSelectedHasTerminal(hasTerminal); setView("chat"); }} />
        {selected ? (
          <section style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ display: "flex", gap: 8, padding: 8, borderBottom: "1px solid var(--border, #333)" }}>
              <button onClick={() => setView("chat")} disabled={view === "chat"}>Chat</button>
              <button onClick={() => setView("terminal")} disabled={view === "terminal" || !selectedHasTerminal} title={selectedHasTerminal ? undefined : "No terminal available for this agent"}>Terminal</button>
            </div>
            {view === "chat"
              ? <Chat key={`chat-${selected}`} client={client} tenant={selected} />
              : selectedHasTerminal
                ? <Terminal key={`term-${selected}`} baseUrl={baseUrl} token={token} tenant={selected} />
                : <Chat key={`chat-${selected}`} client={client} tenant={selected} />}
          </section>
        ) : (
          <section style={{ flex: 1, display: "grid", placeItems: "center", opacity: 0.6 }}>Select an agent</section>
        )}
        <ToolCallPanel />
      </div>
    </div>
  );
}
