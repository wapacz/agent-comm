import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TerminalClient } from "../terminal-client.ts";

export function Terminal({ baseUrl, token, tenant }: { baseUrl: string; token: string; tenant: string }) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const term = new XTerm({ convertEol: false, fontSize: 13, theme: { background: "#111111" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const client = new TerminalClient({ wsBaseUrl: baseUrl, token, tenant });
    client.connect({
      onData: (bytes) => term.write(bytes),
      onClose: () => term.write("\r\n\x1b[31m[terminal disconnected]\x1b[0m\r\n"),
    });
    client.sendResize(term.cols, term.rows);
    const disposable = term.onData((d) => client.sendInput(d));

    const onResize = () => { fit.fit(); client.sendResize(term.cols, term.rows); };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    return () => { ro.disconnect(); disposable.dispose(); client.close(); term.dispose(); };
  }, [baseUrl, token, tenant]);

  return <div ref={hostRef} style={{ flex: 1, minHeight: 0, background: "#111" }} />;
}
