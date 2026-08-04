import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeminiAppRawResponseError,
  extractGeminiGeneratedImages,
  extractGeminiResponseErrorCode,
  getGeminiAppModelMetadataLabel,
  getGeminiAppModelRequestHeaders,
  getGeminiAppRawResponse,
  parseGeminiAccountStatus,
  runGeminiAppImageTranslate,
} from "../../apps/extension/src/background/geminiAppClient";
import { defaultExtensionSettings } from "../../apps/extension/src/shared/config";
import type { GeminiAppModel } from "../../packages/image-pipeline/src/types";

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

function createGeneratedImageResponse(url: string): string {
  const inner: unknown[] = [];
  inner[1] = ["cid-1", "rid-1"];
  inner[4] = [createCandidateWithGeneratedImage(url)];
  return JSON.stringify([createGeminiPart(inner)]);
}

type CapturedGenerateRequest = {
  headers: Headers;
  request: unknown[];
};

function installGeminiAppFetchMock(
  capture: (request: CapturedGenerateRequest) => void,
  generateResponse = createGeneratedImageResponse("https://example.com/generated.png"),
): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://gemini.google.com/app") {
      return new Response(
        '"SNlM0e":"access-token","cfb2h":"build-label","FdrFJe":"session-id",'
        + '"TuX5cc":"zh-CN","qKIAYe":"push-id"',
      );
    }
    if (url.includes("/batchexecute")) {
      return new Response("[]");
    }
    if (url === "https://content-push.googleapis.com/upload") {
      return new Response("https://upload.example/test-image");
    }
    if (url.includes("/StreamGenerate")) {
      const body = init?.body as URLSearchParams;
      const outer = JSON.parse(body.get("f.req") ?? "null") as [unknown, string];
      capture({
        headers: new Headers(init?.headers),
        request: JSON.parse(outer[1]) as unknown[],
      });
      return new Response(generateResponse);
    }
    if (url.startsWith("https://example.com/generated.png")) {
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "Content-Type": "image/png" },
      });
    }
    throw new Error(`Unexpected Gemini App test request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function captureGenerateRequest(model: GeminiAppModel): Promise<CapturedGenerateRequest> {
  let captured: CapturedGenerateRequest | null = null;
  installGeminiAppFetchMock((request) => {
    captured = request;
  });
  await runGeminiAppImageTranslate({
    imageBase64: "AQID",
    contentType: "image/png",
    filename: "shinobu-protocol-test.png",
    settings: {
      ...defaultExtensionSettings,
      geminiAppAuthMode: "browser_session",
      geminiAppModel: model,
    },
  });
  if (!captured) {
    throw new Error("Gemini App test did not issue StreamGenerate");
  }
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

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

  it("classifies a textual quota-reset response without claiming the account quota is exhausted", async () => {
    const rawResponse = "一旦您的额度重置，我就可以创建更多图片。请在“设置”中查看您的使用情况。";
    installGeminiAppFetchMock(() => undefined, rawResponse);

    let caught: unknown;
    try {
      await runGeminiAppImageTranslate({
        imageBase64: "AQID",
        contentType: "image/png",
        filename: "shinobu-quota-response-test.png",
        settings: {
          ...defaultExtensionSettings,
          geminiAppAuthMode: "browser_session",
          geminiAppModel: "nano_banana_2",
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GeminiAppRawResponseError);
    expect((caught as Error).message).toBe(
      "Gemini App 当前生图通道报告额度不足；如果网页仍可正常生成，可能是 Gemini App 私有协议发生变化",
    );
    expect(getGeminiAppRawResponse(caught)).toBe(rawResponse);
  });
});

describe("Gemini App model selection", () => {
  it("sends the current Flash image protocol through the public translation client", async () => {
    const captured = await captureGenerateRequest("nano_banana_2");
    const modelHeader = JSON.parse(
      captured.headers.get("x-goog-ext-525001261-jspb") ?? "null",
    ) as unknown[];

    expect(modelHeader.slice(0, 16)).toEqual([
      1,
      null,
      null,
      null,
      "56fdd199312815e2",
      null,
      null,
      0,
      [4, 5, 6, 8],
      null,
      null,
      2,
      null,
      null,
      1,
      1,
    ]);
    expect(captured.headers.get("x-goog-ext-73010989-jspb")).toBe("[0]");
    expect(captured.headers.get("x-goog-ext-73010990-jspb")).toBe("[0,0,0]");
    expect(captured.request).toHaveLength(97);
    expect(captured.request[0]).toEqual([
      expect.any(String),
      0,
      null,
      [[
        ["https://upload.example/test-image", 1, null, "image/png"],
        "shinobu-protocol-test.png",
      ]],
      null,
      null,
      0,
    ]);
    expect(captured.request[6]).toEqual([0]);
    expect(captured.request[49]).toBe(14);
    expect(captured.request[68]).toBe(1);
    expect(captured.request[79]).toBe(1);
    expect(captured.request[80]).toBe(1);
    expect(captured.request[91]).toBe(0);
    expect(captured.request[96]).toBe(1);
  });

  it("sends the current Pro image protocol through the public translation client", async () => {
    const captured = await captureGenerateRequest("nano_banana_pro");
    const modelHeader = JSON.parse(
      captured.headers.get("x-goog-ext-525001261-jspb") ?? "null",
    ) as unknown[];

    expect(modelHeader.slice(0, 16)).toEqual([
      1,
      null,
      null,
      null,
      "e6fa609c3fa255c0",
      null,
      null,
      0,
      [4, 5, 6, 8],
      null,
      null,
      2,
      null,
      null,
      3,
      1,
    ]);
    expect(captured.headers.get("x-goog-ext-73010989-jspb")).toBe("[0]");
    expect(captured.headers.get("x-goog-ext-73010990-jspb")).toBe("[0,0,0]");
    expect(captured.request).toHaveLength(97);
    expect(captured.request[79]).toBe(3);
  });

  it("uses the current Flash model header for Nano Banana 2", () => {
    expect(getGeminiAppModelMetadataLabel("nano_banana_2")).toBe("Gemini App / Nano Banana 2");
    expect(getGeminiAppModelRequestHeaders("nano_banana_2")).toMatchObject({
      "x-goog-ext-525001261-jspb": expect.stringContaining("56fdd199312815e2"),
    });
  });

  it("uses the Pro model header for Nano Banana Pro", () => {
    expect(getGeminiAppModelMetadataLabel("nano_banana_pro")).toBe("Gemini App / Nano Banana Pro");
    expect(getGeminiAppModelRequestHeaders("nano_banana_pro")).toMatchObject({
      "x-goog-ext-525001261-jspb": expect.stringContaining("e6fa609c3fa255c0"),
    });
  });
});
