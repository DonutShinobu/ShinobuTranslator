import { describe, expect, it } from "vitest";
import {
  defaultGeminiAppPromptTemplate,
  geminiAppModelOptions,
  getGeminiAppModelLabel,
  llmBuiltInProviderDefinitions,
  llmProviderOptions,
  normalizeSettings,
  optimizedGeminiAppPromptTemplate,
  requiresLlmApiKey,
  resolveGeminiApiImageModel,
  resolveLlmBaseUrl,
  toPipelineConfig,
  usesGeminiApiImagePipeline,
  usesGeminiAppImagePipeline,
  usesNanoBananaImagePipeline,
  validateSettings,
} from "../../apps/extension/src/shared/config";

describe("built-in LLM catalog", () => {
  it("matches the confirmed provider model matrix and new-profile defaults", () => {
    expect(llmBuiltInProviderDefinitions).toMatchObject({
      deepseek: {
        label: "DeepSeek",
        baseUrl: "https://api.deepseek.com",
        models: ["deepseek-v4-flash", "deepseek-v4-pro"],
      },
      gemini: {
        label: "Nano Banana",
        baseUrl: "https://generativelanguage.googleapis.com/v1",
        models: ["gemini-3.1-flash-image", "gemini-3-pro-image"],
      },
      glm: {
        label: "GLM (智谱)",
        baseUrl: "https://api.z.ai/api/paas/v4",
        models: [
          "glm-5.2",
          "glm-5.1",
          "glm-5-turbo",
          "glm-5",
          "glm-4.7",
          "glm-4.7-flash",
          "glm-4.7-flashx",
        ],
      },
      kimi: {
        label: "Kimi (月之暗面)",
        baseUrl: "https://api.moonshot.ai/v1",
        models: ["kimi-k3", "kimi-k2.6"],
      },
      minimax: {
        label: "MiniMax",
        baseUrl: "https://api.minimax.io/v1",
        models: [
          "MiniMax-M3",
          "MiniMax-M2.7",
          "MiniMax-M2.7-highspeed",
          "MiniMax-M2.5",
          "MiniMax-M2.5-highspeed",
        ],
      },
      mimo: {
        label: "MiMo (小米)",
        baseUrl: "https://api.xiaomimimo.com/v1",
        models: ["mimo-v2.5-pro", "mimo-v2.5"],
      },
      openai: {
        label: "OpenAI",
        baseUrl: "https://api.openai.com/v1",
        models: [
          "gpt-5.6-luna",
          "gpt-5.6-terra",
          "gpt-5.6-sol",
          "gpt-5.5-pro",
          "gpt-5.5",
          "gpt-5.4",
          "gpt-5.4-mini",
          "gpt-5.4-nano",
        ],
      },
    });
  });

  it("migrates retired and corrected built-in identifiers without changing the selected model tier", () => {
    const settings = normalizeSettings({
      translator: "llm",
      llmProvider: "kimi",
      llmProfiles: {
        kimi: {
          modelPreset: "kimi-k2.5",
        },
        mimo: {
          modelPreset: "MiMo-V2.5",
        },
      },
    });
    const legacyMiMo = normalizeSettings({
      translator: "llm",
      llmBaseUrl: "https://api.mimo-v2.com/v1",
      llmModelPreset: "MiMo-V2.5-Pro",
    });

    expect({
      kimiModel: settings.llmProfiles.kimi.modelPreset,
      mimoModel: settings.llmProfiles.mimo.modelPreset,
      detectedProvider: legacyMiMo.llmProvider,
      legacyMiMoModel: legacyMiMo.llmProfiles.mimo.modelPreset,
      officialMiMoBaseUrl: resolveLlmBaseUrl(legacyMiMo),
    }).toEqual({
      kimiModel: "kimi-k2.6",
      mimoModel: "mimo-v2.5",
      detectedProvider: "mimo",
      legacyMiMoModel: "mimo-v2.5-pro",
      officialMiMoBaseUrl: "https://api.xiaomimimo.com/v1",
    });
  });

  it("persists thinking levels independently by exact provider and model", () => {
    const flashSettings = normalizeSettings({
      translator: "llm",
      llmProvider: "deepseek",
      llmProfiles: {
        deepseek: {
          apiKey: "sk-test",
          modelPreset: "deepseek-v4-flash",
        },
      },
      llmThinkingByModel: {
        "deepseek/deepseek-v4-flash": "high",
        "deepseek/deepseek-v4-pro": "max",
      },
    });
    const proSettings = normalizeSettings({
      ...flashSettings,
      llmProfiles: {
        ...flashSettings.llmProfiles,
        deepseek: {
          ...flashSettings.llmProfiles.deepseek,
          modelPreset: "deepseek-v4-pro",
        },
      },
    });

    expect(toPipelineConfig(flashSettings).llmThinkingLevel).toBe("high");
    expect(toPipelineConfig(proSettings).llmThinkingLevel).toBe("max");
    expect(proSettings.llmThinkingByModel).toMatchObject({
      "deepseek/deepseek-v4-flash": "high",
      "deepseek/deepseek-v4-pro": "max",
    });
  });
});

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
        },
      },
    });

    expect(validateSettings(settings)).toBeNull();
    expect(toPipelineConfig(settings)).toMatchObject({
      llmProvider: "openai",
      llmAuthMode: "openai_oauth",
      llmBaseUrl: "https://api.openai.com/v1",
      llmModel: "gpt-5.4-mini",
      llmUseCustomModel: false,
    });
    expect(toPipelineConfig(settings)).not.toHaveProperty('llmApiKey');
  });

  it("marks custom models in pipeline config", () => {
    const settings = normalizeSettings({
      translator: "llm",
      llmProvider: "deepseek",
      llmProfiles: {
        deepseek: {
          authMode: "api_key",
          apiKey: "sk-test",
          modelCustom: "deepseek-custom",
          useCustomModel: true,
        },
      },
    });

    expect(toPipelineConfig(settings)).toMatchObject({
      llmProvider: "deepseek",
      llmModel: "deepseek-custom",
      llmUseCustomModel: true,
    });
  });

  it("drops legacy temperature values from normalized settings and pipeline config", () => {
    const settings = normalizeSettings({
      translator: "llm",
      llmProvider: "openai",
      llmProfiles: {
        openai: {
          authMode: "api_key",
          apiKey: "sk-test",
          temperature: 0.4,
        },
      },
    });

    expect(settings.llmProfiles.openai).not.toHaveProperty("temperature");
    expect(toPipelineConfig(settings)).not.toHaveProperty("llmTemperature");
  });

  it("keeps the popup debug section expanded preference out of pipeline config", () => {
    const settings = normalizeSettings({
      debugOptionsExpanded: true,
    });

    expect(settings.debugOptionsExpanded).toBe(true);
    expect(toPipelineConfig(settings)).not.toHaveProperty("debugOptionsExpanded");
  });

  it("maps the debug post-filter switch to the pipeline mode", () => {
    const enabled = normalizeSettings({});
    const disabled = normalizeSettings({ disableOcrPostFilter: true });

    expect(enabled.disableOcrPostFilter).toBe(false);
    expect(toPipelineConfig(enabled).ocrPostFilter).toBe("balanced");
    expect(disabled.disableOcrPostFilter).toBe(true);
    expect(toPipelineConfig(disabled).ocrPostFilter).toBe("off");
  });

  it("normalizes Gemini as a login-backed LLM provider without requiring an API key", () => {
    const settings = normalizeSettings({
      translator: "llm",
      llmProvider: "gemini",
    });

    expect(settings.llmProvider).toBe("gemini");
    expect(settings.llmProfiles.gemini.authMode).toBe("gemini_app");
    expect(usesNanoBananaImagePipeline(settings)).toBe(true);
    expect(usesGeminiAppImagePipeline(settings)).toBe(true);
    expect(requiresLlmApiKey(settings)).toBe(false);
    expect(validateSettings(settings)).toBeNull();
  });

  it("labels the Gemini-backed provider as Nano Banana", () => {
    expect(llmProviderOptions.find((option) => option.value === "gemini")?.label).toBe("Nano Banana");
  });

  it("keeps Nano Banana Pro as the default Gemini App model", () => {
    const settings = normalizeSettings({
      translator: "llm",
      llmProvider: "gemini",
    });

    expect(settings.geminiAppModel).toBe("nano_banana_pro");
    expect(getGeminiAppModelLabel(settings.geminiAppModel)).toBe("Nano Banana Pro");
  });

  it("supports the Gemini API key auth mode under the same Nano Banana provider", () => {
    const settings = normalizeSettings({
      translator: "llm",
      llmProvider: "gemini",
      geminiAppModel: "nano_banana_2",
      llmProfiles: {
        gemini: {
          apiKey: "AIza-test",
          authMode: "api_key",
          modelPreset: "",
          modelCustom: "",
          useCustomModel: false,
          customBaseUrl: "",
        },
      },
    });

    expect(settings.llmProvider).toBe("gemini");
    expect(settings.geminiAppModel).toBe("nano_banana_2");
    expect(settings.llmProfiles.gemini.authMode).toBe("api_key");
    expect(resolveGeminiApiImageModel(settings.geminiAppModel)).toBe("gemini-3.1-flash-image");
    expect(usesNanoBananaImagePipeline(settings)).toBe(true);
    expect(usesGeminiApiImagePipeline(settings)).toBe(true);
    expect(usesGeminiAppImagePipeline(settings)).toBe(false);
    expect(requiresLlmApiKey(settings)).toBe(true);
    expect(resolveLlmBaseUrl(settings)).toBe("https://generativelanguage.googleapis.com/v1");
    expect(validateSettings(settings)).toBeNull();
  });

  it("removes Nano Banana 2 Lite and falls back saved Lite settings to Nano Banana 2", () => {
    const settings = normalizeSettings({
      translator: "llm",
      llmProvider: "gemini",
      geminiAppModel: "gemini-3.1-flash-lite-image",
      llmProfiles: {
        gemini: {
          authMode: "api_key",
          apiKey: "AIza-test",
        },
      },
    });

    expect({
      options: geminiAppModelOptions.map((option) => option.value),
      normalizedModel: settings.geminiAppModel,
      apiModelId: resolveGeminiApiImageModel(settings.geminiAppModel),
    }).toEqual({
      options: ["nano_banana_2", "nano_banana_pro"],
      normalizedModel: "nano_banana_2",
      apiModelId: "gemini-3.1-flash-image",
    });
  });

  it("requires an API key when Nano Banana uses API key auth", () => {
    const settings = normalizeSettings({
      translator: "llm",
      llmProvider: "gemini",
      geminiAppModel: "nano_banana_pro",
      llmProfiles: {
        gemini: {
          apiKey: "",
          authMode: "api_key",
          modelPreset: "",
          modelCustom: "",
          useCustomModel: false,
          customBaseUrl: "",
        },
      },
    });

    expect(usesGeminiApiImagePipeline(settings)).toBe(true);
    expect(resolveGeminiApiImageModel(settings.geminiAppModel)).toBe("gemini-3-pro-image");
    expect(validateSettings(settings)).toBe("Nano Banana API Key 不能为空");
  });

  it("locks local visual debug options off for Nano Banana but keeps diagnostic logging available", () => {
    const settings = normalizeSettings({
      translator: "llm",
      llmProvider: "gemini",
      showElapsedTime: true,
      showStageTimingDetails: true,
      showTypesetDebug: true,
      showEraseDebug: true,
      disableOcrPostFilter: true,
      enableDebugLog: true,
    });

    expect(settings.showElapsedTime).toBe(true);
    expect(settings.showStageTimingDetails).toBe(false);
    expect(settings.showTypesetDebug).toBe(false);
    expect(settings.showEraseDebug).toBe(false);
    expect(settings.disableOcrPostFilter).toBe(false);
    expect(settings.enableDebugLog).toBe(true);
  });

  it("normalizes Nano Banana model aliases", () => {
    expect(normalizeSettings({ geminiAppModel: "nano-banana-2" }).geminiAppModel).toBe("nano_banana_2");
    expect(normalizeSettings({ geminiAppModel: "gemini-3.1-flash-image" }).geminiAppModel).toBe("nano_banana_2");
    expect(normalizeSettings({ geminiAppModel: "gemini-3-pro-image" }).geminiAppModel).toBe("nano_banana_pro");
  });

  it("migrates the legacy Gemini App image engine setting to the Gemini LLM provider", () => {
    const settings = normalizeSettings({
      imageEngine: "gemini_app",
      geminiAppExperimentalEnabled: true,
      geminiAppPromptTemplate: "翻译成{targetLang}",
      geminiAppAuthMode: "browser_session",
    });

    expect(settings.translator).toBe("llm");
    expect(settings.llmProvider).toBe("gemini");
    expect(settings.imageEngine).toBe("local");
    expect(settings.geminiAppAuthMode).toBe("cookies_permission");
    expect(settings.llmProfiles.gemini.authMode).toBe("gemini_app");
    expect(usesGeminiAppImagePipeline(settings)).toBe(true);
    expect(validateSettings(settings)).toBeNull();
  });

  it("keeps legacy saved Nano Banana App profiles on Gemini login auth", () => {
    const settings = normalizeSettings({
      translator: "llm",
      llmProvider: "gemini",
      llmProfiles: {
        gemini: {
          apiKey: "",
          authMode: "api_key",
          modelPreset: "nano-banana-pro",
          modelCustom: "",
          useCustomModel: false,
          customBaseUrl: "",
        },
      },
    });

    expect(settings.llmProfiles.gemini.authMode).toBe("gemini_app");
    expect(usesGeminiAppImagePipeline(settings)).toBe(true);
  });

  it("uses the default Gemini App prompt when the saved template is blank", () => {
    const settings = normalizeSettings({
      geminiAppExperimentalEnabled: true,
      imageEngine: "gemini_app",
      geminiAppPromptTemplate: "   ",
    });

    expect(settings.geminiAppPromptTemplate).toBe(optimizedGeminiAppPromptTemplate);
    expect(validateSettings(settings)).toBeNull();
  });

  it("migrates the previous Gemini App default prompt to the optimized full-image prompt", () => {
    const settings = normalizeSettings({
      geminiAppPromptTemplate: defaultGeminiAppPromptTemplate,
    });

    expect(settings.geminiAppPromptTemplate).toBe(optimizedGeminiAppPromptTemplate);
  });

  it("uses the updated dialogue and sound-effect-only wording in the default Gemini App prompt", () => {
    const settings = normalizeSettings({
      geminiAppPromptTemplate: "   ",
    });

    expect(settings.geminiAppPromptTemplate).toMatch(/^任务：使用生图工具，/);
    expect(settings.geminiAppPromptTemplate).toContain("只修改台词文字/音效文字");
  });

  it("migrates the previous optimized Gemini App prompt to the current default prompt", () => {
    const previousOptimizedPrompt = [
      "任务：把这张漫画/插画页面中的所有原文翻译为{targetLang}，擦除原字，并把译文自然嵌回原位置。",
      "严格限制：只修改文字以及文字所在的气泡、标牌、字幕区域。",
      "不要改变人物、表情、姿势、服装、道具、背景、分镜、线条、色彩、构图、画布尺寸和阅读顺序。",
      "不要新增、删除、替换任何非文字内容。看不清的文字请保留原状或留空，不要猜测剧情、台词、人名或音效。",
      "译文要自然、简洁、适合漫画气泡，必要时自动换行排版。",
      "输出要求：只输出完成后的译图，不要解释、不要对比图、不要额外文字。",
    ].join("\n");

    const settings = normalizeSettings({
      geminiAppPromptTemplate: previousOptimizedPrompt,
    });

    expect(settings.geminiAppPromptTemplate).toBe(optimizedGeminiAppPromptTemplate);
  });

});

