import type { TextRegion } from "../../types";
import type { PlatformProvider, PipelineImage } from "../../runtime/platform";
import { detectByOnnx, type DetectOutput } from "./onnxDetect";
import { detectByTesseract, detectByHeuristic } from "./heuristicDetect";
import { toErrorMessage } from "../../shared/utils";

export type { DetectOutput };

export async function detectTextRegionsWithMask(image: PipelineImage, platform: PlatformProvider): Promise<DetectOutput> {
  const fallbackReasons: string[] = [];
  try {
    const onnxResult = await detectByOnnx(image, platform);
    if (onnxResult.regions.length > 0) {
      return { ...onnxResult, engine: "onnx" };
    }
    throw new Error("未找到文本");
  } catch (error) {
    if (error instanceof Error && error.message === "未找到文本") {
      throw error;
    }
    const reason = toErrorMessage(error);
    fallbackReasons.push(`onnx: ${reason}`);
    console.warn(`[detect] onnx detector unavailable, fallback to tesseract/heuristic: ${reason}`);
  }

  try {
    const tessRegions = await detectByTesseract(image, platform);
    if (tessRegions.length > 0) {
      return {
        regions: tessRegions,
        rawMaskCanvas: null,
        engine: "tesseract",
        fallbackReason: fallbackReasons.join(" | ")
      };
    }
  } catch (error) {
    const reason = toErrorMessage(error);
    fallbackReasons.push(`tesseract: ${reason}`);
    console.warn(`[detect] tesseract fallback unavailable, switch to heuristic: ${reason}`);
  }

  const heuristicRegions = await detectByHeuristic(image, platform);
  if (heuristicRegions.length === 0) {
    throw new Error("未找到文本");
  }
  return {
    regions: heuristicRegions,
    rawMaskCanvas: null,
    engine: "heuristic",
    fallbackReason: fallbackReasons.join(" | ")
  };
}

export async function detectTextRegions(image: PipelineImage, platform: PlatformProvider): Promise<TextRegion[]> {
  const result = await detectTextRegionsWithMask(image, platform);
  return result.regions;
}
