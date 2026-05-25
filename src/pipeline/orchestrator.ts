import type {
  PipelineArtifacts,
  PipelineConfig,
  PipelineProgress,
  PipelineTypesetDebugLog,
  RuntimeStageStatus,
  StageTiming,
  TranslationDebugInfo,
  MaskDebugLayers,
} from "../types";
import { fileToImage, imageToCanvas } from "./image";
import { detectTextRegionsWithMask } from "./detect";
import { runOcr } from "./ocr";
import { runTranslate } from "./translate";
import { runInpaint } from "./inpaint";
import { drawTypeset } from "./typeset";
import { drawRegions } from "./visualize";
import { mergeTextLines } from "./textlineMerge";
import { refineTextMask } from "./maskRefinement";
import { sortRegionsForRender } from "./readingOrder";
import { detectBubbles, matchRegionsToBubbles, type BubbleDetection } from "./bubbleDetect";
import { getModelSession } from "../runtime/modelRegistry";
import type { WorkerSessionHandle } from "../runtime/onnxWorkerTypes";

type ProgressCallback = (progress: PipelineProgress) => void;

function buildEraseDebugCanvas(
  originalCanvas: HTMLCanvasElement,
  debugLayers: MaskDebugLayers
): HTMLCanvasElement {
  const { refinedMask, perRegionDilated, globalDilated, scaledWidth, scaledHeight } = debugLayers;
  const width = originalCanvas.width;
  const height = originalCanvas.height;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }
  ctx.drawImage(originalCanvas, 0, 0);

  // Upscale each layer mask to original resolution via intermediate canvas
  const toScaledCanvas = (mask: Uint8Array): HTMLCanvasElement => {
    const src = document.createElement("canvas");
    src.width = scaledWidth;
    src.height = scaledHeight;
    const srcCtx = src.getContext("2d");
    if (!srcCtx) {
      return src;
    }
    const imageData = srcCtx.createImageData(scaledWidth, scaledHeight);
    for (let i = 0, p = 0; i < mask.length; i += 1, p += 4) {
      const v = mask[i] > 0 ? 255 : 0;
      imageData.data[p] = v;
      imageData.data[p + 1] = v;
      imageData.data[p + 2] = v;
      imageData.data[p + 3] = 255;
    }
    srcCtx.putImageData(imageData, 0, 0);

    const dst = document.createElement("canvas");
    dst.width = width;
    dst.height = height;
    const dstCtx = dst.getContext("2d");
    if (!dstCtx) {
      return dst;
    }
    dstCtx.imageSmoothingEnabled = true;
    dstCtx.drawImage(src, 0, 0, width, height);
    return dst;
  };

  // Green: refinedMask (before any dilation)
  // Yellow: perRegionDilated - refinedMask (per-region dilation increment)
  // Red: globalDilated - perRegionDilated (global dilation increment)

  const greenCanvas = toScaledCanvas(refinedMask);
  const yellowRaw = new Uint8Array(scaledWidth * scaledHeight);
  const redRaw = new Uint8Array(scaledWidth * scaledHeight);
  for (let i = 0; i < refinedMask.length; i += 1) {
    const isRefined = refinedMask[i] > 0;
    const isPerRegion = perRegionDilated[i] > 0;
    const isGlobal = globalDilated[i] > 0;
    if (isRefined) {
      // Green layer (refinedMask base)
    } else if (isPerRegion) {
      yellowRaw[i] = 1;
    } else if (isGlobal) {
      redRaw[i] = 1;
    }
  }
  const yellowCanvas = toScaledCanvas(yellowRaw);
  const redCanvas = toScaledCanvas(redRaw);

  // Overlay each color layer with transparency
  ctx.globalAlpha = 0.5;
  ctx.globalCompositeOperation = "source-over";

  // Green overlay
  const greenData = greenCanvas.getContext("2d")?.getImageData(0, 0, width, height);
  if (greenData) {
    for (let p = 0; p < greenData.data.length; p += 4) {
      if (greenData.data[p] > 127) {
        greenData.data[p] = 0;
        greenData.data[p + 1] = 255;
        greenData.data[p + 2] = 0;
        greenData.data[p + 3] = 128;
      } else {
        greenData.data[p + 3] = 0;
      }
    }
    greenCanvas.getContext("2d")?.putImageData(greenData, 0, 0);
  }
  ctx.drawImage(greenCanvas, 0, 0);

  // Yellow overlay
  const yellowData = yellowCanvas.getContext("2d")?.getImageData(0, 0, width, height);
  if (yellowData) {
    for (let p = 0; p < yellowData.data.length; p += 4) {
      if (yellowData.data[p] > 127) {
        yellowData.data[p] = 255;
        yellowData.data[p + 1] = 255;
        yellowData.data[p + 2] = 0;
        yellowData.data[p + 3] = 128;
      } else {
        yellowData.data[p + 3] = 0;
      }
    }
    yellowCanvas.getContext("2d")?.putImageData(yellowData, 0, 0);
  }
  ctx.drawImage(yellowCanvas, 0, 0);

  // Red overlay
  const redData = redCanvas.getContext("2d")?.getImageData(0, 0, width, height);
  if (redData) {
    for (let p = 0; p < redData.data.length; p += 4) {
      if (redData.data[p] > 127) {
        redData.data[p] = 255;
        redData.data[p + 1] = 0;
        redData.data[p + 2] = 0;
        redData.data[p + 3] = 128;
      } else {
        redData.data[p + 3] = 0;
      }
    }
    redCanvas.getContext("2d")?.putImageData(redData, 0, 0);
  }
  ctx.drawImage(redCanvas, 0, 0);

  ctx.globalAlpha = 1;
  return canvas;
}

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
    const handle: WorkerSessionHandle = await getModelSession(model);
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

