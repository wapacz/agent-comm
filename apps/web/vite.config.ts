import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The web app talks to the relay via same-origin relative paths (e.g. GET
// /agents). In dev, Vite proxies everything under /agents to the relay, so the
// browser never has to reach the relay directly — this avoids CORS and the
// WSL<->Windows localhost boundary (the relay runs in WSL; the browser may be
// on Windows). Override the relay target with A2A_RELAY_TARGET if needed.
const relayTarget = process.env.A2A_RELAY_TARGET || "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/agents": {
        target: relayTarget,
        changeOrigin: true,
        // message:stream is Server-Sent Events; do not buffer it.
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            if ((proxyRes.headers["content-type"] || "").includes("text/event-stream")) {
              proxyRes.headers["cache-control"] = "no-cache";
            }
          });
        },
      },
    },
  },
});
