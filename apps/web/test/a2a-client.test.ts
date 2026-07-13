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

  it("parses SSE deltas and stops at [DONE]", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('data: {"message":{"parts":[{"text":"Hel"}]}}\n\n'));
        controller.enqueue(enc.encode('data: {"message":{"parts":[{"text":"lo"}]}}\n\n'));
        controller.enqueue(enc.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body }));
    const c = new A2AClient({ baseUrl: "http://r", token: "t" });
    const deltas: string[] = [];
    await c.stream("a", "hi", (t) => deltas.push(t));
    expect(deltas).toEqual(["Hel", "lo"]);
  });

  it("stream() throws on HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const c = new A2AClient({ baseUrl: "http://r", token: "t" });
    await expect(c.stream("a", "hi", () => {})).rejects.toThrow("stream HTTP 503");
  });
});
