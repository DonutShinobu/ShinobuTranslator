import type {
  PipelineArtifacts,
  PipelineConfig,
  PipelineProgress,
  PipelineStageRegions,
  PipelineTypesetDebugLog,
  RuntimeStageStatus,
  StageTiming,
  TextRegion,
  TranslationDebugInfo,
  MaskDebugLayers,
} from "../types";
import type { PlatformProvider, PipelineCanvas } from "../runtime/platform";
import { browserPlatform } from "../runtime/browserPlatform";
import { fileToImage, imageToCanvas } from "./image";
import { detectTextRegionsWithMask } from "./detect";
import { runOcr } from "./ocr";
import { preparePaddleOcrRuntime, warmupPaddleOcrRuntime } from "./ocr/paddleocrProvider";
import { runTranslate } from "./translate";
import { runInpaint } from "./inpaint";
import { drawTypeset } from "./typeset";
import { drawRegions } from "./visualize";
import { mergeTextLines } from "./textlineMerge";
import {
  filterOcrRegions,
} from "./ocrPostFilter";
import { OCR_POST_FILTER_RULE_ID } from "./ocrPostFilter/rule";
import { refineTextMask } from "./maskRefinement";
import { sortRegionsForRender } from "./readingOrder";
import { detectBubbles, matchRegionsToBubbles, type BubbleDetection } from "./bubbleDetect";
import { getModelSession } from "../runtime/modelRegistry";
import type { WorkerSessionHandle } from "../runtime/onnxWorkerTypes";
import { emitDiagnosticLog } from "../shared/diagnosticLogClient";
import { toDiagnosticError, type DiagnosticLogCategory } from "../shared/diagnosticLog";
import { createCancelledError } from "../shared/localPipelineProtocol";
import type { TextTranslationTransport } from "../translators/transport";
import {
  isPipelineFailureEnvelope,
  type PipelineFailureEnvelope,
} from "@shinobu/image-pipeline";

type ProgressCallback = (progress: PipelineProgress) => void;

export type PipelineRunOptions = {
  signal?: AbortSignal;
  stopAfter?: "order";
  platform?: PlatformProvider;
  translationTransport?: TextTranslationTransport;
};

type PaddleOcrRuntimeProbeMode = "legacy" | "prepare" | "warmup";
type PaddleOcrRuntimeProbeSchedule = "detect-start" | "after-detect" | "bubble-start" | "after-bubble" | "ocr-start";
type InpaintRuntimeProbeSchedule = "current" | "detect-start" | "after-detect" | "bubble-start" | "after-bubble" | "ocr-start";
type BubbleRuntimeProbeSchedule = "current" | "detect-start" | "after-detect";

type PipelineRuntimeFlags = typeof globalThis & {
  __shinobuPaddleOcrRuntimeProbe?: PaddleOcrRuntimeProbeMode;
  __shinobuPaddleOcrRuntimeProbeSchedule?: PaddleOcrRuntimeProbeSchedule;
  __shinobuInpaintRuntimeProbeSchedule?: InpaintRuntimeProbeSchedule;
  __shinobuBubbleRuntimeProbeSchedule?: BubbleRuntimeProbeSchedule;
  __shinobuPaddleOcrWarmupInputWidth?: number;
  __shinobuPaddleOcrWarmupBatchSize?: number;
};

function getPaddleOcrRuntimeProbeMode(): PaddleOcrRuntimeProbeMode {
  return (globalThis as PipelineRuntimeFlags).__shinobuPaddleOcrRuntimeProbe ?? "legacy";
}

function getPaddleOcrRuntimeProbeSchedule(): PaddleOcrRuntimeProbeSchedule {
  return (globalThis as PipelineRuntimeFlags).__shinobuPaddleOcrRuntimeProbeSchedule ?? "detect-start";
}

function getInpaintRuntimeProbeSchedule(): InpaintRuntimeProbeSchedule {
  return (globalThis as PipelineRuntimeFlags).__shinobuInpaintRuntimeProbeSchedule ?? "current";
}

function getBubbleRuntimeProbeSchedule(): BubbleRuntimeProbeSchedule {
  return (globalThis as PipelineRuntimeFlags).__shinobuBubbleRuntimeProbeSchedule ?? "current";
}

