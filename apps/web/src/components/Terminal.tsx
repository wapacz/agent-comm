import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { CanvasAddon } from "@xterm/addon-canvas";
import "@xterm/xterm/css/xterm.css";
import { TerminalClient } from "../terminal-client.ts";

/**
 * Attach a canvas-based renderer instead of xterm's default DOM renderer.
 *
 * The DOM renderer paints each row as absolutely-positioned DOM elements. On
 * iOS/iPadOS WebKit (which every browser there is forced to use, incl. Chrome),
 * high-frequency partial redraws — pi's spinner + full-width status bars — leave
 * stale composited tiles behind (ghost rectangles / uncleared bands). Rendering
 * to a single <canvas> sidesteps that.
 *
 * We use the 2D Canvas addon rather than WebGL: iOS WebKit caps the number of
 * simultaneously live WebGL contexts and reclaims them lazily. Because the
 * terminal is fully remounted on every session switch, WebGL contexts pile up
 * and the cap is hit quickly — the newest terminal then fails to get a context
 * and renders all-black while the others still work. A 2D canvas context has
 * no such practical limit, so Canvas is the safe default here; if even that
 * fails to load, xterm's DOM renderer remains as a last-resort fallback.
 */
function attachRenderer(term: XTerm): { dispose: () => void } {
  try {
    const canvas = new CanvasAddon();
    term.loadAddon(canvas);
    return canvas;
  } catch {
    return { dispose: () => {} };
  }
}

export type TerminalStatus = "connecting" | "open" | "closed";

export function Terminal({ baseUrl, token, tenant, onStatus }: {
  baseUrl: string;
  token: string;
  tenant: string;
  onStatus?: (status: TerminalStatus) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const term = new XTerm({ convertEol: false, fontSize: 13, theme: { background: "#0d0f12" } });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const renderer = attachRenderer(term);
    fit.fit();

    const client = new TerminalClient({ wsBaseUrl: baseUrl, token, tenant });
    client.connect({
      onData: (bytes) => term.write(bytes),
      onClose: () => term.write("\r\n\x1b[31m[terminal disconnected]\x1b[0m\r\n"),
      onStatus,
    });
    client.sendResize(term.cols, term.rows);
    const disposable = term.onData((d) => client.sendInput(d));

    const onResize = () => { fit.fit(); client.sendResize(term.cols, term.rows); };
    const ro = new ResizeObserver(onResize);
    ro.observe(el);

    return () => { ro.disconnect(); disposable.dispose(); client.close(); renderer.dispose(); term.dispose(); };
  }, [baseUrl, token, tenant, onStatus]);

  return <div ref={hostRef} className="terminal-pane" />;
}
