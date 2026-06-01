import type { OcrRunDebugChunk, OcrRunDebugInfo, TextRegion } from "../../types";
import type { PlatformProvider, PipelineImage } from "../../runtime/platform";
import { getModel, getModelSession } from "../../runtime/modelRegistry";
import { isContextLostRuntimeError } from "../../runtime/onnxTypes";
import type { RuntimeProvider, WebNnDeviceType } from "../../runtime/onnxTypes";
import { runInference, runOcrBatchDecode, runOcrSplitBatchDecode, runOcrSingleDecode, runOcrColorBatch, runOcrColorSingle } from "../../runtime/onnxBridge";
import type { WorkerSessionHandle, TensorTransport, OcrInputNameSet, OcrSplitInputNameSet, OcrBatchDecodeInputItem, OcrColorBatchInputItem, OcrColorResult } from "../../runtime/onnxWorkerTypes";
import { toErrorMessage } from "../../shared/utils";
import { normalizeTextLight } from "../utils";
import {
  OCR_CONFIDENCE_THRESHOLD,
  OCR_DECODE_BATCH_SIZE,
  loadCharset,
  findInputName,
} from "./ocrShared";
import { decodeCtcGreedy, tokenToText } from "./decodeCtc";
import {
  type Direction,
  type OcrInputData,
  generateTextDirection,
  buildOcrInput,
} from "./preprocess";
import { registerOcrProvider, getOcrProvider, fillMissingOcrFields } from "./provider";
import type { OcrRecognizeResult } from "./provider";
import { builtinOcrProvider } from "./builtinProvider";
import { paddleocrProvider } from "./paddleocrProvider";

registerOcrProvider(builtinOcrProvider);
registerOcrProvider(paddleocrProvider);

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

