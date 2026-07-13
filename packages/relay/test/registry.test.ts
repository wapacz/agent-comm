import { describe, it, expect } from "vitest";
import { AgentRegistry } from "../src/registry.ts";

const card = {
  name: "backend", description: "d", version: "1.0.0",
  capabilities: { streaming: true }, defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"], skills: [{ id: "c", name: "C", description: "d", tags: [] }],
};
const conn = () => ({ card, send: () => {} });

describe("AgentRegistry", () => {
  it("assigns the plain name for the first registration", () => {
    const r = new AgentRegistry();
    expect(r.register("backend", card, conn())).toBe("backend");
  });
  it("dedups colliding names with #N suffix", () => {
    const r = new AgentRegistry();
    r.register("backend", card, conn());
    expect(r.register("backend", card, conn())).toBe("backend#2");
    expect(r.register("backend", card, conn())).toBe("backend#3");
  });
  it("frees the tenant on unregister", () => {
    const r = new AgentRegistry();
    const t = r.register("backend", card, conn());
    r.unregister(t);
    expect(r.get(t)).toBeUndefined();
    expect(r.list()).toHaveLength(0);
  });
});