describe("OCR engine settings", () => {
  it("uses PaddleOCR v6 medium as the default OCR engine in settings and pipeline config", () => {
    const settings = normalizeSettings({});

    expect(settings.ocrEngine).toBe("paddleocr_v6_medium");
    expect(toPipelineConfig(settings).ocrEngine).toBe("paddleocr_v6_medium");
  });

  it("normalizes legacy OCR names to the medium v6 model", () => {
    const builtin = normalizeSettings({ ocrEngine: "builtin" });
    const old48px = normalizeSettings({ ocrEngine: "48px" });

    expect(builtin.ocrEngine).toBe("paddleocr_v6_medium");
    expect(toPipelineConfig(builtin).ocrEngine).toBe("paddleocr_v6_medium");
    expect(old48px.ocrEngine).toBe("paddleocr_v6_medium");
    expect(toPipelineConfig(old48px).ocrEngine).toBe("paddleocr_v6_medium");
  });

  it("normalizes Paddle OCR choices to the medium v6 model", () => {
    const legacy = normalizeSettings({ ocrEngine: "paddleocr" });
    const small = normalizeSettings({ ocrEngine: "paddleocr_v6_small" });
    const medium = normalizeSettings({ ocrEngine: "paddleocr_v6_medium" });

    expect(legacy.ocrEngine).toBe("paddleocr_v6_medium");
    expect(toPipelineConfig(legacy).ocrEngine).toBe("paddleocr_v6_medium");
    expect(small.ocrEngine).toBe("paddleocr_v6_medium");
    expect(toPipelineConfig(small).ocrEngine).toBe("paddleocr_v6_medium");
    expect(medium.ocrEngine).toBe("paddleocr_v6_medium");
    expect(toPipelineConfig(medium).ocrEngine).toBe("paddleocr_v6_medium");
  });
});