export async function runPipeline(
  file: File,
  config: PipelineConfig,
  onProgress: ProgressCallback
): Promise<PipelineArtifacts> {
  report(onProgress, "load", "加载图片");
  const image = await fileToImage(file);
  const originalCanvas = imageToCanvas(image);

  const runtimeStages: RuntimeStageStatus[] = [];

  let latestRegions: PipelineArtifacts["detectedRegions"] = [];
  let detectionCanvas: HTMLCanvasElement = originalCanvas;
  let ocrCanvas: HTMLCanvasElement = originalCanvas;
  let segmentationCanvas: HTMLCanvasElement | null = null;
  let cleanedCanvas: HTMLCanvasElement = originalCanvas;
  let resultCanvas: HTMLCanvasElement = originalCanvas;
  let debugOriginalCanvas: HTMLCanvasElement | null = null;
  let eraseDebugCanvas: HTMLCanvasElement | null = null;
  let typesetDebugLog: PipelineTypesetDebugLog | null = null;
  let translationDebug: TranslationDebugInfo | null = null;
  let ocrDebug: PipelineArtifacts['ocrDebug'] = null;
  let detectionMaskCanvas: HTMLCanvasElement | null = null;
  let refinedMaskCanvas: HTMLCanvasElement | null = null;
  const stageTimings: StageTiming[] = [];

  const buildArtifacts = (): PipelineArtifacts => ({
    original: image,
    detectedRegions: latestRegions,
    detectionCanvas,
    ocrCanvas,
    segmentationCanvas,
    cleanedCanvas,
    resultCanvas,
    debugOriginalCanvas,
    typesetDebugLog,
    translationDebug,
    ocrDebug,
    runtimeStages,
    stageTimings
  });

  report(onProgress, "preload", "加载检测模型");
  const preloadT0 = performance.now();
  runtimeStages[0] = await probeRuntime("detector");
  stageTimings.push({ stage: "preload", label: "加载检测模型", durationMs: performance.now() - preloadT0 });

  let ocrRuntimeProbePromise: Promise<RuntimeStageStatus> | null = null;
  let inpaintRuntimeProbePromise: Promise<RuntimeStageStatus> | null = null;

  const startOcrRuntimeProbe = (): Promise<RuntimeStageStatus> => {
    if (!ocrRuntimeProbePromise) {
      ocrRuntimeProbePromise = probeRuntime("ocr");
    }
    return ocrRuntimeProbePromise;
  };

  const startInpaintRuntimeProbe = (): Promise<RuntimeStageStatus> => {
    if (!inpaintRuntimeProbePromise) {
      inpaintRuntimeProbePromise = probeRuntime("inpaint");
    }
    return inpaintRuntimeProbePromise;
  };

  report(onProgress, "detect", "文本检测");
  try {
    startOcrRuntimeProbe();
    const t0 = performance.now();
    const detected = await detectTextRegionsWithMask(image);
    latestRegions = detected.regions;
    detectionMaskCanvas = detected.rawMaskCanvas;
    segmentationCanvas = detected.rawMaskCanvas;
    detectionCanvas = drawRegions(originalCanvas, detected.regions, "文本检测", () => "文本框");
    ocrCanvas = detectionCanvas;
    cleanedCanvas = ocrCanvas;
    resultCanvas = cleanedCanvas;
    if (detected.actualProvider && detected.actualProvider !== runtimeStages[0].provider) {
      const providerLabel = detected.actualProvider === "webnn"
        ? `${detected.actualProvider}/${detected.actualWebnnDeviceType ?? "default"}`
        : detected.actualProvider;
      runtimeStages[0] = {
        model: "detector",
        enabled: true,
        provider: detected.actualProvider,
        webnnDeviceType: detected.actualWebnnDeviceType,
        detail: `detector 推理已回退到 (${providerLabel})`
      };
    }
    stageTimings.push({ stage: "detect", label: "文本检测", durationMs: performance.now() - t0 });
  } catch (error) {
    throw new PipelineStageError("文本检测", toErrorDetail(error), buildArtifacts());
  }

  let detectedBubbles: BubbleDetection[] = [];
  report(onProgress, "bubble", "气泡检测");
  try {
    const t0 = performance.now();
    const bubbleResult = await detectBubbles(image);
    detectedBubbles = bubbleResult.bubbles;
    stageTimings.push({ stage: "bubble", label: "气泡检测", durationMs: performance.now() - t0 });
  } catch (error) {
    throw new PipelineStageError("气泡检测", toErrorDetail(error), buildArtifacts());
  }

  report(onProgress, "ocr", "OCR 日文识别");
  try {
    const t0 = performance.now();
    runtimeStages[1] = await startOcrRuntimeProbe();
    startInpaintRuntimeProbe();
    const ocrResult = await runOcr(image, latestRegions, config.ocrEngine);
    latestRegions = ocrResult.regions;
    ocrDebug = ocrResult.debug;
    ocrCanvas = drawRegions(originalCanvas, ocrResult.regions, "OCR 识别", (region) => region.sourceText);
    cleanedCanvas = ocrCanvas;
    resultCanvas = cleanedCanvas;
    if (ocrResult.actualProvider !== runtimeStages[1].provider) {
      const providerLabel = ocrResult.actualProvider === "webnn"
        ? `${ocrResult.actualProvider}/${ocrResult.actualWebnnDeviceType ?? "default"}`
        : ocrResult.actualProvider;
      runtimeStages[1] = {
        model: "ocr",
        enabled: true,
        provider: ocrResult.actualProvider,
        webnnDeviceType: ocrResult.actualWebnnDeviceType,
        detail: `ocr 推理已回退到 (${providerLabel})`
      };
    }
    stageTimings.push({ stage: "ocr", label: "OCR 日文识别", durationMs: performance.now() - t0 });
    runtimeStages[2] = await startInpaintRuntimeProbe();
  } catch (error) {
    throw new PipelineStageError("OCR", toErrorDetail(error), buildArtifacts());
  }

  report(onProgress, "merge", "合并文本行");
  try {
    const t0 = performance.now();
    latestRegions = mergeTextLines(latestRegions, image.naturalWidth, image.naturalHeight);
    stageTimings.push({ stage: "merge", label: "合并文本行", durationMs: performance.now() - t0 });
  } catch (error) {
    throw new PipelineStageError("文本行合并", toErrorDetail(error), buildArtifacts());
  }

  if (detectedBubbles.length > 0) {
    const matchResult = matchRegionsToBubbles(latestRegions, detectedBubbles);
    if (matchResult.unmatchedCount > 0) {
      console.warn(
        `[bubble] ${matchResult.unmatchedCount} 个文字区域未匹配到气泡:`,
        matchResult.unmatchedRegionIds,
      );
    }
  }

  report(onProgress, "order", "文本顺序排序");
  try {
    const t0 = performance.now();
    latestRegions = sortRegionsForRender(latestRegions, originalCanvas);
    stageTimings.push({ stage: "order", label: "文本顺序排序", durationMs: performance.now() - t0 });
  } catch (error) {
    throw new PipelineStageError("顺序排序", toErrorDetail(error), buildArtifacts());
  }

  const orderedRegions = latestRegions;

  type ParallelTranslateStatus = "pending" | "running" | "done";
  type ParallelEraseStatus = "pending" | "mask_refine" | "inpaint" | "done";

  let parallelTranslateStatus: ParallelTranslateStatus = "pending";
  let parallelEraseStatus: ParallelEraseStatus = "pending";
  let translateTiming: StageTiming | null = null;
  let maskRefineTiming: StageTiming | null = null;
  let inpaintTiming: StageTiming | null = null;
  let parallelTimingsFlushed = false;

  const flushParallelTimings = (): void => {
    if (parallelTimingsFlushed) {
      return;
    }
    if (translateTiming) {
      stageTimings.push(translateTiming);
    }
    if (maskRefineTiming) {
      stageTimings.push(maskRefineTiming);
    }
    if (inpaintTiming) {
      stageTimings.push(inpaintTiming);
    }
    parallelTimingsFlushed = true;
  };

  const getTranslateDetail = (): string => {
    if (parallelTranslateStatus === "running") {
      return "\u7ffb\u8bd1\u4e2d";
    }
    if (parallelTranslateStatus === "done") {
      return "\u7ffb\u8bd1\u5b8c\u6210";
    }
    return "\u7ffb\u8bd1\u5f85\u6267\u884c";
  };

  const getEraseDetail = (): string => {
    if (parallelEraseStatus === "mask_refine") {
      return "\u7ec6\u5316\u906e\u7f69\u4e2d";
    }
    if (parallelEraseStatus === "inpaint") {
      return "\u53bb\u5b57\u4e2d";
    }
    if (parallelEraseStatus === "done") {
      return "\u53bb\u5b57\u5b8c\u6210";
    }
    return "\u53bb\u5b57\u5f85\u6267\u884c";
  };

  const reportParallel = (): void => {
    report(onProgress, "parallel", `${getTranslateDetail()} | ${getEraseDetail()}`);
  };

  reportParallel();
  const parallelT0 = performance.now();

  const translateTask = (async (): Promise<PipelineArtifacts["detectedRegions"]> => {
    parallelTranslateStatus = "running";
    reportParallel();
    try {
      const t0 = performance.now();
      const translated = await runTranslate(orderedRegions, config);
      const translatedRegions = translated.regions;
      translateTiming = { stage: "translate", label: "\u7ffb\u8bd1\u4e3a\u4e2d\u6587", durationMs: performance.now() - t0 };
      translationDebug = translated.translationDebug;
      parallelTranslateStatus = "done";
      reportParallel();
      return translatedRegions;
    } catch (error) {
      throw new PipelineStageError("\u7ffb\u8bd1", toErrorDetail(error), buildArtifacts());
    }
  })();

  const eraseTask = (async (): Promise<HTMLCanvasElement> => {
    if (!detectionMaskCanvas) {
      throw new PipelineStageError("\u906e\u7f69\u7ec6\u5316", "\u68c0\u6d4b\u9636\u6bb5\u672a\u63d0\u4f9b\u539f\u59cb mask\uff0c\u5df2\u7981\u7528\u6587\u672c\u6846\u906e\u7f69\u56de\u9000", buildArtifacts());
    }

    parallelEraseStatus = "mask_refine";
    reportParallel();
    try {
      const t0 = performance.now();
      const refineResult = refineTextMask(originalCanvas, orderedRegions, detectionMaskCanvas, {
        method: "fit_text",
        dilationOffset: 20,
        kernelSize: 3
      }, config.eraseDebug);
      refinedMaskCanvas = refineResult.refinedMaskCanvas;
      if (refineResult.debugLayers) {
        eraseDebugCanvas = buildEraseDebugCanvas(originalCanvas, refineResult.debugLayers);
      }
      maskRefineTiming = { stage: "mask_refine", label: "\u7ec6\u5316\u53bb\u5b57\u906e\u7f69", durationMs: performance.now() - t0 };
    } catch (error) {
      throw new PipelineStageError("\u906e\u7f69\u7ec6\u5316", toErrorDetail(error), buildArtifacts());
    }

    parallelEraseStatus = "inpaint";
    reportParallel();
    try {
      const t0 = performance.now();
      if (!refinedMaskCanvas) {
        throw new Error("\u53bb\u5b57\u524d\u7f3a\u5c11 refined mask\uff0c\u5df2\u7981\u7528\u6587\u672c\u6846\u906e\u7f69\u56de\u9000");
      }
      const inpaintResult = await runInpaint(originalCanvas, refinedMaskCanvas);
      inpaintTiming = { stage: "inpaint", label: "\u53bb\u5b57", durationMs: performance.now() - t0 };
      if (inpaintResult.actualProvider !== runtimeStages[2].provider) {
        const providerLabel = inpaintResult.actualProvider === "webnn"
          ? `${inpaintResult.actualProvider}/${inpaintResult.actualWebnnDeviceType ?? "default"}`
          : inpaintResult.actualProvider;
        runtimeStages[2] = {
          model: "inpaint",
          enabled: true,
          provider: inpaintResult.actualProvider,
          webnnDeviceType: inpaintResult.actualWebnnDeviceType,
          detail: `inpaint \u63a8\u7406\u5df2\u56de\u9000\u5230 (${providerLabel})`
        };
      }
      parallelEraseStatus = "done";
      reportParallel();
      return inpaintResult.canvas;
    } catch (error) {
      throw new PipelineStageError("\u53bb\u5b57", toErrorDetail(error), buildArtifacts());
    }
  })();

  try {
    const [translatedRegions, inpaintedCanvas] = await Promise.all([translateTask, eraseTask]);
    latestRegions = translatedRegions;
    cleanedCanvas = inpaintedCanvas;
    resultCanvas = cleanedCanvas;
    flushParallelTimings();
    stageTimings.push({
      stage: "parallel",
      label: "\u5e76\u884c\u5904\u7406(\u7ffb\u8bd1 + \u53bb\u5b57)",
      durationMs: performance.now() - parallelT0
    });
  } catch (error) {
    flushParallelTimings();
    if (error instanceof PipelineStageError) {
      throw error;
    }
    throw new PipelineStageError("\u5e76\u884c\u5904\u7406", toErrorDetail(error), buildArtifacts());
  }

  report(onProgress, "typeset", "\u6392\u7248\u548c\u5d4c\u5b57");
  try {
    const t0 = performance.now();
    const typesetResult = await drawTypeset(cleanedCanvas, latestRegions, config.targetLang, {
      debugMode: config.typesetDebug,
      renderText: true,
      collectDebugLog: false,
    });
    resultCanvas = typesetResult.canvas;
    if (config.eraseDebug && eraseDebugCanvas) {
      resultCanvas = eraseDebugCanvas;
    }
    if (config.collectDebugLog) {
      const debugOriginalTypeset = await drawTypeset(originalCanvas, latestRegions, config.targetLang, {
        debugMode: true,
        renderText: false,
        collectDebugLog: true,
      });
      debugOriginalCanvas = debugOriginalTypeset.canvas;
      typesetDebugLog = debugOriginalTypeset.debugLog;
    } else {
      debugOriginalCanvas = null;
      typesetDebugLog = null;
    }
    stageTimings.push({ stage: "typeset", label: "排版和嵌字", durationMs: performance.now() - t0 });
  } catch (error) {
    throw new PipelineStageError("排版", toErrorDetail(error), buildArtifacts());
  }

  report(onProgress, "done", "完成");
  return buildArtifacts();
}
