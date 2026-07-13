import { describe, it, expect } from "vitest";
import { resolveConfig } from "../src/config.ts";

const base = { cwd: "/home/u/backend", model: "claude", envToken: "tok" };

describe("resolveConfig", () => {
  it("defaults the relay url and derives ws url", () => {
    const c = resolveConfig(base);
    expect(c.relayHttpUrl).toBe("http://127.0.0.1:8787");
    expect(c.relayWsUrl).toBe("ws://127.0.0.1:8787/agent");
  });
  it("derives wss for https relays", () => {
    const c = resolveConfig({ ...base, flagRelayUrl: "https://relay.example.com" });
    expect(c.relayWsUrl).toBe("wss://relay.example.com/agent");
  });
  it("uses cwd basename as default name", () => {
    expect(resolveConfig(base).name).toBe("backend");
  });
  it("prefers flag name over frontmatter over basename", () => {
    expect(resolveConfig({ ...base, flagName: "api", frontmatter: { name: "fm" } }).name).toBe("api");
    expect(resolveConfig({ ...base, frontmatter: { name: "fm" } }).name).toBe("fm");
  });
  it("throws when token is missing", () => {
    expect(() => resolveConfig({ ...base, envToken: undefined })).toThrow(/A2A_RELAY_TOKEN/);
  });
  it("builds a valid card from name + description", () => {
    const c = resolveConfig({ ...base, frontmatter: { description: "does X" } });
    expect(c.card.name).toBe("backend");
    expect(c.card.description).toBe("does X");
    expect(c.card.capabilities.streaming).toBe(true);
  });
});
