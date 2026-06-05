import { describe, expect, it } from "vitest";
import { isRuntimeMessage } from "../../src/shared/messages";

describe("isRuntimeMessage", () => {
  it("accepts image and screenshot translation runtime messages", () => {
    expect(isRuntimeMessage({ type: "mt:download-image", imageUrl: "https://example.com/a.png" })).toBe(true);
    expect(isRuntimeMessage({ type: "mt:capture-visible-tab" })).toBe(true);
    expect(isRuntimeMessage({ type: "mt:context-menu-translate" })).toBe(true);
    expect(isRuntimeMessage({ type: "mt:start-screenshot-translate" })).toBe(true);
    expect(isRuntimeMessage({ type: "mt:shortcut-translate-hover" })).toBe(true);
  });

  it("accepts OpenAI OAuth and LLM proxy runtime messages", () => {
    expect(isRuntimeMessage({ type: "mt:openai-oauth-status" })).toBe(true);
    expect(isRuntimeMessage({ type: "mt:openai-oauth-login" })).toBe(true);
    expect(isRuntimeMessage({ type: "mt:openai-oauth-logout" })).toBe(true);
    expect(isRuntimeMessage({
      type: "mt:llm-chat-completions",
      body: { model: "gpt-5.4-mini", messages: [] },
    })).toBe(true);
  });

  it("accepts Gemini App image translation messages", () => {
    expect(isRuntimeMessage({ type: "mt:gemini-app-auth-status" })).toBe(true);
    expect(isRuntimeMessage({ type: "mt:gemini-app-auth-login" })).toBe(true);
    expect(isRuntimeMessage({
      type: "mt:gemini-app-image-translate",
      image: {
        base64: "abc",
        contentType: "image/png",
        filename: "source.png",
      },
    })).toBe(true);
  });

  it("rejects malformed LLM proxy messages", () => {
    expect(isRuntimeMessage({ type: "mt:llm-chat-completions" })).toBe(false);
    expect(isRuntimeMessage({ type: "mt:llm-chat-completions", body: { model: "gpt-5.4-mini" } })).toBe(false);
  });

  it("rejects malformed Gemini App image translation messages", () => {
    expect(isRuntimeMessage({ type: "mt:gemini-app-image-translate" })).toBe(false);
    expect(isRuntimeMessage({
      type: "mt:gemini-app-image-translate",
      image: { base64: "abc", contentType: "image/png" },
    })).toBe(false);
  });
});
