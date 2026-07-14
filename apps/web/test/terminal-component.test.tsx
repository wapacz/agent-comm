// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { Terminal } from "../src/components/Terminal.tsx";

const writes: (string | Uint8Array)[] = [];
let dataHandler: ((d: string) => void) | null = null;

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80; rows = 24;
    open() {}
    write(d: string | Uint8Array) { writes.push(d); }
    onData(cb: (d: string) => void) { dataHandler = cb; return { dispose() {} }; }
    dispose() {}
    loadAddon() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

const inputs: string[] = [];
let onDataCb: ((b: Uint8Array) => void) | null = null;
vi.mock("../src/terminal-client.ts", () => ({
  TerminalClient: class {
    connect(h: { onData: (b: Uint8Array) => void }) { onDataCb = h.onData; }
    sendInput(d: string) { inputs.push(d); }
    sendResize() {}
    close() {}
  },
}));

beforeEach(() => {
  writes.length = 0; inputs.length = 0; dataHandler = null; onDataCb = null;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
});

describe("Terminal component", () => {
  it("writes incoming term data to xterm and forwards keystrokes", () => {
    render(<Terminal baseUrl="ws://relay" token="t" tenant="alice" />);
    onDataCb!(new TextEncoder().encode("hello"));
    expect(writes.length).toBeGreaterThan(0);
    dataHandler!("x");
    expect(inputs).toContain("x");
    cleanup();
  });
});
