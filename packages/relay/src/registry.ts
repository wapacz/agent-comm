import type { AgentCard } from "@pi-comm/a2a-contract";
import type { TunnelFrame } from "@pi-comm/a2a-contract";

export interface AgentConn { card: AgentCard; send(frame: TunnelFrame): void; }

export class AgentRegistry {
  private byTenant = new Map<string, AgentConn>();

  register(name: string, card: AgentCard, conn: AgentConn): string {
    let tenant = name;
    let n = 2;
    while (this.byTenant.has(tenant)) tenant = `${name}#${n++}`;
    this.byTenant.set(tenant, { ...conn, card });
    return tenant;
  }
  unregister(tenant: string): void { this.byTenant.delete(tenant); }
  get(tenant: string): AgentConn | undefined { return this.byTenant.get(tenant); }
  list(): Array<{ tenant: string; card: AgentCard }> {
    return [...this.byTenant.entries()].map(([tenant, c]) => ({ tenant, card: c.card }));
  }
}
