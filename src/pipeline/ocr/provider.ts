import type { QuadPoint, TextDirection, TextRegion } from "../../types";

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

export function fillMissingOcrFields(
  results: OcrRecognizeResult[],
  image?: HTMLImageElement,
): OcrRecognizeResult[] {
  return results.map((r) => ({
    ...r,
    direction: r.direction ?? inferDirectionFromQuad(r.quad),
    fgColor: r.fgColor ?? [0, 0, 0],
    bgColor: r.bgColor ?? [255, 255, 255],
  }));
}