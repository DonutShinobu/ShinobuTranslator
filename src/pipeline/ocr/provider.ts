import type { QuadPoint, TextDirection, TextRegion } from "../../types";
import { sampleEdgeColors, sampleCornerBgColor } from "./colorSampling";

export type OcrRecognizeResult = {
  text: string;
  confidence: number;
  quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  direction?: TextDirection;
  fgColor?: [number, number, number];
  bgColor?: [number, number, number];
};

export type OcrProvider = {
  name: string;
  recognize(
    image: HTMLImageElement,
    regions: TextRegion[],
  ): Promise<OcrRecognizeResult[]>;
};

const ocrProviders: Record<string, OcrProvider> = {};

export function registerOcrProvider(provider: OcrProvider): void {
  ocrProviders[provider.name] = provider;
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
  image: HTMLImageElement,
  quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint],
): { data: Uint8ClampedArray; width: number; height: number } | null {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  const minX = Math.floor(Math.min(...xs));
  const minY = Math.floor(Math.min(...ys));
  const maxX = Math.ceil(Math.max(...xs));
  const maxY = Math.ceil(Math.max(...ys));
  const width = maxX - minX;
  const height = maxY - minY;
  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(image, minX, minY, width, height, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  return { data: imageData.data, width, height };
}

export function fillMissingOcrFields(
  results: OcrRecognizeResult[],
  image?: HTMLImageElement,
): OcrRecognizeResult[] {
  return results.map((r) => {
    let fgColor = r.fgColor;
    let bgColor = r.bgColor;

    if (image && (fgColor === undefined || bgColor === undefined)) {
      const cropped = cropQuadRegion(image, r.quad);
      if (cropped) {
        if (fgColor === undefined) {
          const sampled = sampleEdgeColors(cropped.data, cropped.width, cropped.height);
          fgColor = sampled ?? [0, 0, 0];
        }
        if (bgColor === undefined) {
          bgColor = sampleCornerBgColor(cropped.data, cropped.width, cropped.height);
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