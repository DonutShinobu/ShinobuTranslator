import type { TextRegion } from "../../types";
import { detectByOnnx, type DetectOutput } from "./onnxDetect";
import { detectByTesseract, detectByHeuristic } from "./heuristicDetect";
import { toErrorMessage } from "../../shared/utils";

export type { DetectOutput };

export async function detectTextRegionsWithMask(image: HTMLImageElement): Promise<DetectOutput> {
  try {
    const onnxResult = await detectByOnnx(image);
    if (onnxResult.regions.length > 0) {
      return onnxResult;
    }
    throw new Error("未找到文本");
  } catch (error) {
    if (error instanceof Error && error.message === "未找到文本") {
      throw error;
    }
    console.warn(`[detect] onnx detector unavailable, fallback to tesseract/heuristic: ${toErrorMessage(error)}`);
  }

  try {
    const tessRegions = await detectByTesseract(image);
    if (tessRegions.length > 0) {
      return {
        regions: tessRegions,
        rawMaskCanvas: null
      };
    }
  } catch (error) {
    console.warn(`[detect] tesseract fallback unavailable, switch to heuristic: ${toErrorMessage(error)}`);
  }

  const heuristicRegions = await detectByHeuristic(image);
  if (heuristicRegions.length === 0) {
    throw new Error("未找到文本");
  }
  return {
    regions: heuristicRegions,
    rawMaskCanvas: null
  };
}

export async function detectTextRegions(image: HTMLImageElement): Promise<TextRegion[]> {
  const result = await detectTextRegionsWithMask(image);
  return result.regions;
}