import { startRelay } from "./server.ts";

const port = Number(process.env.RELAY_PORT ?? process.env.A2A_RELAY_PORT ?? "8787");
const token = process.env.RELAY_TOKEN ?? process.env.A2A_RELAY_TOKEN;
if (!token) { console.error("RELAY_TOKEN is required"); process.exit(1); }
const webDir = process.env.RELAY_WEB_DIR;

startRelay({ port, token, webDir }).then(({ port }) => {
  const web = webDir ? ` (serving web from ${webDir})` : "";
  console.log(
    `pi-comm relay listening on http://127.0.0.1:${port}${web} ` +
    `(agents: ws://.../agent, pty: ws://.../pty, terminal: ws://.../agents/{tenant}/terminal)`,
  );
});
