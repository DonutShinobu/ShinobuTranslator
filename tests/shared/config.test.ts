import { describe, expect, it } from "vitest";
import {
  defaultGeminiAppPromptTemplate,
  getGeminiAppModelLabel,
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

  it("locks stage timing details off for Nano Banana", () => {
    const settings = normalizeSettings({
      translator: "llm",
      llmProvider: "gemini",
      showElapsedTime: true,
      showStageTimingDetails: true,
    });

    expect(settings.showElapsedTime).toBe(true);
    expect(settings.showStageTimingDetails).toBe(false);
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
  it("uses 48px as the default OCR engine in settings and pipeline config", () => {
    const settings = normalizeSettings({});

    expect(settings.ocrEngine).toBe("48px");
    expect(toPipelineConfig(settings).ocrEngine).toBe("48px");
  });

  it("normalizes the legacy built-in OCR name to 48px without renaming PaddleOCR internally", () => {
    expect(normalizeSettings({ ocrEngine: "builtin" }).ocrEngine).toBe("48px");
    expect(normalizeSettings({ ocrEngine: "paddleocr" }).ocrEngine).toBe("paddleocr");
  });
});
