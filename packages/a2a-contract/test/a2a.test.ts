import { describe, it, expect } from "vitest";
import { validateMessage, validateAgentCard, textMessage } from "../src/index.ts";

describe("a2a contract", () => {
  it("accepts a valid text message", () => {
    const m = textMessage("ROLE_USER", "hello", { messageId: "m1" });
    expect(validateMessage(m)).toEqual(m);
    expect(m.parts[0]).toEqual({ text: "hello" });
  });

  it("rejects a message with no parts", () => {
    expect(() => validateMessage({ messageId: "m1", role: "ROLE_USER", parts: [] }))
      .toThrow();
  });

  it("rejects a part with both text and url", () => {
    expect(() => validateMessage({ messageId: "m1", role: "ROLE_USER", parts: [{ text: "x", url: "y" }] }))
      .toThrow();
  });

  it("accepts a minimal agent card", () => {
    const card = {
      name: "backend", description: "backend agent", version: "1.0.0",
      capabilities: { streaming: true },
      defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"],
      skills: [{ id: "chat", name: "Chat", description: "general chat", tags: ["chat"] }],
    };
    expect(validateAgentCard(card)).toEqual(card);
  });
});
