import type { TerminalStatus } from "./Terminal.tsx";

const STATUS_LABEL: Record<TerminalStatus, string> = {
  connecting: "connecting",
  open: "live",
  closed: "disconnected",
};

function HamburgerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 4h12M2 8h12M2 12h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"
        stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function TopBar({ selected, status, onMenu, onSettings }: {
  selected: string | null;
  status: TerminalStatus | null;
  onMenu: () => void;
  onSettings: () => void;
}) {
  return (
    <header className="topbar">
      <button className="iconbtn menu-btn" onClick={onMenu} aria-label="Toggle terminals list" title="Terminals">
        <HamburgerIcon />
      </button>
      {selected ? (
        <div className="topbar__title">
          <span className={`dot dot--${status ?? "connecting"}`} aria-hidden="true" />
          <span className="topbar__name">{selected}</span>
          <span className="topbar__status">{STATUS_LABEL[status ?? "connecting"]}</span>
        </div>
      ) : (
        <span className="topbar__muted">no terminal selected</span>
      )}
      <div className="topbar__spacer" />
      <button className="iconbtn" onClick={onSettings} aria-label="Settings" title="Settings">
        <GearIcon />
      </button>
    </header>
  );
}
