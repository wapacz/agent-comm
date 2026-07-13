import { startRelay } from "./server.ts";

const port = Number(process.env.A2A_RELAY_PORT ?? "8787");
const token = process.env.A2A_RELAY_TOKEN;
if (!token) { console.error("A2A_RELAY_TOKEN is required"); process.exit(1); }

startRelay({ port, token }).then(({ port }) => {
  console.log(`pi-comm relay listening on http://127.0.0.1:${port} (agents: ws://.../agent)`);
});
