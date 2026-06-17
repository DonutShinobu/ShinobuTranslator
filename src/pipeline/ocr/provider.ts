import type { OcrRunDebugInfo, QuadPoint, TextDirection, TextRegion } from "../../types";
import type { PlatformProvider, PipelineImage } from "../../runtime/platform";
import { sampleEdgeColors, sampleCornerBgColor, histogramBimodal } from "./colorSampling";
import { colorDistance } from "../typeset/color";

export type OcrRecognizeResult = {
  text: string;
  confidence: number;
  quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  direction?: TextDirection;
  fgColor?: [number, number, number];
  bgColor?: [number, number, number];
};

export type OcrRecognizeOutput = {
  results: OcrRecognizeResult[];
  provider: import('../../runtime/onnxTypes').RuntimeProvider;
  webnnDeviceType?: import('../../runtime/onnxTypes').WebNnDeviceType;
  debug?: OcrRunDebugInfo;
};

export type OcrProvider = {
  name: string;
  recognize(
    image: PipelineImage,
    regions: TextRegion[],
    platform?: PlatformProvider,
  ): Promise<OcrRecognizeOutput>;
};

const ocrProviders: Record<string, OcrProvider> = {};

export function registerOcrProvider(provider: OcrProvider): void {
  ocrProviders[provider.name] = provider;
}

export function registerOcrProviderAlias(alias: string, providerName: string): void {
  const provider = ocrProviders[providerName];
  if (provider) {
    ocrProviders[alias] = provider;
  }
}

export function getOcrProvider(name: string): OcrProvider | undefined {
  return ocrProviders[name];
}

export function inferDirectionFromQuad(
  quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint],
): TextDirection {
  const minX = Math.min(quad[0].x, quad[1].x, quad[2].x, quad[3].x);
  const maxX = Math.max(quad[0].x, quad[1].x, quad[2].x, quad[3].x);
  const minY = Math.min(quad[0].y, quad[1].y, quad[2].y, quad[3].y);
  const maxY = Math.max(quad[0].y, quad[1].y, quad[2].y, quad[3].y);
  const width = maxX - minX;
  const height = maxY - minY;
  return width >= height ? "h" : "v";
}

function cropQuadRegion(
  image: PipelineImage,
  quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint],
  platform: PlatformProvider,
): { data: Uint8ClampedArray; width: number; height: number } | null {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const minX = Math.floor(Math.min(...xs));
  const minY = Math.floor(Math.min(...ys));
  const maxX = Math.ceil(Math.max(...xs));
  const maxY = Math.ceil(Math.max(...ys));
  const width = maxX - minX;
  const height = maxY - minY;
  const canvas = platform.createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, minX, minY, width, height, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  return { data: imageData.data, width, height };
}

export function fillMissingOcrFields(
  results: OcrRecognizeResult[],
  image?: PipelineImage,
  platform?: PlatformProvider,
): OcrRecognizeResult[] {
  return results.map((r) => {
    let fgColor = r.fgColor;
    let bgColor = r.bgColor;

    // When OCR model provides both colors but they're too similar, fall back
    // to histogram bimodal analysis which is more reliable for bimodal distributions.
    if (fgColor && bgColor && colorDistance(fgColor, bgColor) < 30) {
      if (image) {
        const cropped = cropQuadRegion(image, r.quad, platform!);
        if (cropped) {
          const histResult = histogramBimodal(cropped.data, cropped.width, cropped.height);
          if (histResult) {
            fgColor = histResult.fgColor;
            bgColor = histResult.bgColor;
          }
        }
      }
    }

    if (image && (fgColor === undefined || bgColor === undefined)) {
      const cropped = cropQuadRegion(image, r.quad, platform!);
      if (cropped) {
        // Try histogram bimodal first — it's more reliable than Sobel edge sampling.
        const histResult = histogramBimodal(cropped.data, cropped.width, cropped.height);
        if (histResult) {
          if (fgColor === undefined) fgColor = histResult.fgColor;
          if (bgColor === undefined) bgColor = histResult.bgColor;
        } else {
          if (fgColor === undefined) {
            const sampled = sampleEdgeColors(cropped.data, cropped.width, cropped.height);
            fgColor = sampled ?? [0, 0, 0];
          }
          if (bgColor === undefined) {
            bgColor = sampleCornerBgColor(cropped.data, cropped.width, cropped.height);
          }
        }
      }
    }

    return {
      ...r,
      direction: r.direction ?? inferDirectionFromQuad(r.quad),
      fgColor: fgColor ?? [0, 0, 0],
      bgColor: bgColor ?? [255, 255, 255],
    };
  });
}
