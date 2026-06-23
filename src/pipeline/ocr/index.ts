import type { OcrRunDebugChunk, OcrRunDebugInfo, TextRegion } from "../../types";
import type { PlatformProvider, PipelineImage } from "../../runtime/platform";
import { disposeModelSession, getModel, getModelSession } from "../../runtime/modelRegistry";
import { isContextLostRuntimeError } from "../../runtime/onnxTypes";
import type { RuntimeProvider, WebNnDeviceType } from "../../runtime/onnxTypes";
import { runOcrSplitBatchDecode } from "../../runtime/onnxBridge";
import type {
  OcrBatchDecodeInputItem,
  OcrBatchDecodeOptions,
  OcrDecodeTelemetry,
  OcrSplitInputNameSet,
  OcrColorResult,
  WorkerSessionHandle,
} from "../../runtime/onnxWorkerTypes";
import { toErrorMessage } from "../../shared/utils";
import {
  OCR_CONFIDENCE_THRESHOLD,
  OCR_DECODE_BATCH_SIZE,
  loadCharset,
  findInputName,
} from "./ocrShared";
import {
  type Direction,
  type OcrInputData,
  generateTextDirection,
  buildOcrInput,
} from "./preprocess";
import {
  registerOcrProvider,
  registerOcrProviderAlias,
  getOcrProvider,
  fillMissingOcrFields,
} from "./provider";
import type { OcrRecognizeResult } from "./provider";
import { ocr48pxProvider } from "./ocr48pxProvider";
import { paddleocrV6MediumProvider } from "./paddleocrProvider";

registerOcrProvider(ocr48pxProvider);
registerOcrProvider(paddleocrV6MediumProvider);
registerOcrProviderAlias("builtin", "48px");
registerOcrProviderAlias("paddleocr", "paddleocr_v6_medium");
registerOcrProviderAlias("paddleocr_v6_small", "paddleocr_v6_medium");

export type OcrResult = {
  regions: TextRegion[];
  actualProvider: RuntimeProvider;
  actualWebnnDeviceType?: WebNnDeviceType;
  debug: OcrRunDebugInfo;
};

export type OcrInternalResult = {
  results: OcrRecognizeResult[];
  provider: RuntimeProvider;
  webnnDeviceType?: WebNnDeviceType;
  debug: OcrRunDebugInfo;
};

type OcrModel = Awaited<ReturnType<typeof getModel>>;

type OcrSplitSessionPair = {
  encoderHandle: WorkerSessionHandle;
  decoderHandle: WorkerSessionHandle;
  inputNames: OcrSplitInputNameSet;
};

type RunOcrOptions = {
  compactActiveBatch?: boolean;
};

type DecodedCandidate = {
  region: TextRegion;
  direction: Direction;
  text: string;
  confidence: number;
  tokenIds: number[];
  inputData: OcrInputData;
  validEncoderLength: number;
  colors?: OcrColorResult;
};

type PreparedCandidate = {
  region: TextRegion;
  direction: Direction;
  inputData: OcrInputData;
  validEncoderLength: number;
};

const isNodeRuntime = typeof process !== "undefined" && !!process.versions?.node;
let webGpuFixedBatchColdRunConsumed = false;

function resolveCompactActiveBatch(provider: RuntimeProvider, override?: boolean): boolean {
  if (typeof override === "boolean") {
    return override;
  }
  if (provider === "webgpu" && !webGpuFixedBatchColdRunConsumed) {
    return false;
  }
  return true;
}

function markFixedBatchColdRunConsumed(provider: RuntimeProvider, compactActiveBatch: boolean, override?: boolean): void {
  if (provider === "webgpu" && !compactActiveBatch && typeof override !== "boolean") {
    webGpuFixedBatchColdRunConsumed = true;
  }
}

function createOcrDebugInfo(mode: "autoregressive" | "ctc"): OcrRunDebugInfo {
  return {
    mode,
    candidateCount: 0,
    preparedCount: 0,
    preprocessTotalMs: 0,
    preprocessPerRegionMs: [],
    chunkBatchSize: OCR_DECODE_BATCH_SIZE,
    chunks: [],
    colorDecodeMode: "none",
    colorBatchSize: 0,
    colorSessionRunCount: 0,
    colorSessionRunTotalMs: 0,
    colorTotalMs: 0,
    colorFallbackRegions: [],
    fallbackTriggerCount: 0,
    totalSessionRunCount: 0,
    totalSessionRunMs: 0,
  };
}