function createOcrDebugInfo(mode: 'autoregressive' | 'ctc'): OcrRunDebugInfo {
  return {
    mode,
    candidateCount: 0,
    preparedCount: 0,
    preprocessTotalMs: 0,
    preprocessPerRegionMs: [],
    chunkBatchSize: OCR_DECODE_BATCH_SIZE,
    chunks: [],
    colorDecodeMode: 'none',
    colorBatchSize: 0,
    colorSessionRunCount: 0,
    colorSessionRunTotalMs: 0,
    colorTotalMs: 0,
    colorFallbackRegions: [],
    fallbackTriggerCount: 0,
    totalSessionRunCount: 0,
    totalSessionRunMs: 0
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

async function runOcrByOnnxWithSession(
  image: PipelineImage,
  detectedRegions: TextRegion[],
  model: Awaited<ReturnType<typeof getModel>>,
  sessionHandle: WorkerSessionHandle,
  platform: PlatformProvider,
): Promise<{ results: OcrRecognizeResult[]; debug: OcrRunDebugInfo }> {
  const charset = await loadCharset(model.dictUrl);
  const inputHeight = model.input?.[0] ?? 48;
  const inputWidth = model.input?.[1] ?? 320;
  const normalize = model.normalize ?? "minus_one_to_one";
  const imageInput = sessionHandle.inputNames[0];
  const debugInfo = createOcrDebugInfo("ctc");
  if (!imageInput) {
    return { results: [], debug: finalizeOcrDebugInfo(debugInfo) };
  }

  const charIdxInput = findInputName(sessionHandle.inputNames, "char_idx");
  const decoderMaskInput = findInputName(sessionHandle.inputNames, "decoder_mask");
  const encoderMaskInput = findInputName(sessionHandle.inputNames, "encoder_mask");

  if (charIdxInput && decoderMaskInput && encoderMaskInput) {
    debugInfo.mode = "autoregressive";
    const seqLen = 64; // getInputDim fallback: char_idx input dim at axis 1
    const encoderLen = 80; // getInputDim fallback: encoder_mask input dim at axis 1
    const maxSteps = Math.max(1, seqLen - 1);
    const inputNames: OcrInputNameSet = { imageInput, charIdxInput, decoderMaskInput, encoderMaskInput };
    let splitDecode: {
      encoderHandle: WorkerSessionHandle;
      decoderHandle: WorkerSessionHandle;
      inputNames: OcrSplitInputNameSet;
    } | null = null;
    try {
      const [encoderHandle, decoderHandle] = await Promise.all([
        getModelSession("ocr_encoder", [sessionHandle.provider]),
        getModelSession("ocr_decoder", [sessionHandle.provider]),
      ]);
      const splitInputNames = createSplitInputNames(encoderHandle, decoderHandle);
      if (splitInputNames) {
        splitDecode = { encoderHandle, decoderHandle, inputNames: splitInputNames };
      }
    } catch (error) {
      console.warn(`[ocr] encoder cache 模型不可用，继续使用 full AR: ${toErrorMessage(error)}`);
    }

    const candidates = generateTextDirection(detectedRegions);
    debugInfo.candidateCount = candidates.length;

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
    const decoded: DecodedCandidate[] = [];

    type PreparedCandidate = {
      region: TextRegion;
      direction: Direction;
      inputData: OcrInputData;
      validEncoderLength: number;
    };
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
        durationMs: performance.now() - regionPreprocessT0
      });
    }
    debugInfo.preprocessTotalMs = performance.now() - preprocessT0;
    debugInfo.preparedCount = prepared.length;

    // Process in batches of OCR_DECODE_BATCH_SIZE.
    for (let chunkStart = 0; chunkStart < prepared.length; chunkStart += OCR_DECODE_BATCH_SIZE) {
      const chunk = prepared.slice(chunkStart, chunkStart + OCR_DECODE_BATCH_SIZE);
      const chunkDebug: OcrRunDebugChunk = {
        chunkIndex: Math.floor(chunkStart / OCR_DECODE_BATCH_SIZE),
        chunkSize: chunk.length,
        regionIds: chunk.map((c) => c.region.id),
        decodeMode: 'batch',
        decodeAccepted: 0,
        decodeSessionRunCount: 0,
        decodeSessionRunTotalMs: 0,
        decodeSteps: [],
        fallbackRegions: []
      };
      debugInfo.chunks.push(chunkDebug);
      let chunkConfidenceSum = 0;
      try {
        const batchItems: OcrBatchDecodeInputItem[] = chunk.map((c) => ({
          regionId: c.region.id,
          imageData: c.inputData.data,
          imageDims: c.inputData.dims,
          validEncoderLength: c.validEncoderLength
        }));
        const batchDecode = splitDecode
          ? await runOcrSplitBatchDecode(
            splitDecode.encoderHandle.sessionId,
            splitDecode.decoderHandle.sessionId,
            splitDecode.inputNames,
            batchItems,
            { seqLen, encoderLen, maxSteps, charset, inputHeight, inputWidth }
          )
          : await runOcrBatchDecode(
            sessionHandle.sessionId,
            inputNames,
            batchItems,
            { seqLen, encoderLen, maxSteps, charset, inputHeight, inputWidth }
          );
        chunkDebug.encoderCache = !!splitDecode;
        chunkDebug.encoderRunMs = batchDecode.telemetry.encoderRunMs;
        chunkDebug.decoderRunMs = batchDecode.telemetry.decoderRunMs;
        chunkDebug.decodeSessionRunCount = batchDecode.telemetry.sessionRunCount;
        chunkDebug.decodeSessionRunTotalMs = batchDecode.telemetry.sessionRunTotalMs;
        chunkDebug.decodeSteps = batchDecode.telemetry.steps;
        const batchResults = batchDecode.items;
        for (let i = 0; i < batchResults.length; i += 1) {
          const result = batchResults[i];
          const candidate = chunk[i];
          if (result.text.length > 0 && result.confidence >= OCR_CONFIDENCE_THRESHOLD) {
            chunkDebug.decodeAccepted += 1;
            chunkConfidenceSum += result.confidence;
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
        if (chunkDebug.decodeAccepted > 0) {
          chunkDebug.decodeConfidenceAvg = chunkConfidenceSum / chunkDebug.decodeAccepted;
        }
      } catch (error) {
        if (isContextLostRuntimeError(error)) {
          throw error;
        }
        // Fallback: decode this chunk one-by-one via Worker single-region decode.
        debugInfo.fallbackTriggerCount += 1;
        chunkDebug.decodeMode = 'fallback';
        for (const candidate of chunk) {
          const fallbackT0 = performance.now();
          try {
            const singleDecode = await runOcrSingleDecode(
              sessionHandle.sessionId,
              inputNames,
              candidate.inputData.data,
              candidate.inputData.dims,
              candidate.validEncoderLength,
              { seqLen, encoderLen, maxSteps, charset }
            );
            const fallbackDurationMs = performance.now() - fallbackT0;
            chunkDebug.decodeSessionRunCount += singleDecode.telemetry.sessionRunCount;
            chunkDebug.decodeSessionRunTotalMs += singleDecode.telemetry.sessionRunTotalMs;
            chunkDebug.decodeSteps.push(...singleDecode.telemetry.steps);
            const result = singleDecode.output;
            const accepted = !!result && result.text.length > 0 && result.confidence >= OCR_CONFIDENCE_THRESHOLD;
            chunkDebug.fallbackRegions.push({
              regionId: candidate.region.id,
              durationMs: fallbackDurationMs,
              accepted,
              confidence: result?.confidence
            });
            if (result && result.text.length > 0 && result.confidence >= OCR_CONFIDENCE_THRESHOLD) {
              chunkDebug.decodeAccepted += 1;
              chunkConfidenceSum += result.confidence;
              decoded.push({
                region: candidate.region,
                direction: candidate.direction,
                text: result.text,
                confidence: result.confidence,
                tokenIds: result.tokenIds,
                inputData: candidate.inputData,
                validEncoderLength: candidate.validEncoderLength
              });
            }
          } catch (innerError) {
            if (isContextLostRuntimeError(innerError)) {
              throw innerError;
            }
            chunkDebug.fallbackRegions.push({
              regionId: candidate.region.id,
              durationMs: performance.now() - fallbackT0,
              accepted: false,
              error: toErrorMessage(innerError)
            });
            continue;
          }
        }
        if (chunkDebug.decodeAccepted > 0) {
          chunkDebug.decodeConfidenceAvg = chunkConfidenceSum / chunkDebug.decodeAccepted;
        }
      }
    }

    if (decoded.length === 0) {
      return { results: [], debug: finalizeOcrDebugInfo(debugInfo) };
    }

    // Phase 2: batch color decoding for all successfully decoded regions.
    const colorItems: OcrColorBatchInputItem[] = decoded.map((d) => ({
      imageData: d.inputData.data,
      imageDims: d.inputData.dims,
      validEncoderLength: d.validEncoderLength,
      tokenIds: d.tokenIds
    }));

    let batchColors: (OcrColorResult | null)[];
    debugInfo.colorBatchSize = colorItems.length;
    if (decoded.every((d) => d.colors)) {
      debugInfo.colorDecodeMode = 'reuse';
      debugInfo.colorTotalMs = 0;
      batchColors = decoded.map((d) => d.colors ?? null);
    } else {
      const colorT0 = performance.now();
      try {
        debugInfo.colorDecodeMode = 'batch';
        const colorBatch = await runOcrColorBatch(
          sessionHandle.sessionId,
          inputNames,
          colorItems,
          seqLen,
          encoderLen,
          inputHeight,
          inputWidth
        );
        batchColors = colorBatch.colors;
        debugInfo.colorSessionRunCount += colorBatch.telemetry.sessionRunCount;
        debugInfo.colorSessionRunTotalMs += colorBatch.telemetry.sessionRunTotalMs;
      } catch (error) {
        if (isContextLostRuntimeError(error)) {
          throw error;
        }
        // Fall back to per-region color decode on batch failure.
        debugInfo.fallbackTriggerCount += 1;
        debugInfo.colorDecodeMode = 'fallback';
        batchColors = [];
        for (const d of decoded) {
          const fallbackT0 = performance.now();
          try {
            const colorSingle = await runOcrColorSingle(
              sessionHandle.sessionId,
              inputNames,
              d.inputData.data,
              d.inputData.dims,
              d.validEncoderLength,
              d.tokenIds,
              seqLen,
              encoderLen
            );
            const colors = colorSingle.color;
            debugInfo.colorSessionRunCount += colorSingle.telemetry.sessionRunCount;
            debugInfo.colorSessionRunTotalMs += colorSingle.telemetry.sessionRunTotalMs;
            batchColors.push(colors);
            debugInfo.colorFallbackRegions.push({
              regionId: d.region.id,
              durationMs: performance.now() - fallbackT0,
              accepted: colors !== null
            });
          } catch {
            batchColors.push(null);
            debugInfo.colorFallbackRegions.push({
              regionId: d.region.id,
              durationMs: performance.now() - fallbackT0,
              accepted: false
            });
          }
        }
      }
      debugInfo.colorTotalMs = performance.now() - colorT0;
    }

    const ocrResults: OcrRecognizeResult[] = [];
    for (let i = 0; i < decoded.length; i += 1) {
      const d = decoded[i];
      const colors = batchColors[i] ?? null;
      ocrResults.push({
        text: d.text,
        confidence: d.confidence,
        quad: d.region.quad ?? [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
        direction: d.direction,
        fgColor: colors?.fgColor,
        bgColor: colors?.bgColor,
      });
    }

    return { results: ocrResults, debug: finalizeOcrDebugInfo(debugInfo) };
  }

  // CTC path — use Worker for inference, main thread for postprocessing.
  const ocrResults: OcrRecognizeResult[] = [];
  const candidates = generateTextDirection(detectedRegions);
  debugInfo.candidateCount = candidates.length;
  const preprocessT0 = performance.now();
  for (const item of candidates) {
    const { region, direction } = item;
    let bestText = "";
    let bestLength = 0;
    const regionPreprocessT0 = performance.now();
    const { data: inputData, dims: inputDims } = buildOcrInput(image, region, direction, inputHeight, inputWidth, normalize, platform);
    debugInfo.preprocessPerRegionMs.push({
      regionId: region.id,
      durationMs: performance.now() - regionPreprocessT0
    });
    debugInfo.preparedCount += 1;
    let outputTensors: Record<string, TensorTransport>;
    try {
      const runT0 = performance.now();
      const result = await runInference(sessionHandle.sessionId, { [imageInput]: { data: inputData, dims: inputDims, type: "float32" } });
      if (result.error) throw new Error(result.error);
      outputTensors = result.outputs;
      const runDurationMs = performance.now() - runT0;
      const chunkDebug: OcrRunDebugChunk = {
        chunkIndex: debugInfo.chunks.length,
        chunkSize: 1,
        regionIds: [region.id],
        decodeMode: 'batch',
        decodeAccepted: 0,
        decodeSessionRunCount: 1,
        decodeSessionRunTotalMs: runDurationMs,
        decodeSteps: [{ step: 0, activeCount: 1, durationMs: runDurationMs }],
        fallbackRegions: []
      };
      debugInfo.chunks.push(chunkDebug);
    } catch (error) {
      if (isContextLostRuntimeError(error)) {
        throw error;
      }
      continue;
    }

    // Pick logits from output tensors (adapted for TensorTransport)
    let logitsTensor: TensorTransport | null = null;
    for (const value of Object.values(outputTensors)) {
      if (value.dims.length === 3 && value.dims[0] === 1) {
        logitsTensor = value;
        break;
      }
    }
    if (!logitsTensor) {
      continue;
    }
    const dims = logitsTensor.dims;
    let steps = 0;
    let classes = 0;
    let logits: Float32Array | null = null;
    const raw = logitsTensor.data;
    if (raw instanceof Float32Array) {
      if (dims[1] > dims[2]) {
        classes = dims[1];
        steps = dims[2];
        logits = new Float32Array(steps * classes);
        for (let c = 0; c < classes; c += 1) {
          for (let t = 0; t < steps; t += 1) {
            logits[t * classes + c] = raw[c * steps + t];
          }
        }
      } else {
        steps = dims[1];
        classes = dims[2];
        logits = raw;
      }
    }
    if (!logits || steps <= 0 || classes <= 1) {
      continue;
    }
    const ids = decodeCtcGreedy(logits, steps, classes);
    const text = normalizeTextLight(ids.map((id) => tokenToText(id, charset)).join(""));
    if (text.length > bestLength) {
      bestText = text;
      bestLength = text.length;
    }

    if (bestText.length > 0) {
      const chunk = debugInfo.chunks[debugInfo.chunks.length - 1];
      if (chunk) {
        chunk.decodeAccepted = 1;
      }
      ocrResults.push({
        text: bestText,
        confidence: 1,
        quad: region.quad ?? [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }],
        direction,
      });
    }
  }
  debugInfo.preprocessTotalMs = performance.now() - preprocessT0;
  return { results: ocrResults, debug: finalizeOcrDebugInfo(debugInfo) };
}

export async function runOcrByOnnxInternal(image: PipelineImage, detectedRegions: TextRegion[], platform: PlatformProvider): Promise<OcrInternalResult> {
  const model = await getModel("ocr");
  const primaryHandle = await getModelSession("ocr", ["webgpu", "webnn", "wasm"]);

  let actualProvider: RuntimeProvider = primaryHandle.provider;
  let actualWebnnDeviceType = primaryHandle.webnnDeviceType;

  try {
    const result = await runOcrByOnnxWithSession(image, detectedRegions, model, primaryHandle, platform);
    return { results: result.results, provider: actualProvider, webnnDeviceType: actualWebnnDeviceType, debug: result.debug };
  } catch (error) {
    const message = toErrorMessage(error);
    const reason = isContextLostRuntimeError(error) ? "context lost" : "run failed";
    if (primaryHandle.provider === "wasm") {
      throw error;
    }

    const fallbackPlans: RuntimeProvider[][] = [];
    if (primaryHandle.provider === "webgpu") {
      fallbackPlans.push(["webnn", "wasm"]);
    }
    fallbackPlans.push(["wasm"]);

    let recovered: OcrRecognizeResult[] | null = null;
    let lastFallbackError: unknown = null;
    let fallbackDebug: OcrRunDebugInfo = createOcrDebugInfo('ctc');
    console.warn(`[ocr] ${primaryHandle.provider} ${reason}, 尝试回退: ${message}`);

    for (const preferred of fallbackPlans) {
      try {
        const handle = await getModelSession("ocr", preferred);
        const result = await runOcrByOnnxWithSession(image, detectedRegions, model, handle, platform);
        recovered = result.results;
        fallbackDebug = result.debug;
        if (handle.provider !== primaryHandle.provider) {
          console.warn(`[ocr] 已回退到 ${handle.provider}`);
          actualProvider = handle.provider;
          actualWebnnDeviceType = handle.webnnDeviceType;
        }
        break;
      } catch (fallbackError) {
        lastFallbackError = fallbackError;
      }
    }

    if (!recovered) {
      const fallbackMessage = lastFallbackError ? toErrorMessage(lastFallbackError) : "未知错误";
      throw new Error(`OCR 推理失败且回退失败: ${message} | fallback: ${fallbackMessage}`);
    }

    return { results: recovered, provider: actualProvider, webnnDeviceType: actualWebnnDeviceType, debug: fallbackDebug };
  }
}

function mapResultsToRegions(results: OcrRecognizeResult[], detectedRegions: TextRegion[]): TextRegion[] {
  return results.map((r, i) => ({
    id: detectedRegions[i]?.id ?? `ocr-${i}`,
    box: detectedRegions[i]?.box ?? { x: 0, y: 0, width: 0, height: 0 },
    quad: r.quad,
    direction: r.direction,
    prob: r.confidence,
    fgColor: r.fgColor,
    bgColor: r.bgColor,
    sourceText: r.text,
    translatedText: '',
  }));
}

function createDefaultDebug(resultCount: number): OcrRunDebugInfo {
  return {
    mode: 'ctc',
    candidateCount: resultCount,
    preparedCount: resultCount,
    preprocessTotalMs: 0,
    preprocessPerRegionMs: [],
    chunkBatchSize: 0,
    chunks: [],
    colorDecodeMode: 'none',
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

export async function runOcr(
  image: PipelineImage,
  detectedRegions: TextRegion[],
  providerName?: string,
  platform?: PlatformProvider,
): Promise<OcrResult> {
  const providerNameResolved = providerName ?? 'builtin';
  const provider = getOcrProvider(providerNameResolved);
  if (!provider) throw new Error(`OCR 引擎未注册: ${providerNameResolved}`);

  if (providerNameResolved === 'builtin') {
    // builtin path: preserve full debug and runtime info
    const internal = await runOcrByOnnxInternal(image, detectedRegions, platform!);
    const filled = fillMissingOcrFields(internal.results, image, platform);
    const regions = mapResultsToRegions(filled, detectedRegions);
    if (regions.length > 0) {
      return { regions, actualProvider: internal.provider, actualWebnnDeviceType: internal.webnnDeviceType, debug: internal.debug };
    }
    throw new Error("OCR ONNX 未返回有效识别结果");
  }

  // other provider path
  const output = await provider.recognize(image, detectedRegions, platform);
  const filled = fillMissingOcrFields(output.results, image, platform);
  const regions = mapResultsToRegions(filled, detectedRegions);
  if (regions.length > 0) {
    return { regions, actualProvider: output.provider, actualWebnnDeviceType: output.webnnDeviceType, debug: createDefaultDebug(regions.length) };
  }
  throw new Error("OCR 未返回有效识别结果");
}
