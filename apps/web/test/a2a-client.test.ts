import { describe, it, expect, vi, afterEach } from "vitest";
import { A2AClient } from "../src/a2a-client.ts";

afterEach(() => vi.restoreAllMocks());

describe("A2AClient", () => {
  it("lists agents with the bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ agents: [{ tenant: "a", card: {} }] }) });
    vi.stubGlobal("fetch", fetchMock);
    const c = new A2AClient({ baseUrl: "http://r", token: "t" });
    const agents = await c.listAgents();
    expect(agents[0].tenant).toBe("a");
    expect(fetchMock).toHaveBeenCalledWith("http://r/agents", expect.objectContaining({ headers: { authorization: "Bearer t" } }));
  });

  it("returns reply text from send", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { parts: [{ text: "hi " }, { text: "there" }] } }) }));
    const c = new A2AClient({ baseUrl: "http://r", token: "t" });
    expect(await c.send("a", "q")).toBe("hi there");
  });
});
