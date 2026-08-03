import { describe, expect, it } from "vitest";
import { filterOcrRegions } from "../../../packages/image-pipeline/src/pipeline/ocrPostFilter";
import type {
  PipelineCanvas,
  PipelineImage,
  PlatformProvider,
} from "../../../packages/image-pipeline/src/runtime/platform";
import type { TextRegion } from "../../../packages/image-pipeline/src/types";

describe("filterOcrRegions", () => {
  it("keeps a region with repeated kana evidence in the plugin pipeline", async () => {
    const image = {
      src: "",
      naturalWidth: 1000,
      naturalHeight: 1000,
      onload: null,
      onerror: null,
    } satisfies PipelineImage;
    const platform = {
      createCanvas: (width: number, height: number): PipelineCanvas => {
        const rgba = new Uint8ClampedArray(width * height * 4);
        const context = {
          imageSmoothingEnabled: false,
          drawImage: () => undefined,
          getImageData: () => ({ width, height, data: rgba }),
        };
        return {
          width,
          height,
          getContext: () => context,
          toDataURL: () => "",
        } as unknown as PipelineCanvas;
      },
      createImage: () => image,
      loadImage: async () => image,
      createImageData: (width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
      registerFont: () => undefined,
      waitForFonts: async () => undefined,
    } satisfies PlatformProvider;
    const mask = {
      width: 1000,
      height: 1000,
      getContext: () => null,
      toDataURL: () => "",
    } satisfies PipelineCanvas;
    const region = {
      id: "voicing-mark-evidence",
      box: { x: 100, y: 100, width: 200, height: 300 },
      sourceText: "木杰",
      translatedText: "",
      prob: 0.31336872947181355,
      originalLineCount: 1,
    } as TextRegion;

    const result = await filterOcrRegions(image, mask, [region], {
      platform,
      providerName: "test",
      recognize: async (_image, variants) => ({
        provider: "cpu",
        results: variants.map((variant) => ({
          regionId: variant.id,
          text: variant.id.includes("inset")
            ? "ホポ"
            : variant.id.includes("original")
              ? "木杰"
              : "ホ办",
          confidence: variant.id.includes("inset") ? 0.5 : 0.3,
          quad: variant.quad!,
        })),
      }),
    });

    expect(result.regions).toEqual([region]);
    expect(result.debug.filteredRegionIds).toEqual([]);
    expect(result.debug.decisions[0]?.protectionReason).toBe("shared-kana");
  });

  it("removes a filter hit before downstream pipeline stages", async () => {
    const platform = {
      createCanvas: (width: number, height: number): PipelineCanvas => {
        const rgba = new Uint8ClampedArray(width * height * 4);
        const context = {
          imageSmoothingEnabled: false,
          drawImage: () => {
            for (let component = 0; component < 80; component += 1) {
              const startX = 5 + (component % 10) * 30;
              const startY = 5 + Math.floor(component / 10) * 30;
              for (let y = startY; y < startY + 2; y += 1) {
                for (let x = startX; x < startX + 2; x += 1) {
                  rgba[(y * width + x) * 4] = 255;
                }
              }
            }
          },
          getImageData: () => ({ width, height, data: rgba }),
        };
        return {
          width,
          height,
          getContext: () => context,
          toDataURL: () => "",
        } as unknown as PipelineCanvas;
      },
      createImage: () => image,
      loadImage: async () => image,
      createImageData: (width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
      registerFont: () => undefined,
      waitForFonts: async () => undefined,
    } satisfies PlatformProvider;
    const mask = {
      width: 1000,
      height: 1000,
      getContext: () => null,
      toDataURL: () => "",
    } satisfies PipelineCanvas;
    const image = {
      src: "",
      naturalWidth: 1000,
      naturalHeight: 1000,
      onload: null,
      onerror: null,
    } satisfies PipelineImage;
    const region = {
      id: "giant-laughter",
      box: { x: 100, y: 100, width: 600, height: 600 },
      sourceText: "民",
      translatedText: "",
      probability: 0.207,
      prob: 0.207,
      originalLineCount: 1,
    } as TextRegion & { probability: number };

    const result = await filterOcrRegions(image, mask, [region], {
      platform,
      providerName: "test",
      recognize: async (_image, variants) => ({
        provider: "cpu",
        results: variants.flatMap((variant) => {
          if (variant.id.includes("inset")) {
            return [{
              regionId: variant.id,
              text: "KIVWA",
              confidence: 0.2736,
              quad: variant.quad!,
            }];
          }
          if (variant.id.includes("original")) {
            return [{
              regionId: variant.id,
              text: "民",
              confidence: 0.9779,
              quad: variant.quad!,
            }];
          }
          return [];
        }),
      }),
    });

    expect(result.regions).toEqual([]);
    expect(result.debug.filteredRegionIds).toEqual(["giant-laughter"]);
  });
});