async function probePaddleOcrRuntime(): Promise<RuntimeStageStatus> {
  const mode = getPaddleOcrRuntimeProbeMode();
  if (mode === "warmup") {
    const flags = globalThis as PipelineRuntimeFlags;
    const warmup = await warmupPaddleOcrRuntime({
      inputWidth: flags.__shinobuPaddleOcrWarmupInputWidth,
      batchSize: flags.__shinobuPaddleOcrWarmupBatchSize,
    });
    const providerLabel = warmup.provider === "webnn"
      ? `${warmup.provider}/${warmup.webnnDeviceType ?? "default"}`
      : warmup.provider;
    return {
      model: "ocr",
      enabled: true,
      provider: warmup.provider,
      webnnDeviceType: warmup.provider === "webnn" ? warmup.webnnDeviceType ?? "default" : undefined,
      detail: `Paddle OCR warmup 完成 (${providerLabel}, ${warmup.inputDims.join("x")}, run=${Math.round(warmup.runMs)}ms)`,
    };
  }

  const runtime = await preparePaddleOcrRuntime();
  const webnnDeviceType = runtime.sessionHandle.provider === "webnn" ? runtime.sessionHandle.webnnDeviceType ?? "default" : undefined;
  const providerLabel = runtime.sessionHandle.provider === "webnn"
    ? `${runtime.sessionHandle.provider}/${webnnDeviceType}`
    : runtime.sessionHandle.provider;
  return {
    model: "ocr",
    enabled: true,
    provider: runtime.sessionHandle.provider,
    webnnDeviceType,
    detail: `Paddle OCR 模型已加载 (${runtime.modelName}, ${providerLabel})`,
  };
}

function buildEraseDebugCanvas(
  originalCanvas: PipelineCanvas,
  debugLayers: MaskDebugLayers,
  platform: PlatformProvider,
  baseCanvas?: PipelineCanvas
): PipelineCanvas {
  const { refinedMask, perRegionDilated, globalDilated, scaledWidth, scaledHeight } = debugLayers;
  const width = originalCanvas.width;
  const height = originalCanvas.height;

  const canvas = platform.createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return canvas;
  }
  ctx.drawImage(baseCanvas ?? originalCanvas, 0, 0);

  // Upscale each layer mask to original resolution via intermediate canvas
  const toScaledCanvas = (mask: Uint8Array): PipelineCanvas => {
    const src = platform.createCanvas(scaledWidth, scaledHeight);
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

    const dst = platform.createCanvas(width, height);
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

function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw createCancelledError(typeof signal.reason === "string" ? signal.reason : undefined);
}

function logPipelineStage(
  config: PipelineConfig,
  category: DiagnosticLogCategory,
  message: string,
  data?: Record<string, unknown>,
  error?: unknown,
): void {
  if (!config.diagnosticRunId) return;
  emitDiagnosticLog({
    runId: config.diagnosticRunId,
    level: error === undefined ? "info" : "error",
    category,
    source: { context: "offscreen", module: "orchestrator.ts" },
    message,
    data,
    error: error === undefined ? undefined : toDiagnosticError(error),
  });
}

