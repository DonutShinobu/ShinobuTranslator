import type { PlatformProvider, PipelineImage } from "../../runtime/platform";
import type { TextRegion } from "../../types";
import { detectByOnnx, type DetectOutput } from "./onnxDetect";
import {
  ProviderExecutionError,
  type ProviderSessionResolver,
} from "../../runtime/providerExecution";
import { isProviderExecutionReport } from "@shinobu/image-pipeline";
import type { PipelineFailureEnvelope } from "@shinobu/image-pipeline";

export type { DetectOutput };

export class DetectionExecutionError extends Error {
  readonly failure: PipelineFailureEnvelope;

  constructor(
    readonly providerReports: DetectOutput["providerReports"],
    cause: unknown,
  ) {
    super("pipeline.failure.detect", { cause });
    this.name = "DetectionExecutionError";
    this.failure = {
      code: "PIPELINE_DETECT_FAILED",
      stage: "detect",
      scope: "runtime",
      retryable: false,
      messageKey: "pipeline.failure.detect",
      diagnostics: {
        name: cause instanceof Error ? cause.name : "UnknownError",
        ...(providerReports.length > 0 ? { providerReports } : {}),
      },
    };
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
  resolver: ProviderSessionResolver,
): Promise<DetectOutput> {
  try {
    const onnxResult = await detectByOnnx(image, platform, resolver);
    return { ...onnxResult, engine: "onnx" };
  } catch (error) {
    if (error instanceof ProviderExecutionError) {
      throw error;
    }
    throw new DetectionExecutionError(
      providerReportsFromError(error),
      error,
    );
  }
}

export async function detectTextRegions(
  image: PipelineImage,
  platform: PlatformProvider,
  resolver: ProviderSessionResolver,
): Promise<TextRegion[]> {
  const result = await detectTextRegionsWithMask(image, platform, resolver);
  return result.regions;
}
