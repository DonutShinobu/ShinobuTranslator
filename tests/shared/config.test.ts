import { describe, expect, it } from "vitest";
import {
  normalizeSettings,
  resolveLlmBaseUrl,
  supportsLlmTemperatureControl,
  toPipelineConfig,
  validateSettings,
} from "../../src/shared/config";

describe("OpenAI provider settings", () => {
  it("normalizes the OpenAI provider with OAuth as the default auth mode", () => {
    const settings = normalizeSettings({
      translator: "llm",
      llmProvider: "openai",
    });

    expect(settings.llmProvider).toBe("openai");
    expect(settings.llmProfiles.openai.authMode).toBe("openai_oauth");
    expect(resolveLlmBaseUrl(settings)).toBe("https://api.openai.com/v1");
  });

  it("does not require an API key when OpenAI OAuth is selected", () => {
    const settings = normalizeSettings({
      translator: "llm",
      llmProvider: "openai",
      llmProfiles: {
        openai: {
          apiKey: "",
          authMode: "openai_oauth",
          modelPreset: "gpt-5.4-mini",
          modelCustom: "",
          useCustomModel: false,
          customBaseUrl: "",
          temperature: 0.4,
        },
      },
    });

    expect(validateSettings(settings)).toBeNull();
    expect(toPipelineConfig(settings)).toMatchObject({
      llmProvider: "openai",
      llmAuthMode: "openai_oauth",
      llmApiKey: "",
      llmBaseUrl: "https://api.openai.com/v1",
      llmModel: "gpt-5.4-mini",
    });
  });

  it("hides temperature controls for OpenAI OAuth because the Codex endpoint ignores them", () => {
    const oauthSettings = normalizeSettings({
      translator: "llm",
      llmProvider: "openai",
      llmProfiles: {
        openai: {
          authMode: "openai_oauth",
        },
      },
    });
    const apiKeySettings = normalizeSettings({
      translator: "llm",
      llmProvider: "openai",
      llmProfiles: {
        openai: {
          authMode: "api_key",
          apiKey: "sk-test",
        },
      },
    });

    expect(supportsLlmTemperatureControl(oauthSettings)).toBe(false);
    expect(supportsLlmTemperatureControl(apiKeySettings)).toBe(true);
  });
});
