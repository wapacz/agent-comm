import { describe, it, expect } from "vitest";
import { resolvePtyConfig } from "../src/config.ts";

const base = { cwd: "/home/u/alice", envToken: "tok" };

describe("resolvePtyConfig", () => {
  it("defaults relay url and derives the /pty ws url", () => {
    const c = resolvePtyConfig(base);
    expect(c.wsUrl).toBe("ws://127.0.0.1:8787/pty");
  });
  it("derives wss for https relays", () => {
    expect(resolvePtyConfig({ ...base, envRelayUrl: "https://relay.example.com" }).wsUrl).toBe("wss://relay.example.com/pty");
  });
  it("uses cwd basename as default name and pi as default command", () => {
    const c = resolvePtyConfig(base);
    expect(c.name).toBe("alice");
    expect(c.command).toBe("pi");
    expect(c.args).toEqual([]);
  });
  it("prefers flag name and passes through command/args", () => {
    const c = resolvePtyConfig({ ...base, flagName: "api", command: "pi", args: ["-e", "x.ts"] });
    expect(c.name).toBe("api");
    expect(c.args).toEqual(["-e", "x.ts"]);
  });
  it("throws when the token is missing", () => {
    expect(() => resolvePtyConfig({ ...base, envToken: undefined })).toThrow(/A2A_RELAY_TOKEN/);
  });
  it("defaults description to the command and honors the flag", () => {
    expect(resolvePtyConfig(base).description).toBe("pi");
    expect(resolvePtyConfig({ ...base, command: "bash" }).description).toBe("bash");
    expect(resolvePtyConfig({ ...base, flagDescription: "my session" }).description).toBe("my session");
  });
});
