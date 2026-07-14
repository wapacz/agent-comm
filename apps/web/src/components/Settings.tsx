import { useEffect, useState } from "react";

export function Settings({ baseUrl, token, onSave, onClose }: {
  baseUrl: string;
  token: string;
  onSave: (baseUrl: string, token: string) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(baseUrl);
  const [tok, setTok] = useState(token);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function save() { onSave(url.trim(), tok); onClose(); }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Settings" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <span className="modal__title">Settings</span>
          <button className="iconbtn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <label className="field">
          <span className="field__label">Relay URL</span>
          <input className="field__input" value={url} onChange={(e) => setUrl(e.target.value)}
            placeholder="blank = use dev proxy" autoFocus />
        </label>
        <label className="field">
          <span className="field__label">Token</span>
          <input className="field__input" type="password" value={tok} onChange={(e) => setTok(e.target.value)}
            placeholder="relay bearer token" onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
        </label>
        <div className="modal__actions">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
