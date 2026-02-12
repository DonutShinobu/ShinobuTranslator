import type { PipelineArtifacts, PipelineConfig, PipelineProgress } from "../types";
import { fileToImage, imageToCanvas } from "./image";
import { detectTextRegionsWithMask } from "./detect";
import { runOcr } from "./ocr";
import { runTranslate } from "./translate";
import { runInpaint } from "./inpaint";
import { drawTypeset } from "./typeset";
import { drawRegions } from "./visualize";
import { mergeTextLines } from "./textlineMerge";
import { refineTextMask } from "./maskRefinement";
import type { RuntimeStageStatus } from "../types";
import { getModelSession } from "../runtime/modelRegistry";

type ProgressCallback = (progress: PipelineProgress) => void;

function report(cb: ProgressCallback, stage: string, detail: string): void {
  cb({ stage, detail });
}

function toErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class PipelineStageError extends Error {
  readonly stage: string;
  readonly artifacts: PipelineArtifacts;

  constructor(stage: string, detail: string, artifacts: PipelineArtifacts) {
    super(`${stage}失败: ${detail}`);
    this.name = "PipelineStageError";
    this.stage = stage;
    this.artifacts = artifacts;
  }
}

async function probeRuntime(model: "detector" | "ocr" | "inpaint"): Promise<RuntimeStageStatus> {
  try {
    const handle = await getModelSession(model);
    const webnnDeviceType = handle.provider === "webnn" ? handle.webnnDeviceType ?? "default" : undefined;
    const providerLabel = handle.provider === "webnn" ? `${handle.provider}/${webnnDeviceType}` : handle.provider;
    return {
      model,
      enabled: true,
      provider: handle.provider,
      webnnDeviceType,
      detail: `${model} 模型已加载 (${providerLabel})`
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const stageDetail =
      model === "ocr" ? `${model} 模型未启用，OCR 阶段已禁用回退: ${detail}` : `${model} 模型未启用，使用前端回退流程: ${detail}`;
    return {
      model,
      enabled: false,
      detail: stageDetail
    };
  }
}

function createPendingRuntimeStage(model: "detector" | "ocr" | "inpaint"): RuntimeStageStatus {
  return {
    model,
    enabled: false,
    detail: `${model} 模型尚未探测（按阶段懒加载）`
  };
}

export async function runPipeline(
  file: File,
  config: PipelineConfig,
  onProgress: ProgressCallback
): Promise<PipelineArtifacts> {
  report(onProgress, "load", "加载图片");
  const image = await fileToImage(file);
  const originalCanvas = imageToCanvas(image);

  const runtimeStages: RuntimeStageStatus[] = [
    createPendingRuntimeStage("detector"),
    createPendingRuntimeStage("ocr"),
    createPendingRuntimeStage("inpaint")
  ];

  const updateRuntimeStage = async (
    model: "detector" | "ocr" | "inpaint",
    index: 0 | 1 | 2
  ): Promise<void> => {
    runtimeStages[index] = await probeRuntime(model);
  };

  let latestRegions: PipelineArtifacts["detectedRegions"] = [];
  let detectionCanvas: HTMLCanvasElement = originalCanvas;
  let ocrCanvas: HTMLCanvasElement = originalCanvas;
  let segmentationCanvas: HTMLCanvasElement | null = null;
  let cleanedCanvas: HTMLCanvasElement = originalCanvas;
  let resultCanvas: HTMLCanvasElement = originalCanvas;
  let detectionMaskCanvas: HTMLCanvasElement | null = null;
  let refinedMaskCanvas: HTMLCanvasElement | null = null;

  const buildArtifacts = (): PipelineArtifacts => ({
    original: image,
    detectedRegions: latestRegions,
    detectionCanvas,
    ocrCanvas,
    segmentationCanvas,
    cleanedCanvas,
    resultCanvas,
    runtimeStages
  });

  report(onProgress, "detect", "文本检测");
  try {
    await updateRuntimeStage("detector", 0);
    const detected = await detectTextRegionsWithMask(image);
    latestRegions = detected.regions;
    detectionMaskCanvas = detected.rawMaskCanvas;
    segmentationCanvas = detected.rawMaskCanvas;
    detectionCanvas = drawRegions(originalCanvas, detected.regions, "文本检测", () => "文本框");
    ocrCanvas = detectionCanvas;
    cleanedCanvas = ocrCanvas;
    resultCanvas = cleanedCanvas;
  } catch (error) {
    throw new PipelineStageError("文本检测", toErrorDetail(error), buildArtifacts());
  }

  report(onProgress, "ocr", "OCR 日文识别");
  try {
    await updateRuntimeStage("ocr", 1);
    const ocrRegions = await runOcr(image, latestRegions);
    latestRegions = ocrRegions;
    ocrCanvas = drawRegions(originalCanvas, ocrRegions, "OCR 识别", (region) => region.sourceText);
    cleanedCanvas = ocrCanvas;
    resultCanvas = cleanedCanvas;
  } catch (error) {
    throw new PipelineStageError("OCR", toErrorDetail(error), buildArtifacts());
  }

  report(onProgress, "merge", "合并文本行");
  try {
    latestRegions = mergeTextLines(latestRegions, image.naturalWidth, image.naturalHeight);
  } catch (error) {
    throw new PipelineStageError("文本行合并", toErrorDetail(error), buildArtifacts());
  }

  report(onProgress, "translate", "翻译为中文");
  try {
    const translatedRegions = await runTranslate(latestRegions, config);
    latestRegions = translatedRegions;
    cleanedCanvas = ocrCanvas;
    resultCanvas = cleanedCanvas;
  } catch (error) {
    throw new PipelineStageError("翻译", toErrorDetail(error), buildArtifacts());
  }

  report(onProgress, "mask_refine", "细化去字遮罩");
  try {
    if (!detectionMaskCanvas) {
      throw new Error("检测阶段未提供原始 mask，已禁用文本框遮罩回退");
    }
    refinedMaskCanvas = refineTextMask(originalCanvas, latestRegions, detectionMaskCanvas, {
      method: "fit_text",
      dilationOffset: 20,
      kernelSize: 3
    });
    cleanedCanvas = ocrCanvas;
    resultCanvas = cleanedCanvas;
  } catch (error) {
    throw new PipelineStageError("遮罩细化", toErrorDetail(error), buildArtifacts());
  }

  report(onProgress, "inpaint", "去字");
  try {
    await updateRuntimeStage("inpaint", 2);
    if (!refinedMaskCanvas) {
      throw new Error("去字前缺少 refined mask，已禁用文本框遮罩回退");
    }
    cleanedCanvas = await runInpaint(originalCanvas, refinedMaskCanvas);
    resultCanvas = cleanedCanvas;
  } catch (error) {
    throw new PipelineStageError("去字", toErrorDetail(error), buildArtifacts());
  }

  report(onProgress, "typeset", "排版和嵌字");
  try {
    resultCanvas = await drawTypeset(cleanedCanvas, latestRegions);
  } catch (error) {
    throw new PipelineStageError("排版", toErrorDetail(error), buildArtifacts());
  }

  report(onProgress, "done", "完成");
  return buildArtifacts();
}
