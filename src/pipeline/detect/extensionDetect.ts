import type { TextRegion } from '../../types';
import type { PlatformProvider, PipelineImage } from '../../runtime/platform';
import { toErrorMessage } from '../../shared/utils';
import { detectByHeuristic } from './heuristicOnly';
import { detectByOnnx, type DetectOutput } from './onnxDetect';

export type { DetectOutput };

export async function detectTextRegionsWithMask(
  image: PipelineImage,
  platform: PlatformProvider,
): Promise<DetectOutput> {
  let fallbackReason = '';
  try {
    const result = await detectByOnnx(image, platform);
    if (result.regions.length === 0) throw new Error('未找到文本');
    return { ...result, engine: 'onnx' };
  } catch (error) {
    if (error instanceof Error && error.message === '未找到文本') throw error;
    fallbackReason = `onnx: ${toErrorMessage(error)}`;
    console.warn(`[detect] onnx detector unavailable, fallback to heuristic: ${fallbackReason}`);
  }

  const regions = await detectByHeuristic(image, platform);
  if (regions.length === 0) throw new Error('未找到文本');
  return {
    regions,
    rawMaskCanvas: null,
    engine: 'heuristic',
    fallbackReason,
  };
}

export async function detectTextRegions(
  image: PipelineImage,
  platform: PlatformProvider,
): Promise<TextRegion[]> {
  return (await detectTextRegionsWithMask(image, platform)).regions;
}
