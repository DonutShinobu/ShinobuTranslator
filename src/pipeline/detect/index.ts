import type { TextRegion } from "../../types";
import type { PlatformProvider, PipelineImage } from "../../runtime/platform";
import { detectByOnnx, type DetectOutput } from "./onnxDetect";
import { detectByTesseract, detectByHeuristic } from "./heuristicDetect";
import { toErrorMessage } from "../../shared/utils";
import {
  ProviderExecutionError,
  type ProviderSessionResolver,
} from "../../runtime/providerExecution";
import { isProviderExecutionReport } from "@shinobu/image-pipeline";

export type { DetectOutput };

export class DetectionExecutionError extends Error {
  constructor(
    message: string,
    readonly providerReports: DetectOutput["providerReports"],
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DetectionExecutionError";
  }
}

function providerReportsFromError(
  error: unknown,
): DetectOutput["providerReports"] {
  if (error instanceof ProviderExecutionError) {
    return [error.report];
  }
  if (
    typeof error !== "object"
    || error === null
    || !("providerReports" in error)
    || !Array.isArray(error.providerReports)
  ) {
    return [];
  }
  return error.providerReports.filter(isProviderExecutionReport);
}

export async function detectTextRegionsWithMask(
  image: PipelineImage,
  platform: PlatformProvider,
  resolver?: ProviderSessionResolver,
): Promise<DetectOutput> {
  const fallbackReasons: string[] = [];
  const providerReports: DetectOutput["providerReports"] = [];
  try {
    const onnxResult = await detectByOnnx(image, platform, resolver);
    if (onnxResult.regions.length > 0) {
      return { ...onnxResult, engine: "onnx" };
    }
    throw new DetectionExecutionError(
      "未找到文本",
      onnxResult.providerReports,
    );
  } catch (error) {
    if (error instanceof DetectionExecutionError) {
      throw error;
    }
    providerReports.push(...providerReportsFromError(error));
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
        fallbackReason: fallbackReasons.join(" | "),
        providerReports
      };
    }
  } catch (error) {
    const reason = toErrorMessage(error);
    fallbackReasons.push(`tesseract: ${reason}`);
    console.warn(`[detect] tesseract fallback unavailable, switch to heuristic: ${reason}`);
  }

  let heuristicRegions: TextRegion[];
  try {
    heuristicRegions = await detectByHeuristic(image, platform);
  } catch (error) {
    throw new DetectionExecutionError(
      toErrorMessage(error),
      providerReports,
      error,
    );
  }
  if (heuristicRegions.length === 0) {
    throw new DetectionExecutionError("未找到文本", providerReports);
  }
  return {
    regions: heuristicRegions,
    rawMaskCanvas: null,
    engine: "heuristic",
    fallbackReason: fallbackReasons.join(" | "),
    providerReports
  };
}

export async function detectTextRegions(image: PipelineImage, platform: PlatformProvider): Promise<TextRegion[]> {
  const result = await detectTextRegionsWithMask(image, platform);
  return result.regions;
}
