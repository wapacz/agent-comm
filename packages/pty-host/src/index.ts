import { resolvePtyConfig } from "./config.ts";
import { PtyHost } from "./pty-host.ts";

function parseArgs(argv: string[]): { flagName?: string; flagDescription?: string; command?: string; args?: string[] } {
  let flagName: string | undefined;
  let flagDescription: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--name") { flagName = argv[++i]; continue; }
    if (a === "--description") { flagDescription = argv[++i]; continue; }
    if (a === "--") { rest.push(...argv.slice(i + 1)); break; }
    rest.push(a);
  }
  const [command, ...args] = rest;
  return { flagName, flagDescription, command, args };
}

const parsed = parseArgs(process.argv.slice(2));
let config;
try {
  config = resolvePtyConfig({
    envRelayUrl: process.env.A2A_RELAY_URL,
    envToken: process.env.A2A_RELAY_TOKEN,
    flagName: parsed.flagName,
    flagDescription: parsed.flagDescription,
    command: parsed.command,
    args: parsed.args,
    cwd: process.cwd(),
  });
} catch (e) {
  console.error(`pty-host: ${(e as Error).message}`);
  process.exit(1);
}

const host = new PtyHost({
  wsUrl: config.wsUrl,
  token: config.token,
  name: config.name,
  command: config.command,
  args: config.args,
  cwd: config.cwd,
  env: process.env as Record<string, string>,
  description: config.description,
});

host.start()
  .then(() => console.log(`pty-host: '${config.command}' attached as terminal tenant '${host.tenant}'`))
  .catch((e) => { console.error(`pty-host: connect failed — ${(e as Error).message}`); process.exit(1); });

process.on("SIGINT", () => { host.close(); process.exit(0); });
process.on("SIGTERM", () => { host.close(); process.exit(0); });
