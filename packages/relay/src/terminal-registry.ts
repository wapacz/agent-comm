export interface LauncherConn {
  sendInput(dataB64: string): void;
  sendResize(cols: number, rows: number): void;
}

export interface Viewer {
  sendData(dataB64: string): void;
  lastResize?: { cols: number; rows: number };
  close?(): void;
}

interface LauncherEntry { conn: LauncherConn; description?: string; }

export class TerminalRegistry {
  private launchers = new Map<string, LauncherEntry>();
  private viewers = new Map<string, Viewer[]>();

  registerLauncher(name: string, conn: LauncherConn, meta?: { description?: string }): string {
    let tenant = name;
    let n = 2;
    while (this.launchers.has(tenant)) tenant = `${name}#${n++}`;
    this.launchers.set(tenant, { conn, description: meta?.description });
    return tenant;
  }
  unregisterLauncher(tenant: string): Viewer[] {
    this.launchers.delete(tenant);
    const gone = this.viewers.get(tenant) ?? [];
    this.viewers.delete(tenant);
    return gone;
  }
  getLauncher(tenant: string): LauncherConn | undefined { return this.launchers.get(tenant)?.conn; }
  hasTerminal(tenant: string): boolean { return this.launchers.has(tenant); }
  listTerminals(): Array<{ tenant: string; description?: string }> {
    return [...this.launchers.entries()].map(([tenant, e]) => ({ tenant, description: e.description }));
  }

  addViewer(tenant: string, v: Viewer): boolean {
    if (!this.launchers.has(tenant)) return false;
    const arr = this.viewers.get(tenant) ?? [];
    arr.push(v);
    this.viewers.set(tenant, arr);
    return true;
  }
  removeViewer(tenant: string, v: Viewer): void {
    const arr = this.viewers.get(tenant);
    if (!arr) return;
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1);
    if (arr.length === 0) this.viewers.delete(tenant);
  }
  primaryViewer(tenant: string): Viewer | undefined { return this.viewers.get(tenant)?.[0]; }
  broadcastData(tenant: string, dataB64: string): void {
    for (const v of this.viewers.get(tenant) ?? []) v.sendData(dataB64);
  }
  tenantsWithTerminal(): Set<string> { return new Set(this.launchers.keys()); }
}