function finalizeOcrDebugInfo(debugInfo: OcrRunDebugInfo): OcrRunDebugInfo {
  const decodeRunCount = debugInfo.chunks.reduce((acc, chunk) => acc + chunk.decodeSessionRunCount, 0);
  const decodeRunMs = debugInfo.chunks.reduce((acc, chunk) => acc + chunk.decodeSessionRunTotalMs, 0);
  debugInfo.totalSessionRunCount = decodeRunCount + debugInfo.colorSessionRunCount;
  debugInfo.totalSessionRunMs = decodeRunMs + debugInfo.colorSessionRunTotalMs;
  return debugInfo;
}

function createSplitInputNames(
  encoderHandle: WorkerSessionHandle,
  decoderHandle: WorkerSessionHandle
): OcrSplitInputNameSet | null {
  const encoderImageInput = findInputName(encoderHandle.inputNames, "image") ?? encoderHandle.inputNames[0];
  const encoderMaskInput = findInputName(encoderHandle.inputNames, "encoder_mask");
  const memoryOutput = encoderHandle.outputNames[0];
  const decoderMemoryInput = decoderHandle.inputNames.find((name) => name === memoryOutput) ?? decoderHandle.inputNames[0];
  const decoderCharIdxInput = findInputName(decoderHandle.inputNames, "char_idx");
  const decoderMaskInput = findInputName(decoderHandle.inputNames, "decoder_mask");
  const decoderEncoderMaskInput = findInputName(decoderHandle.inputNames, "encoder_mask");
  if (!encoderImageInput || !encoderMaskInput || !memoryOutput || !decoderMemoryInput || !decoderCharIdxInput || !decoderMaskInput || !decoderEncoderMaskInput) {
    return null;
  }
  return {
    encoderImageInput,
    encoderMaskInput,
    memoryOutput,
    decoderMemoryInput,
    decoderCharIdxInput,
    decoderMaskInput,
    decoderEncoderMaskInput,
  };
}

function getOcrProviderPlans(): RuntimeProvider[][] {
  return isNodeRuntime
    ? [["cuda", "cpu"], ["cpu"]]
    : [["webgpu", "webnn", "wasm"], ["webnn", "wasm"], ["wasm"]];
}

async function disposeOcrSplitSessions(): Promise<void> {
  await Promise.all([
    disposeModelSession("ocr_encoder"),
    disposeModelSession("ocr_decoder"),
  ]);
}

async function createOcrSplitSessionPair(preferred: RuntimeProvider[]): Promise<OcrSplitSessionPair> {
  try {
    const encoderHandle = await getModelSession("ocr_encoder", preferred);
    const decoderHandle = await getModelSession("ocr_decoder", [encoderHandle.provider]);
    if (encoderHandle.provider !== decoderHandle.provider) {
      throw new Error(`OCR split provider 不一致: encoder=${encoderHandle.provider}, decoder=${decoderHandle.provider}`);
    }
    const inputNames = createSplitInputNames(encoderHandle, decoderHandle);
    if (!inputNames) {
      throw new Error("OCR split 模型输入输出名称不完整");
    }
    return { encoderHandle, decoderHandle, inputNames };
  } catch (error) {
    await disposeOcrSplitSessions();
    throw error;
  }
}

function addTelemetryToChunk(chunkDebug: OcrRunDebugChunk, telemetry: OcrDecodeTelemetry): void {
  chunkDebug.encoderRunMs = (chunkDebug.encoderRunMs ?? 0) + (telemetry.encoderRunMs ?? 0);
  chunkDebug.decoderRunMs = (chunkDebug.decoderRunMs ?? 0) + (telemetry.decoderRunMs ?? 0);
  chunkDebug.decodeSessionRunCount += telemetry.sessionRunCount;
  chunkDebug.decodeSessionRunTotalMs += telemetry.sessionRunTotalMs;
  chunkDebug.decodeSteps.push(...telemetry.steps);
}

function createBatchItems(chunk: PreparedCandidate[]): OcrBatchDecodeInputItem[] {
  return chunk.map((candidate) => ({
    regionId: candidate.region.id,
    imageData: candidate.inputData.data,
    imageDims: candidate.inputData.dims,
    validEncoderLength: candidate.validEncoderLength,
  }));
}

