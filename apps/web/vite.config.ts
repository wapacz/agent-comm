import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The web app talks to the relay via same-origin relative paths (e.g. GET
// /agents, GET /terminals). In dev, Vite proxies those relay paths to the
// relay, so the browser never has to reach the relay directly — this avoids
// CORS and the WSL<->Windows localhost boundary (the relay runs in WSL; the
// browser may be on Windows). Override the relay target with A2A_RELAY_TARGET.
const relayTarget = process.env.A2A_RELAY_TARGET || "http://127.0.0.1:8787";

// message:stream is Server-Sent Events; do not buffer it.
const sseAware = (proxy: { on: (e: string, cb: (res: { headers: Record<string, string | undefined> }) => void) => void }) => {
  proxy.on("proxyRes", (proxyRes) => {
    if ((proxyRes.headers["content-type"] || "").includes("text/event-stream")) {
      proxyRes.headers["cache-control"] = "no-cache";
    }
  });
};

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/agents": { target: relayTarget, changeOrigin: true, ws: true, configure: sseAware },
      "/terminals": { target: relayTarget, changeOrigin: true },
    },
  },
});
