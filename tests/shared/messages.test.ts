import { describe, expect, it } from "vitest";
import { isRuntimeMessage } from "../../src/shared/messages";

describe("isRuntimeMessage", () => {
  it("accepts OpenAI OAuth and LLM proxy runtime messages", () => {
    expect(isRuntimeMessage({ type: "mt:openai-oauth-status" })).toBe(true);
    expect(isRuntimeMessage({ type: "mt:openai-oauth-login" })).toBe(true);
    expect(isRuntimeMessage({ type: "mt:openai-oauth-logout" })).toBe(true);
    expect(isRuntimeMessage({
      type: "mt:llm-chat-completions",
      body: { model: "gpt-5.4-mini", messages: [] },
    })).toBe(true);
  });
});
