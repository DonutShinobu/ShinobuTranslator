import { describe, expect, it } from "vitest";
import {
  extractGeminiApiGeneratedImage,
  getGeminiApiModelMetadataLabel,
  toGeminiApiErrorMessage,
} from "../../apps/extension/src/background/geminiApiImageClient";
import { resolveGeminiApiImageModel } from "../../apps/extension/src/shared/config";

describe("Gemini API image response parsing", () => {
  it("extracts the first inline image from camelCase inlineData", () => {
    const response = {
      candidates: [
        {
          content: {
            parts: [
              { text: "ignored" },
              {
                inlineData: {
                  mimeType: "image/png",
                  data: "abc123",
                },
              },
            ],
          },
        },
      ],
    };

    expect(extractGeminiApiGeneratedImage(response)).toEqual({
      base64: "abc123",
      contentType: "image/png",
    });
  });

  it("extracts inline images from snake_case inline_data", () => {
    const response = {
      candidates: [
        {
          content: {
            parts: [
              {
                inline_data: {
                  mime_type: "image/jpeg",
                  data: "xyz",
                },
              },
            ],
          },
        },
      ],
    };

    expect(extractGeminiApiGeneratedImage(response)).toEqual({
      base64: "xyz",
      contentType: "image/jpeg",
    });
  });

  it("maps quota errors to a Chinese API quota message", () => {
    expect(
      toGeminiApiErrorMessage(
        {
          error: {
            status: "RESOURCE_EXHAUSTED",
            message: "quota exceeded",
          },
        },
        429,
      ),
    ).toContain("额度不足");
  });

  it("maps Nano Banana display models to official Gemini API image models", () => {
    expect(resolveGeminiApiImageModel("nano_banana_2")).toBe("gemini-3.1-flash-image");
    expect(resolveGeminiApiImageModel("nano_banana_pro")).toBe("gemini-3-pro-image");
    expect(getGeminiApiModelMetadataLabel("nano_banana_2")).toBe("Nano Banana API / Nano Banana 2");
    expect(getGeminiApiModelMetadataLabel("nano_banana_pro")).toBe("Nano Banana API / Nano Banana Pro");
  });
});