function acceptBatchResults(
  chunk: PreparedCandidate[],
  batchItems: OcrBatchDecodeInputItem[],
  results: Awaited<ReturnType<typeof runOcrSplitBatchDecode>>["items"],
  chunkDebug: OcrRunDebugChunk,
  decoded: DecodedCandidate[]
): number {
  let acceptedConfidenceSum = 0;
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    const candidate = chunk[i];
    if (!candidate || result.regionId !== batchItems[i]?.regionId) {
      continue;
    }
    if (result.text.length > 0 && result.confidence >= OCR_CONFIDENCE_THRESHOLD) {
      chunkDebug.decodeAccepted += 1;
      acceptedConfidenceSum += result.confidence;
      decoded.push({
        region: candidate.region,
        direction: candidate.direction,
        text: result.text,
        confidence: result.confidence,
        tokenIds: result.tokenIds,
        inputData: candidate.inputData,
        validEncoderLength: result.validEncoderLength,
        colors: result.colors,
      });
    }
  }
  return acceptedConfidenceSum;
}

async function decodeSplitChunk(
  sessions: OcrSplitSessionPair,
  chunk: PreparedCandidate[],
  options: OcrBatchDecodeOptions,
  chunkDebug: OcrRunDebugChunk,
  decoded: DecodedCandidate[]
): Promise<void> {
  let chunkConfidenceSum = 0;
  const batchItems = createBatchItems(chunk);
  try {
    const batchDecode = await runOcrSplitBatchDecode(
      sessions.encoderHandle.sessionId,
      sessions.decoderHandle.sessionId,
      sessions.inputNames,
      batchItems,
      options
    );
    chunkDebug.encoderCache = true;
    addTelemetryToChunk(chunkDebug, batchDecode.telemetry);
    chunkConfidenceSum += acceptBatchResults(chunk, batchItems, batchDecode.items, chunkDebug, decoded);
  } catch (error) {
    if (isContextLostRuntimeError(error)) {
      throw error;
    }

    debugFallbackChunk(chunkDebug);
    for (const candidate of chunk) {
      const fallbackT0 = performance.now();
      const singleItems = createBatchItems([candidate]);
      try {
        const singleDecode = await runOcrSplitBatchDecode(
          sessions.encoderHandle.sessionId,
          sessions.decoderHandle.sessionId,
          sessions.inputNames,
          singleItems,
          options
        );
        const fallbackDurationMs = performance.now() - fallbackT0;
        addTelemetryToChunk(chunkDebug, singleDecode.telemetry);
        const confidenceSum = acceptBatchResults([candidate], singleItems, singleDecode.items, chunkDebug, decoded);
        chunkConfidenceSum += confidenceSum;
        const result = singleDecode.items[0];
        const accepted = !!result && result.text.length > 0 && result.confidence >= OCR_CONFIDENCE_THRESHOLD;
        chunkDebug.fallbackRegions.push({
          regionId: candidate.region.id,
          durationMs: fallbackDurationMs,
          accepted,
          confidence: result?.confidence,
        });
      } catch (innerError) {
        if (isContextLostRuntimeError(innerError)) {
          throw innerError;
        }
        chunkDebug.fallbackRegions.push({
          regionId: candidate.region.id,
          durationMs: performance.now() - fallbackT0,
          accepted: false,
          error: toErrorMessage(innerError),
        });
      }
    }
  }

  if (chunkDebug.decodeAccepted > 0) {
    chunkDebug.decodeConfidenceAvg = chunkConfidenceSum / chunkDebug.decodeAccepted;
  }
}

function debugFallbackChunk(chunkDebug: OcrRunDebugChunk): void {
  chunkDebug.decodeMode = "fallback";
}

