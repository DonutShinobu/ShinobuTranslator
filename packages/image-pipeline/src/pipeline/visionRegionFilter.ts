import type { TextRegion } from '../types';
import type { PipelineCanvas, PlatformProvider } from '../runtime/platform';

export type VisionRegion = {
  id: string;
  text: string;
  ocrConfidence: number | null;
  detectorConfidence: number | null;
  direction: TextRegion['direction'];
  lineCount: number;
  inBubble: boolean;
  areaPercent: number;
  boxPercent: { x: number; y: number; width: number; height: number };
  imageDataUrl: string;
};

export type VisionRegionClassifier = (
  regions: VisionRegion[],
  signal?: AbortSignal,
) => Promise<string[]>;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function describeVisionRegions(
  regions: TextRegion[],
  detected: TextRegion[],
  original: PipelineCanvas,
  platform: PlatformProvider,
): VisionRegion[] {
  const imageWidth = original.width;
  const imageHeight = original.height;
  return regions.map((region) => {
    const matchingDetections = detected.filter((candidate) => {
      const overlapWidth = Math.max(0, Math.min(region.box.x + region.box.width, candidate.box.x + candidate.box.width) - Math.max(region.box.x, candidate.box.x));
      const overlapHeight = Math.max(0, Math.min(region.box.y + region.box.height, candidate.box.y + candidate.box.height) - Math.max(region.box.y, candidate.box.y));
      return overlapWidth * overlapHeight >= candidate.box.width * candidate.box.height * 0.5;
    });
    const detectorConfidence = matchingDetections.length > 0
      ? round(matchingDetections.reduce((sum, candidate) => sum + (candidate.prob ?? 0), 0) / matchingDetections.length)
      : null;
    const { x, y, width, height } = region.box;
    const padding = Math.max(4, Math.round(Math.min(width, height) * 0.08));
    const left = Math.max(0, Math.floor(x - padding));
    const top = Math.max(0, Math.floor(y - padding));
    const right = Math.min(imageWidth, Math.ceil(x + width + padding));
    const bottom = Math.min(imageHeight, Math.ceil(y + height + padding));
    const cropWidth = right - left;
    const cropHeight = bottom - top;
    if (cropWidth <= 0 || cropHeight <= 0) throw new Error('视觉过滤区域超出图片');
    const scale = Math.min(1, 1024 / Math.max(cropWidth, cropHeight));
    const crop = platform.createCanvas(Math.max(1, Math.round(cropWidth * scale)), Math.max(1, Math.round(cropHeight * scale)));
    try {
      const context = crop.getContext('2d');
      if (!context) throw new Error('无法裁剪视觉过滤区域');
      context.drawImage(original, left, top, cropWidth, cropHeight, 0, 0, crop.width, crop.height);
      return {
        id: region.id,
        text: region.sourceText,
        ocrConfidence: region.prob === undefined ? null : round(region.prob),
        detectorConfidence,
        direction: region.direction,
        lineCount: region.originalLineCount ?? 1,
        inBubble: region.bubbleBox !== undefined,
        areaPercent: round(width * height / (imageWidth * imageHeight) * 100),
        boxPercent: {
          x: round(x / imageWidth * 100),
          y: round(y / imageHeight * 100),
          width: round(width / imageWidth * 100),
          height: round(height / imageHeight * 100),
        },
        imageDataUrl: crop.toDataURL('image/jpeg'),
      };
    } finally {
      crop.dispose?.();
    }
  });
}