function toErrorDetail(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function hasPipelineFailure(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "failure" in error
    && isPipelineFailureEnvelope(error.failure);
}

type RegionQuad = NonNullable<TextRegion["quad"]>;

function cloneRegionQuad(quad: RegionQuad): RegionQuad {
  return quad.map((point) => ({ ...point })) as RegionQuad;
}

function cloneTextRegions(regions: TextRegion[]): TextRegion[] {
  return regions.map((region) => {
    return {
      ...region,
      box: { ...region.box },
      quad: region.quad ? cloneRegionQuad(region.quad) : undefined,
      fgColor: region.fgColor ? [...region.fgColor] : undefined,
      bgColor: region.bgColor ? [...region.bgColor] : undefined,
      translatedColumns: region.translatedColumns ? [...region.translatedColumns] : undefined,
      sourceLineGeometries: region.sourceLineGeometries?.map((geometry) => ({
        ...geometry,
        box: { ...geometry.box },
        quad: geometry.quad ? cloneRegionQuad(geometry.quad) : undefined,
      })),
      bubbleBox: region.bubbleBox ? { ...region.bubbleBox } : undefined,
      // Stage snapshots are diagnostics, not render inputs. Retaining masks here
      // multiplies memory without adding useful inspection data.
      bubbleMask: undefined,
    };
  });
}

export class PipelineStageError extends Error {
  readonly stage: string;
  readonly stageLabel: string;
  readonly artifacts: PipelineArtifacts;
  readonly failure: PipelineFailureEnvelope;

  constructor(
    stage: string,
    stageLabel: string,
    detail: string,
    artifacts: PipelineArtifacts,
    scope: PipelineFailureEnvelope["scope"],
    cause?: unknown,
  ) {
    super(`${stageLabel}失败: ${detail}`, cause === undefined ? undefined : { cause });
    this.name = "PipelineStageError";
    this.stage = stage;
    this.stageLabel = stageLabel;
    this.artifacts = artifacts;
    this.failure = {
      code: "PIPELINE_STAGE_FAILED",
      stage,
      scope,
      retryable: false,
      messageKey: "pipeline.failure.stage",
      diagnostics: {
        name: this.name,
      },
    };
  }

  get code(): string {
    return this.failure.code;
  }
}

async function probeRuntime(model: "detector" | "bubble" | "ocr" | "inpaint"): Promise<RuntimeStageStatus> {
  try {
    let handle: WorkerSessionHandle;
    if (model === "ocr") {
      if (getPaddleOcrRuntimeProbeMode() !== "legacy") {
        return await probePaddleOcrRuntime();
      }
      const paddleRuntime = await preparePaddleOcrRuntime();
      handle = paddleRuntime.sessionHandle;
    } else {
      handle = await getModelSession(model);
    }
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
      model === "ocr"
        ? `${model} 模型未启用，OCR 阶段已禁用回退: ${detail}`
        : model === "bubble"
          ? `${model} 模型未启用，气泡检测无法继续: ${detail}`
          : `${model} 模型未启用，使用检测回退流程: ${detail}`;
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
  onProgress: ProgressCallback,
  options: PipelineRunOptions = {},
): Promise<PipelineArtifacts> {
  const platform = options.platform ?? browserPlatform;
  const stageTimings: StageTiming[] = [];
  const signal = options.signal;
  const stopAfterOrder = options.stopAfter === "order";

  throwIfCancelled(signal);
  report(onProgress, "load", "加载图片");
  const loadT0 = performance.now();
  const image = await fileToImage(file, platform);
  throwIfCancelled(signal);
  const originalCanvas = imageToCanvas(image, platform);
  stageTimings.push({ stage: "load", label: "加载图片", durationMs: performance.now() - loadT0 });

  const runtimeStages: RuntimeStageStatus[] = [];
  const stageRegions: PipelineStageRegions = {
    detected: [],
    ocr: [],
    merged: [],
    ordered: [],
  };

  let latestRegions: PipelineArtifacts["detectedRegions"] = [];
  let detectionCanvas: PipelineCanvas = originalCanvas;
  let ocrCanvas: PipelineCanvas = originalCanvas;
  let segmentationCanvas: PipelineCanvas | null = null;
  let cleanedCanvas: PipelineCanvas = originalCanvas;
  let resultCanvas: PipelineCanvas = originalCanvas;
  let debugOriginalCanvas: PipelineCanvas | null = null;
  let eraseDebugCanvas: PipelineCanvas | null = null;
  let typesetDebugLog: PipelineTypesetDebugLog | null = null;
  let translationDebug: TranslationDebugInfo | null = null;
  let ocrDebug: PipelineArtifacts['ocrDebug'] = null;
  let ocrPostFilterDebug: PipelineArtifacts['ocrPostFilterDebug'] = null;
  let detectionMaskCanvas: PipelineCanvas | null = null;
  let refinedMaskCanvas: PipelineCanvas | null = null;
  let debugLayers: MaskDebugLayers | null = null;

  const buildArtifacts = (): PipelineArtifacts => ({
    original: image,
    detectedRegions: latestRegions,
    stageRegions,
    detectionCanvas,
    ocrCanvas,
    segmentationCanvas,
    cleanedCanvas,
    resultCanvas,
    debugOriginalCanvas,
    typesetDebugLog,
    translationDebug,
    ocrDebug,
    ocrPostFilterDebug,
    runtimeStages,
    stageTimings
  });

  const setRuntimeStage = (status: RuntimeStageStatus): void => {
    const index = runtimeStages.findIndex((stage) => stage.model === status.model);
    if (index >= 0) runtimeStages[index] = status;
    else runtimeStages.push(status);
  };

  const getRuntimeStage = (model: RuntimeStageStatus["model"]): RuntimeStageStatus | undefined =>
    runtimeStages.find((stage) => stage.model === model);

  throwIfCancelled(signal);
  report(onProgress, "preload", "加载检测模型");
  const preloadT0 = performance.now();
  setRuntimeStage(await probeRuntime("detector"));
  throwIfCancelled(signal);
  stageTimings.push({ stage: "preload", label: "加载检测模型", durationMs: performance.now() - preloadT0 });

  let ocrRuntimeProbePromise: Promise<RuntimeStageStatus> | null = null;
  let inpaintRuntimeProbePromise: Promise<RuntimeStageStatus> | null = null;
  let bubbleRuntimeProbePromise: Promise<RuntimeStageStatus> | null = null;
  const ocrRuntimeProbeSchedule = getPaddleOcrRuntimeProbeSchedule();
  const inpaintRuntimeProbeSchedule = getInpaintRuntimeProbeSchedule();
  const bubbleRuntimeProbeSchedule = getBubbleRuntimeProbeSchedule();

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

  const startBubbleRuntimeProbe = (): Promise<RuntimeStageStatus> => {
    if (!bubbleRuntimeProbePromise) {
      bubbleRuntimeProbePromise = probeRuntime("bubble");
    }
    return bubbleRuntimeProbePromise;
  };

  throwIfCancelled(signal);
  report(onProgress, "detect", "文本检测");
  try {
    if (ocrRuntimeProbeSchedule === "detect-start") {
      startOcrRuntimeProbe();
    }
    if (!stopAfterOrder && inpaintRuntimeProbeSchedule === "detect-start") {
      startInpaintRuntimeProbe();
    }
    if (bubbleRuntimeProbeSchedule === "detect-start") {
      startBubbleRuntimeProbe();
    }
    const t0 = performance.now();
    const detected = await detectTextRegionsWithMask(image, platform);
    throwIfCancelled(signal);
    latestRegions = detected.regions;
    stageRegions.detected = cloneTextRegions(latestRegions);
    detectionMaskCanvas = detected.rawMaskCanvas;
    segmentationCanvas = detected.rawMaskCanvas;
    detectionCanvas = drawRegions(originalCanvas, detected.regions, "文本检测", () => "文本框", platform);
    ocrCanvas = detectionCanvas;
    cleanedCanvas = ocrCanvas;
    resultCanvas = cleanedCanvas;
    const detectorRuntime = getRuntimeStage("detector");
    if (detected.engine !== "onnx") {
      setRuntimeStage({
        model: "detector",
        enabled: true,
        engine: detected.engine,
        detail: `detector 已回退到 ${detected.engine ?? "unknown"}: ${detected.fallbackReason ?? "未提供原因"}`,
      });
    } else if (detected.actualProvider && detected.actualProvider !== detectorRuntime?.provider) {
      const providerLabel = detected.actualProvider === "webnn"
        ? `${detected.actualProvider}/${detected.actualWebnnDeviceType ?? "default"}`
        : detected.actualProvider;
      setRuntimeStage({
        model: "detector",
        enabled: true,
        engine: "onnx",
        provider: detected.actualProvider,
        webnnDeviceType: detected.actualWebnnDeviceType,
        detail: `detector 推理已回退到 (${providerLabel})`
      });
    } else if (detectorRuntime) {
      setRuntimeStage({ ...detectorRuntime, engine: "onnx" });
    }
    const durationMs = performance.now() - t0;
    stageTimings.push({ stage: "detect", label: "文本检测", durationMs });
    logPipelineStage(config, "pipeline.detect", "文本检测完成", {
      engine: detected.engine,
      fallbackReason: detected.fallbackReason,
      provider: detected.actualProvider,
      webnnDeviceType: detected.actualWebnnDeviceType,
      regionCount: detected.regions.length,
      durationMs,
    });
    if (ocrRuntimeProbeSchedule === "after-detect") {
      startOcrRuntimeProbe();
    }
    if (!stopAfterOrder && inpaintRuntimeProbeSchedule === "after-detect") {
      startInpaintRuntimeProbe();
    }
    if (bubbleRuntimeProbeSchedule === "after-detect") {
      startBubbleRuntimeProbe();
    }
  } catch (error) {
    logPipelineStage(config, "pipeline.detect", "文本检测失败", undefined, error);
    throw new PipelineStageError("detect", "文本检测", toErrorDetail(error), buildArtifacts(), "runtime", error);
  }

  let detectedBubbles: BubbleDetection[] = [];
  throwIfCancelled(signal);
  try {
    if (ocrRuntimeProbeSchedule === "bubble-start") {
      startOcrRuntimeProbe();
    }
    if (!stopAfterOrder && inpaintRuntimeProbeSchedule === "bubble-start") {
      startInpaintRuntimeProbe();
    }
    report(onProgress, "bubble", "气泡检测");
    if (bubbleRuntimeProbeSchedule !== "current") {
      const bubblePreloadT0 = performance.now();
      setRuntimeStage(await startBubbleRuntimeProbe());
      throwIfCancelled(signal);
      stageTimings.push({
        stage: "preload_bubble",
        label: "加载气泡模型",
        durationMs: performance.now() - bubblePreloadT0,
      });
    }
    const t0 = performance.now();
    const bubbleResult = await detectBubbles(image, platform);
    throwIfCancelled(signal);
    detectedBubbles = bubbleResult.bubbles;
    const bubbleProviderLabel = bubbleResult.actualProvider === "webnn"
      ? `${bubbleResult.actualProvider}/${bubbleResult.actualWebnnDeviceType ?? "default"}`
      : bubbleResult.actualProvider;
    setRuntimeStage({
      model: "bubble",
      enabled: true,
      provider: bubbleResult.actualProvider,
      webnnDeviceType: bubbleResult.actualWebnnDeviceType,
      detail: `bubble 模型已运行 (${bubbleProviderLabel})`,
    });
    const durationMs = performance.now() - t0;
    stageTimings.push({ stage: "bubble", label: "气泡检测", durationMs });
    logPipelineStage(config, "pipeline.bubble", "气泡检测完成", {
      bubbleCount: bubbleResult.bubbles.length,
      provider: bubbleResult.actualProvider,
      webnnDeviceType: bubbleResult.actualWebnnDeviceType,
      durationMs,
    });
    if (ocrRuntimeProbeSchedule === "after-bubble") {
      startOcrRuntimeProbe();
    }
    if (!stopAfterOrder && inpaintRuntimeProbeSchedule === "after-bubble") {
      startInpaintRuntimeProbe();
    }
  } catch (error) {
    logPipelineStage(config, "pipeline.bubble", "气泡检测失败", undefined, error);
    throw new PipelineStageError("bubble", "气泡检测", toErrorDetail(error), buildArtifacts(), "runtime", error);
  }

  throwIfCancelled(signal);
  report(onProgress, "ocr", "OCR 日文识别");
  try {
    if (!stopAfterOrder && inpaintRuntimeProbeSchedule === "ocr-start") {
      startInpaintRuntimeProbe();
    }
    const t0 = performance.now();
    setRuntimeStage(await startOcrRuntimeProbe());
    throwIfCancelled(signal);
    if (!stopAfterOrder && inpaintRuntimeProbeSchedule === "current") {
      startInpaintRuntimeProbe();
    }
    const ocrResult = await runOcr(image, latestRegions, config.ocrEngine, platform, {
      compactActiveBatch: config.ocrCompactActiveBatch,
    });
    throwIfCancelled(signal);
    latestRegions = ocrResult.regions;
    stageRegions.ocr = cloneTextRegions(latestRegions);
    ocrDebug = ocrResult.debug;
    ocrCanvas = drawRegions(originalCanvas, ocrResult.regions, "OCR 识别", (region) => region.sourceText, platform);
    cleanedCanvas = ocrCanvas;
    resultCanvas = cleanedCanvas;
    const ocrRuntime = getRuntimeStage("ocr");
    if (ocrResult.actualProvider !== ocrRuntime?.provider) {
      const providerLabel = ocrResult.actualProvider === "webnn"
        ? `${ocrResult.actualProvider}/${ocrResult.actualWebnnDeviceType ?? "default"}`
        : ocrResult.actualProvider;
      setRuntimeStage({
        model: "ocr",
        enabled: true,
        provider: ocrResult.actualProvider,
        webnnDeviceType: ocrResult.actualWebnnDeviceType,
        detail: `ocr 推理已回退到 (${providerLabel})`
      });
    }
    const ocrDurationMs = performance.now() - t0;
    stageTimings.push({ stage: "ocr", label: "OCR 日文识别", durationMs: ocrDurationMs });
    logPipelineStage(config, "pipeline.ocr", "OCR 识别完成", {
      engine: config.ocrEngine,
      provider: ocrResult.actualProvider,
      webnnDeviceType: ocrResult.actualWebnnDeviceType,
      regionCount: ocrResult.regions.length,
      durationMs: ocrDurationMs,
      debug: ocrResult.debug,
    });
    if (!stopAfterOrder) {
      const inpaintPreloadT0 = performance.now();
      setRuntimeStage(await startInpaintRuntimeProbe());
      throwIfCancelled(signal);
      stageTimings.push({
        stage: "preload_inpaint",
        label: "加载去字模型",
        durationMs: performance.now() - inpaintPreloadT0,
      });
    }
  } catch (error) {
    logPipelineStage(config, "pipeline.ocr", "OCR 识别失败", undefined, error);
    throw new PipelineStageError("ocr", "OCR", toErrorDetail(error), buildArtifacts(), "runtime", error);
  }

  throwIfCancelled(signal);
  report(onProgress, "merge", "合并文本行");
  try {
    const t0 = performance.now();
    latestRegions = mergeTextLines(latestRegions, image.naturalWidth, image.naturalHeight);
    stageRegions.merged = cloneTextRegions(latestRegions);
    stageTimings.push({ stage: "merge", label: "合并文本行", durationMs: performance.now() - t0 });
  } catch (error) {
    throw new PipelineStageError("merge", "文本行合并", toErrorDetail(error), buildArtifacts(), "image", error);
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
  // Matched masks remain reachable through their regions; unmatched masks can
  // be reclaimed before the remaining stages allocate render canvases.
  detectedBubbles = [];

  if ((config.ocrPostFilter ?? "balanced") === "off") {
    ocrPostFilterDebug = {
      mode: "off",
      ruleId: OCR_POST_FILTER_RULE_ID,
      candidateCount: 0,
      filteredCount: 0,
      filteredRegionIds: [],
      decisions: [],
      durationMs: 0,
      skippedReason: "disabled",
    };
  } else if (!detectionMaskCanvas) {
    ocrPostFilterDebug = {
      mode: "balanced",
      ruleId: OCR_POST_FILTER_RULE_ID,
      candidateCount: 0,
      filteredCount: 0,
      filteredRegionIds: [],
      decisions: [],
      durationMs: 0,
      skippedReason: "no-mask",
    };
  } else {
    throwIfCancelled(signal);
    report(onProgress, "ocr_postfilter", "过滤 OCR 误识别");
    const t0 = performance.now();
    try {
      const result = await filterOcrRegions(
        image,
        detectionMaskCanvas,
        latestRegions,
        {
          platform,
          providerName: config.ocrEngine,
        },
      );
      throwIfCancelled(signal);
      latestRegions = result.regions;
      ocrPostFilterDebug = result.debug;
      logPipelineStage(config, "pipeline.ocr", "OCR 后处理完成", {
        ruleId: result.debug.ruleId,
        candidateCount: result.debug.candidateCount,
        filteredCount: result.debug.filteredCount,
        filteredRegionIds: result.debug.filteredRegionIds,
        durationMs: result.debug.durationMs,
      });
    } catch (error) {
      const detail = toErrorDetail(error);
      console.warn(`[ocr-postfilter] 后处理失败，保留全部区域: ${detail}`);
      ocrPostFilterDebug = {
        mode: "balanced",
        ruleId: OCR_POST_FILTER_RULE_ID,
        candidateCount: 0,
        filteredCount: 0,
        filteredRegionIds: [],
        decisions: [],
        durationMs: performance.now() - t0,
        skippedReason: "error",
        error: detail,
      };
      logPipelineStage(
        config,
        "pipeline.ocr",
        "OCR 后处理失败，已保留全部区域",
        undefined,
        error,
      );
    } finally {
      stageTimings.push({
        stage: "ocr_postfilter",
        label: "过滤 OCR 误识别",
        durationMs: performance.now() - t0,
      });
    }
  }

  throwIfCancelled(signal);
  report(onProgress, "order", "文本顺序排序");
  try {
    const t0 = performance.now();
    latestRegions = sortRegionsForRender(latestRegions, originalCanvas, platform);
    stageRegions.ordered = cloneTextRegions(latestRegions);
    stageTimings.push({ stage: "order", label: "文本顺序排序", durationMs: performance.now() - t0 });
  } catch (error) {
    throw new PipelineStageError("order", "顺序排序", toErrorDetail(error), buildArtifacts(), "image", error);
  }

  const orderedRegions = latestRegions;
  if (!orderedRegions.some((region) => region.sourceText.trim().length > 0)) {
    latestRegions = [];
    stageRegions.ocr = [];
    stageRegions.merged = [];
    stageRegions.ordered = [];
    cleanedCanvas = originalCanvas;
    resultCanvas = originalCanvas;
    report(onProgress, "done", "完成");
    return buildArtifacts();
  }
  if (stopAfterOrder) {
    report(onProgress, "done", "完成");
    return buildArtifacts();
  }

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

  const shouldSkipTranslate = config.processMode === 'erase' || config.processMode === 'original' || config.eraseDebug;

  const translateTask = shouldSkipTranslate
    ? Promise.resolve(orderedRegions)
    : (async (): Promise<PipelineArtifacts["detectedRegions"]> => {
        throwIfCancelled(signal);
        parallelTranslateStatus = "running";
        reportParallel();
        try {
          const t0 = performance.now();
          const translated = await runTranslate(orderedRegions, config, {
            signal,
            transport: options.translationTransport,
          });
          throwIfCancelled(signal);
          const translatedRegions = translated.regions;
          translateTiming = { stage: "translate", label: "\u7ffb\u8bd1\u4e3a\u4e2d\u6587", durationMs: performance.now() - t0 };
          translationDebug = translated.translationDebug;
          parallelTranslateStatus = "done";
          reportParallel();
          return translatedRegions;
        } catch (error) {
          if (hasPipelineFailure(error)) throw error;
          throw new PipelineStageError("translate", "\u7ffb\u8bd1", toErrorDetail(error), buildArtifacts(), "runtime", error);
        }
      })();

  const eraseTask = (async (): Promise<PipelineCanvas> => {
    throwIfCancelled(signal);
    if (!detectionMaskCanvas) {
      throw new PipelineStageError("mask_refine", "\u906e\u7f69\u7ec6\u5316", "\u68c0\u6d4b\u9636\u6bb5\u672a\u63d0\u4f9b\u539f\u59cb mask\uff0c\u5df2\u7981\u7528\u6587\u672c\u6846\u906e\u7f69\u56de\u9000", buildArtifacts(), "runtime");
    }

    parallelEraseStatus = "mask_refine";
    reportParallel();
    try {
      const t0 = performance.now();
      const regionsWithText = orderedRegions.filter(r => r.sourceText.trim() !== '');
      const refineResult = refineTextMask(originalCanvas, regionsWithText, detectionMaskCanvas, platform, {
        method: "fit_text",
        kernelSize: 3
      }, config.eraseDebug);
      throwIfCancelled(signal);
      refinedMaskCanvas = refineResult.refinedMaskCanvas;
      if (refineResult.debugLayers) {
        debugLayers = refineResult.debugLayers;
        eraseDebugCanvas = buildEraseDebugCanvas(originalCanvas, refineResult.debugLayers, platform, undefined);
      }
      maskRefineTiming = { stage: "mask_refine", label: "\u7ec6\u5316\u53bb\u5b57\u906e\u7f69", durationMs: performance.now() - t0 };
    } catch (error) {
      throw new PipelineStageError("mask_refine", "\u906e\u7f69\u7ec6\u5316", toErrorDetail(error), buildArtifacts(), "runtime", error);
    }

    parallelEraseStatus = "inpaint";
    reportParallel();
    try {
      const t0 = performance.now();
      if (!refinedMaskCanvas) {
        throw new Error("\u53bb\u5b57\u524d\u7f3a\u5c11 refined mask\uff0c\u5df2\u7981\u7528\u6587\u672c\u6846\u906e\u7f69\u56de\u9000");
      }
      const inpaintResult = await runInpaint(originalCanvas, refinedMaskCanvas, platform);
      throwIfCancelled(signal);
      const inpaintDurationMs = performance.now() - t0;
      inpaintTiming = { stage: "inpaint", label: "\u53bb\u5b57", durationMs: inpaintDurationMs };
      const inpaintRuntime = getRuntimeStage("inpaint");
      if (inpaintResult.actualProvider !== inpaintRuntime?.provider) {
        const providerLabel = inpaintResult.actualProvider === "webnn"
          ? `${inpaintResult.actualProvider}/${inpaintResult.actualWebnnDeviceType ?? "default"}`
          : inpaintResult.actualProvider;
        setRuntimeStage({
          model: "inpaint",
          enabled: true,
          provider: inpaintResult.actualProvider,
          webnnDeviceType: inpaintResult.actualWebnnDeviceType,
          detail: `inpaint \u63a8\u7406\u5df2\u56de\u9000\u5230 (${providerLabel})`
        });
      }
      logPipelineStage(config, "pipeline.inpaint", "去字推理完成", {
        provider: inpaintResult.actualProvider,
        webnnDeviceType: inpaintResult.actualWebnnDeviceType,
        durationMs: inpaintDurationMs,
      });
      parallelEraseStatus = "done";
      reportParallel();
      return inpaintResult.canvas;
    } catch (error) {
      logPipelineStage(config, "pipeline.inpaint", "去字推理失败", undefined, error);
      throw new PipelineStageError("inpaint", "\u53bb\u5b57", toErrorDetail(error), buildArtifacts(), "runtime", error);
    }
  })();

  try {
    const [translatedRegions, inpaintedCanvas] = await Promise.all([translateTask, eraseTask]);
    throwIfCancelled(signal);
    latestRegions = translatedRegions;
    cleanedCanvas = inpaintedCanvas;
    resultCanvas = cleanedCanvas;
    flushParallelTimings();
    const parallelLabel = shouldSkipTranslate ? "去字" : "并行处理(翻译 + 去字)";
    stageTimings.push({
      stage: "parallel",
      label: parallelLabel,
      durationMs: performance.now() - parallelT0
    });
  } catch (error) {
    await Promise.allSettled([translateTask, eraseTask]);
    flushParallelTimings();
    if (error instanceof PipelineStageError || hasPipelineFailure(error)) {
      throw error;
    }
    throw new PipelineStageError("parallel", "并行处理", toErrorDetail(error), buildArtifacts(), "runtime", error);
  }

  if (config.processMode === 'erase') {
    if (config.eraseDebug && debugLayers) {
      resultCanvas = buildEraseDebugCanvas(originalCanvas, debugLayers, platform, cleanedCanvas);
    } else {
      resultCanvas = cleanedCanvas;
    }
  } else {
    throwIfCancelled(signal);
    const typesetLabel = config.processMode === 'original' ? "排版原文" : "排版和嵌字";
    report(onProgress, "typeset", typesetLabel);
    try {
      const t0 = performance.now();
      const typesetResult = await drawTypeset(cleanedCanvas, latestRegions, config.targetLang, {
        debugMode: config.typesetDebug,
        renderText: true,
        collectDebugLog: false,
      }, platform);
      throwIfCancelled(signal);
      resultCanvas = typesetResult.canvas;
      if (config.eraseDebug && eraseDebugCanvas) {
        resultCanvas = eraseDebugCanvas;
      }
      if (config.collectDebugLog) {
        const debugOriginalTypeset = await drawTypeset(originalCanvas, latestRegions, config.targetLang, {
          debugMode: true,
          renderText: false,
          collectDebugLog: true,
        }, platform);
        throwIfCancelled(signal);
        debugOriginalCanvas = debugOriginalTypeset.canvas;
        typesetDebugLog = debugOriginalTypeset.debugLog;
      } else {
        debugOriginalCanvas = null;
        typesetDebugLog = null;
      }
      const durationMs = performance.now() - t0;
      stageTimings.push({ stage: "typeset", label: typesetLabel, durationMs });
      logPipelineStage(config, "pipeline.typeset", "排版完成", {
        mode: config.processMode,
        regionCount: latestRegions.length,
        durationMs,
        debugRegionCount: typesetDebugLog?.regions.length,
      });
    } catch (error) {
      logPipelineStage(config, "pipeline.typeset", "排版失败", undefined, error);
      throw new PipelineStageError("typeset", "排版", toErrorDetail(error), buildArtifacts(), "image", error);
    }
  }

  throwIfCancelled(signal);
  report(onProgress, "done", "完成");
  return buildArtifacts();
}
