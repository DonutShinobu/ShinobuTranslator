import { describe, expect, it } from "vitest";
import {
  GeminiAppRawResponseError,
  extractGeminiGeneratedImages,
  extractGeminiResponseErrorCode,
  getGeminiAppModelMetadataLabel,
  getGeminiAppModelRequestHeaders,
  getGeminiAppRawResponse,
  parseGeminiAccountStatus,
} from "../../src/background/geminiAppClient";

function createCandidateWithGeneratedImage(url: string): unknown[] {
  const candidate: unknown[] = [];
  candidate[0] = "rcid-1";
  candidate[12] = [];
  const media: unknown[] = [];
  media[7] = [[
    [
      [
        null,
        null,
        null,
        [
          null,
          null,
          null,
          url,
        ],
      ],
      ["image-1"],
    ],
  ]];
  candidate[12] = media;
  return candidate;
}

function createGeminiPart(inner: unknown): unknown[] {
  const part: unknown[] = [];
  part[2] = JSON.stringify(inner);
  return part;
}

describe("Gemini App response parsing", () => {
  it("extracts generated image URLs from StreamGenerate frames", () => {
    const inner: unknown[] = [];
    inner[1] = ["cid-1", "rid-1"];
    inner[4] = [createCandidateWithGeneratedImage("https://example.com/generated.png")];
    const response = JSON.stringify([createGeminiPart(inner)]);

    expect(extractGeminiGeneratedImages(response)).toEqual([
      {
        url: "https://example.com/generated.png",
        imageId: "image-1",
      },
    ]);
  });

  it("extracts generated image URLs from length-prefixed frames", () => {
    const inner: unknown[] = [];
    inner[4] = [createCandidateWithGeneratedImage("https://example.com/framed.png")];
    const frame = JSON.stringify([createGeminiPart(inner)]);
    const response = `)]}'\n\n${frame.length}\n${frame}`;

    expect(extractGeminiGeneratedImages(response)).toEqual([
      {
        url: "https://example.com/framed.png",
        imageId: "image-1",
      },
    ]);
  });

  it("extracts Gemini fatal error codes", () => {
    const part: unknown[] = [];
    part[5] = [null, null, [[null, [1037]]]];

    expect(extractGeminiResponseErrorCode(JSON.stringify([part]))).toBe(1037);
  });

  it("parses account status from batchexecute responses", () => {
    const body: unknown[] = [];
    body[14] = 1016;

    expect(parseGeminiAccountStatus(JSON.stringify([createGeminiPart(body)]))).toBe(1016);
  });

  it("keeps the raw response on empty image response errors", () => {
    const rawResponse = "raw Gemini StreamGenerate response";
    const error = new GeminiAppRawResponseError("Gemini App 未返回可用译图", rawResponse);

    expect(getGeminiAppRawResponse(error)).toBe(rawResponse);
    expect(getGeminiAppRawResponse(new Error("other"))).toBeNull();
  });
});

describe("Gemini App model selection", () => {
  it("uses the default Gemini image path for Nano Banana 2", () => {
    expect(getGeminiAppModelMetadataLabel("nano_banana_2")).toBe("Gemini App / Nano Banana 2");
    expect(getGeminiAppModelRequestHeaders("nano_banana_2")).toEqual({});
  });

  it("uses the Pro model header for Nano Banana Pro", () => {
    expect(getGeminiAppModelMetadataLabel("nano_banana_pro")).toBe("Gemini App / Nano Banana Pro");
    expect(getGeminiAppModelRequestHeaders("nano_banana_pro")).toMatchObject({
      "x-goog-ext-525001261-jspb": expect.stringContaining("e6fa609c3fa255c0"),
    });
  });
});
