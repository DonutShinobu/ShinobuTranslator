import { describe, expect, it } from "vitest";
import {
  getRuntimeErrorCode,
  getRuntimeTransportMetadata,
  isRuntimeMessage,
} from "../../src/shared/messages";

describe("isRuntimeMessage", () => {
  it("accepts image and screenshot translation runtime messages", () => {
    expect(isRuntimeMessage({ type: "mt:download-image", imageUrl: "https://example.com/a.png" })).toBe(true);
    expect(isRuntimeMessage({
      type: "mt:download-image",
      imageUrl: "https://example.com/a.png",
      referrerPolicy: "strict-origin-when-cross-origin",
    })).toBe(true);
    expect(isRuntimeMessage({ type: "mt:capture-visible-tab" })).toBe(true);
    expect(isRuntimeMessage({ type: "mt:context-menu-translate" })).toBe(true);
    expect(isRuntimeMessage({ type: "mt:start-screenshot-translate" })).toBe(true);
    expect(isRuntimeMessage({ type: "mt:shortcut-translate-hover" })).toBe(true);
  });

  it("rejects malformed image download messages", () => {
    expect(isRuntimeMessage({ type: "mt:download-image" })).toBe(false);
    expect(isRuntimeMessage({ type: "mt:download-image", imageUrl: 42 })).toBe(false);
    expect(isRuntimeMessage({
      type: "mt:download-image",
      imageUrl: "data:image/png;base64,aW1hZ2U=",
    })).toBe(false);
    expect(isRuntimeMessage({
      type: "mt:download-image",
      imageUrl: "https://example.com/a.png",
      referrerPolicy: "send-everything",
    })).toBe(false);
  });

  it("accepts OpenAI OAuth and LLM proxy runtime messages", () => {
    expect(isRuntimeMessage({ type: "mt:openai-oauth-status" })).toBe(true);
    expect(isRuntimeMessage({ type: "mt:openai-oauth-login" })).toBe(true);
    expect(isRuntimeMessage({ type: "mt:openai-oauth-logout" })).toBe(true);
    expect(isRuntimeMessage({
      type: "mt:llm-chat-completions",
      body: { model: "gpt-5.4-mini", messages: [] },
      proxyConfig: {
        provider: "openai",
        authMode: "api_key",
        baseUrl: "https://api.openai.com/v1",
        useCustomModel: false,
        thinkingLevel: "xhigh",
      },
      diagnosticRunId: "run-1",
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
      diagnosticRunId: "run-1",
    })).toBe(true);
    expect(isRuntimeMessage({
      type: "mt:gemini-api-image-translate",
      image: {
        base64: "abc",
        contentType: "image/png",
        filename: "source.png",
      },
      diagnosticRunId: "run-1",
    })).toBe(true);
  });

  it("accepts diagnostic log messages", () => {
    expect(isRuntimeMessage({ type: "mt:diagnostic-log-export" })).toBe(true);
    expect(isRuntimeMessage({ type: "mt:diagnostic-log-clear" })).toBe(true);
    expect(isRuntimeMessage({
      type: "mt:diagnostic-log-event",
      event: {
        id: "event-1",
        sessionId: "session-1",
        timestamp: "2026-06-27T09:28:22.875Z",
        level: "info",
        category: "llm.api",
        source: { context: "content", module: "translators/llm.ts" },
        message: "DeepSeek 请求开始",
      },
    })).toBe(true);
  });

  it("rejects malformed LLM proxy messages", () => {
    expect(isRuntimeMessage({ type: "mt:llm-chat-completions" })).toBe(false);
    expect(isRuntimeMessage({ type: "mt:llm-chat-completions", body: { model: "gpt-5.4-mini" } })).toBe(false);
    expect(isRuntimeMessage({
      type: "mt:llm-chat-completions",
      body: { model: "gpt-5.4-mini", messages: [] },
      diagnosticRunId: 1,
    })).toBe(false);
    expect(isRuntimeMessage({
      type: "mt:llm-chat-completions",
      body: { model: "gpt-5.4-mini", messages: [] },
      proxyConfig: {
        provider: "invalid",
        authMode: "api_key",
        baseUrl: "https://api.openai.com/v1",
      },
    })).toBe(false);
    expect(isRuntimeMessage({
      type: "mt:llm-chat-completions",
      body: { model: "gpt-5.4-mini", messages: [] },
      proxyConfig: {
        provider: "openai",
        authMode: "invalid",
        baseUrl: "https://api.openai.com/v1",
      },
    })).toBe(false);
    expect(isRuntimeMessage({
      type: "mt:llm-chat-completions",
      body: { model: "gpt-5.4-mini", messages: [] },
      proxyConfig: {
        provider: "openai",
        authMode: "api_key",
        baseUrl: "https://api.openai.com/v1",
        useCustomModel: "yes",
      },
    })).toBe(false);
    expect(isRuntimeMessage({
      type: "mt:llm-chat-completions",
      body: { model: "gpt-5.4-mini", messages: [] },
      proxyConfig: {
        provider: "openai",
        authMode: "api_key",
        baseUrl: "https://api.openai.com/v1",
        thinkingLevel: "ultra",
      },
    })).toBe(false);
  });

  it("rejects malformed Gemini App image translation messages", () => {
    expect(isRuntimeMessage({ type: "mt:gemini-app-image-translate" })).toBe(false);
    expect(isRuntimeMessage({
      type: "mt:gemini-app-image-translate",
      image: { base64: "abc", contentType: "image/png" },
    })).toBe(false);
    expect(isRuntimeMessage({
      type: "mt:gemini-app-image-translate",
      image: { base64: "abc", contentType: "image/png", filename: "source.png" },
      diagnosticRunId: 1,
    })).toBe(false);
    expect(isRuntimeMessage({
      type: "mt:gemini-api-image-translate",
      image: { base64: "abc", filename: "source.png" },
    })).toBe(false);
  });

  it("rejects malformed diagnostic log events", () => {
    expect(isRuntimeMessage({
      type: "mt:diagnostic-log-event",
      event: {
        id: "event-1",
        sessionId: "session-1",
      },
    })).toBe(false);
  });
});

describe("getRuntimeErrorCode", () => {
  it("preserves the thinking-configuration error code across the runtime seam", () => {
    expect(getRuntimeErrorCode({ errorCode: "llm_thinking_config" })).toBe("llm_thinking_config");
    expect(getRuntimeErrorCode(new Error("ordinary failure"))).toBeUndefined();
  });
});

describe("getRuntimeTransportMetadata", () => {
  it("keeps only finite retry metadata and omits absent fields", () => {
    expect(getRuntimeTransportMetadata({ status: 503 })).toEqual({ status: 503 });
    expect(getRuntimeTransportMetadata({ retryAfterMs: 750 })).toEqual({ retryAfterMs: 750 });
    expect(getRuntimeTransportMetadata(new TypeError("Failed to fetch"))).toEqual({
      retryable: true,
    });
    expect(getRuntimeTransportMetadata({ retryable: true })).toEqual({
      retryable: true,
    });
    expect(getRuntimeTransportMetadata({
      status: Number.NaN,
      retryAfterMs: -1,
    })).toEqual({});
  });
});
