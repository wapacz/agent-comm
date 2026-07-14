import { useMemo, useState } from "react";
import { A2AClient } from "./a2a-client.ts";
import { Roster } from "./components/Roster.tsx";
import { Terminal, type TerminalStatus } from "./components/Terminal.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { Settings } from "./components/Settings.tsx";

export function App() {
  // Empty base URL = same-origin relative requests via the Vite dev proxy.
  // Set an absolute relay URL (Settings) only to hit a relay directly.
  const [baseUrl, setBaseUrl] = useState(localStorage.getItem("a2a.url") ?? "");
  const [token, setToken] = useState(localStorage.getItem("a2a.token") ?? "");
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<TerminalStatus | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const client = useMemo(() => new A2AClient({ baseUrl, token }), [baseUrl, token]);

  function selectTerminal(tenant: string) {
    setSelected(tenant);
    setStatus("connecting");
    setDrawerOpen(false);
  }

  function saveSettings(url: string, tok: string) {
    setBaseUrl(url); setToken(tok);
    localStorage.setItem("a2a.url", url);
    localStorage.setItem("a2a.token", tok);
  }

  return (
    <div className="app">
      <TopBar
        selected={selected}
        status={status}
        onMenu={() => setDrawerOpen((v) => !v)}
        onSettings={() => setSettingsOpen(true)}
      />
      <div className="body">
        <aside className={`drawer${drawerOpen ? " drawer--open" : ""}`}>
          <Roster client={client} selected={selected} onSelect={selectTerminal} />
        </aside>
        {drawerOpen && <div className="backdrop" onClick={() => setDrawerOpen(false)} />}
        {selected ? (
          <Terminal key={`term-${selected}`} baseUrl={baseUrl} token={token} tenant={selected} onStatus={setStatus} />
        ) : (
          <section className="empty">Select a terminal</section>
        )}
      </div>
      {settingsOpen && (
        <Settings baseUrl={baseUrl} token={token} onSave={saveSettings} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  );
}
