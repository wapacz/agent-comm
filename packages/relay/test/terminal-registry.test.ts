import { describe, it, expect } from "vitest";
import { TerminalRegistry, type Viewer } from "../src/terminal-registry.ts";

const launcher = () => ({ sendInput: () => {}, sendResize: () => {} });

describe("TerminalRegistry", () => {
  it("assigns the plain name then dedups with #N", () => {
    const r = new TerminalRegistry();
    expect(r.registerLauncher("alice", launcher())).toBe("alice");
    expect(r.registerLauncher("alice", launcher())).toBe("alice#2");
  });

  it("hasTerminal reflects launcher presence", () => {
    const r = new TerminalRegistry();
    const t = r.registerLauncher("alice", launcher());
    expect(r.hasTerminal(t)).toBe(true);
    r.unregisterLauncher(t);
    expect(r.hasTerminal(t)).toBe(false);
  });

  it("rejects viewers when no launcher, accepts and broadcasts otherwise", () => {
    const r = new TerminalRegistry();
    const seen: string[] = [];
    const v: Viewer = { sendData: (d) => seen.push(d) };
    expect(r.addViewer("ghost", v)).toBe(false);
    r.registerLauncher("alice", launcher());
    expect(r.addViewer("alice", v)).toBe(true);
    r.broadcastData("alice", "Zm9v");
    expect(seen).toEqual(["Zm9v"]);
  });

  it("tracks the primary viewer as the first remaining", () => {
    const r = new TerminalRegistry();
    r.registerLauncher("alice", launcher());
    const v1: Viewer = { sendData: () => {} };
    const v2: Viewer = { sendData: () => {} };
    r.addViewer("alice", v1); r.addViewer("alice", v2);
    expect(r.primaryViewer("alice")).toBe(v1);
    r.removeViewer("alice", v1);
    expect(r.primaryViewer("alice")).toBe(v2);
  });
});