async function runOcrByOnnxWithSplitSessions(
  image: PipelineImage,
  detectedRegions: TextRegion[],
  model: OcrModel,
  sessions: OcrSplitSessionPair,
  platform: PlatformProvider,
  options?: {
    compactActiveBatch?: boolean;
  }
): Promise<{ results: OcrRecognizeResult[]; debug: OcrRunDebugInfo }> {
  const charset = await loadCharset(model.dictUrl);
  const inputHeight = model.input?.[0] ?? 48;
  const inputWidth = model.input?.[1] ?? 320;
  const normalize = model.normalize ?? "minus_one_to_one";
  const seqLen = 64;
  const encoderLen = 80;
  const maxSteps = Math.max(1, seqLen - 1);
  const debugInfo = createOcrDebugInfo("autoregressive");
  const candidates = generateTextDirection(detectedRegions);
  debugInfo.candidateCount = candidates.length;
  const compactActiveBatch = resolveCompactActiveBatch(sessions.encoderHandle.provider, options?.compactActiveBatch);

  const prepared: PreparedCandidate[] = [];
  const preprocessT0 = performance.now();
  for (const item of candidates) {
    const { region, direction } = item;
    const regionPreprocessT0 = performance.now();
    try {
      const inputData = buildOcrInput(image, region, direction, inputHeight, inputWidth, normalize, platform);
      const validEncoderLength = Math.min(encoderLen, Math.floor((inputData.resizedWidth + 3) / 4) + 2);
      prepared.push({ region, direction, inputData, validEncoderLength });
    } catch {
      // Skip regions that fail preprocessing.
    }
    debugInfo.preprocessPerRegionMs.push({
      regionId: region.id,
      durationMs: performance.now() - regionPreprocessT0,
    });
  }
  debugInfo.preprocessTotalMs = performance.now() - preprocessT0;
  debugInfo.preparedCount = prepared.length;

  const decoded: DecodedCandidate[] = [];
  for (let chunkStart = 0; chunkStart < prepared.length; chunkStart += OCR_DECODE_BATCH_SIZE) {
    const chunk = prepared.slice(chunkStart, chunkStart + OCR_DECODE_BATCH_SIZE);
    const chunkDebug: OcrRunDebugChunk = {
      chunkIndex: Math.floor(chunkStart / OCR_DECODE_BATCH_SIZE),
      chunkSize: chunk.length,
      regionIds: chunk.map((candidate) => candidate.region.id),
      decodeMode: "batch",
      encoderCache: true,
      compactActiveBatch,
      decodeAccepted: 0,
      decodeSessionRunCount: 0,
      decodeSessionRunTotalMs: 0,
      decodeSteps: [],
      fallbackRegions: [],
    };
    debugInfo.chunks.push(chunkDebug);
    await decodeSplitChunk(
      sessions,
      chunk,
      { seqLen, encoderLen, maxSteps, charset, inputHeight, inputWidth, compactActiveBatch },
      chunkDebug,
      decoded
    );
    if (chunkDebug.decodeMode === "fallback") {
      debugInfo.fallbackTriggerCount += 1;
    }
  }
  if (prepared.length > 0) {
    markFixedBatchColdRunConsumed(sessions.encoderHandle.provider, compactActiveBatch, options?.compactActiveBatch);
  }

  if (decoded.length === 0) {
    return { results: [], debug: finalizeOcrDebugInfo(debugInfo) };
  }

  const missingColorCandidates = decoded.filter((candidate) => !candidate.colors);
  debugInfo.colorBatchSize = decoded.length;
  if (missingColorCandidates.length === 0) {
    debugInfo.colorDecodeMode = "reuse";
  } else {
    debugInfo.colorDecodeMode = "fallback";
    debugInfo.colorFallbackRegions = missingColorCandidates.map((candidate) => ({
      regionId: candidate.region.id,
      durationMs: 0,
      accepted: false,
      error: "模型未返回颜色，后续使用图像采样兜底",
    }));
  }

  const ocrResults: OcrRecognizeResult[] = decoded.map((candidate) => ({
    text: candidate.text,
    confidence: candidate.confidence,
    quad: candidate.region.quad ?? [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
    direction: candidate.direction,
    fgColor: candidate.colors?.fgColor,
    bgColor: candidate.colors?.bgColor,
  }));

  return { results: ocrResults, debug: finalizeOcrDebugInfo(debugInfo) };
}

export async function runOcrByOnnxInternal(
  image: PipelineImage,
  detectedRegions: TextRegion[],
  platform: PlatformProvider,
  options?: {
    compactActiveBatch?: boolean;
  }
): Promise<OcrInternalResult> {
  const model = await getModel("ocr_decoder");
  let lastError: unknown = null;
  const attemptedProviders = new Set<RuntimeProvider>();

  for (const preferred of getOcrProviderPlans()) {
    let sessions: OcrSplitSessionPair | null = null;
    try {
      sessions = await createOcrSplitSessionPair(preferred);
      const provider = sessions.encoderHandle.provider;
      if (attemptedProviders.has(provider)) {
        await disposeOcrSplitSessions();
        continue;
      }
      attemptedProviders.add(provider);
      const result = await runOcrByOnnxWithSplitSessions(image, detectedRegions, model, sessions, platform, options);
      return {
        results: result.results,
        provider,
        webnnDeviceType: sessions.encoderHandle.webnnDeviceType,
        debug: result.debug,
      };
    } catch (error) {
      lastError = error;
      const providerLabel = sessions?.encoderHandle.provider ?? preferred.join(",");
      const reason = isContextLostRuntimeError(error) ? "context lost" : "run failed";
      console.warn(`[ocr] split ${providerLabel} ${reason}，尝试回退: ${toErrorMessage(error)}`);
      await disposeOcrSplitSessions();
    }
  }

  const fallbackMessage = lastError ? toErrorMessage(lastError) : "未知错误";
  throw new Error(`OCR split 推理失败: ${fallbackMessage}`);
}

function mapResultsToRegions(results: OcrRecognizeResult[], detectedRegions: TextRegion[]): TextRegion[] {
  return results.map((result, index) => ({
    id: detectedRegions[index]?.id ?? `ocr-${index}`,
    box: detectedRegions[index]?.box ?? { x: 0, y: 0, width: 0, height: 0 },
    quad: result.quad,
    direction: result.direction,
    prob: result.confidence,
    fgColor: result.fgColor,
    bgColor: result.bgColor,
    sourceText: result.text,
    translatedText: "",
  }));
}

function createDefaultDebug(resultCount: number): OcrRunDebugInfo {
  return {
    mode: "ctc",
    candidateCount: resultCount,
    preparedCount: resultCount,
    preprocessTotalMs: 0,
    preprocessPerRegionMs: [],
    chunkBatchSize: 0,
    chunks: [],
    colorDecodeMode: "none",
    colorBatchSize: 0,
    colorSessionRunCount: 0,
    colorSessionRunTotalMs: 0,
    colorTotalMs: 0,
    colorFallbackRegions: [],
    fallbackTriggerCount: 0,
    totalSessionRunCount: 0,
    totalSessionRunMs: 0,
  };
}

function addExternalColorFillDebug(
  debugInfo: OcrRunDebugInfo,
  results: OcrRecognizeResult[],
  detectedRegions: TextRegion[],
  durationMs: number
): OcrRunDebugInfo {
  const missingColorResults = results.filter((result) => result.fgColor === undefined || result.bgColor === undefined);
  debugInfo.colorBatchSize = results.length;
  debugInfo.colorTotalMs += durationMs;
  if (debugInfo.paddle) {
    debugInfo.paddle.colorFillMs = (debugInfo.paddle.colorFillMs ?? 0) + durationMs;
  }
  if (missingColorResults.length > 0) {
    debugInfo.colorDecodeMode = "fallback";
    debugInfo.colorFallbackRegions = missingColorResults.map((result, index) => ({
      regionId: detectedRegions[results.indexOf(result)]?.id ?? `ocr-${index}`,
      durationMs: 0,
      accepted: true,
      error: "模型未返回颜色，使用图像采样补齐",
    }));
  } else if (results.length > 0 && debugInfo.colorDecodeMode === "none") {
    debugInfo.colorDecodeMode = "reuse";
  }
  return debugInfo;
}

function normalizeOcrProviderName(providerName?: string): string {
  if (!providerName || providerName === "builtin") {
    return "48px";
  }
  return providerName;
}

export async function runOcr(
  image: PipelineImage,
  detectedRegions: TextRegion[],
  providerName?: string,
  platform?: PlatformProvider,
  options?: RunOcrOptions
): Promise<OcrResult> {
  const providerNameResolved = normalizeOcrProviderName(providerName);
  const provider = getOcrProvider(providerNameResolved);
  if (!provider) throw new Error(`OCR 引擎未注册: ${providerNameResolved}`);

  if (providerNameResolved === "48px") {
    const internal = await runOcrByOnnxInternal(image, detectedRegions, platform!, options);
    const filled = fillMissingOcrFields(internal.results, image, platform);
    const regions = mapResultsToRegions(filled, detectedRegions);
    if (regions.length > 0) {
      return {
        regions,
        actualProvider: internal.provider,
        actualWebnnDeviceType: internal.webnnDeviceType,
        debug: internal.debug,
      };
    }
    throw new Error("OCR ONNX 未返回有效识别结果");
  }

  const output = await provider.recognize(image, detectedRegions, platform);
  const colorFillT0 = performance.now();
  const filled = fillMissingOcrFields(output.results, image, platform);
  const colorFillMs = performance.now() - colorFillT0;
  const debug = addExternalColorFillDebug(
    output.debug ?? createDefaultDebug(output.results.length),
    output.results,
    detectedRegions,
    colorFillMs
  );
  const regions = mapResultsToRegions(filled, detectedRegions);
  if (regions.length > 0) {
    return {
      regions,
      actualProvider: output.provider,
      actualWebnnDeviceType: output.webnnDeviceType,
      debug,
    };
  }
  throw new Error("OCR 未返回有效识别结果");
}
