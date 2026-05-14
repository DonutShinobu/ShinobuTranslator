import type { OcrRunDebugChunk, OcrRunDebugInfo, TextRegion } from "../../types";
import { getModel, getModelSession } from "../../runtime/modelRegistry";
import { isContextLostRuntimeError } from "../../runtime/onnxTypes";
import type { RuntimeProvider, WebNnDeviceType } from "../../runtime/onnxTypes";
import { runInference, runOcrBatchDecode, runOcrSingleDecode, runOcrColorBatch, runOcrColorSingle } from "../../runtime/onnxWorkerBridge";
import type { WorkerSessionHandle, TensorTransport, OcrInputNameSet, OcrBatchDecodeInputItem, OcrColorBatchInputItem, OcrColorResult } from "../../runtime/onnxWorkerTypes";
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

export type OcrResult = {
  regions: TextRegion[];
  actualProvider: RuntimeProvider;
  actualWebnnDeviceType?: WebNnDeviceType;
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

async function runOcrByOnnxWithSession(
  image: HTMLImageElement,
  detectedRegions: TextRegion[],
  model: Awaited<ReturnType<typeof getModel>>,
  sessionHandle: WorkerSessionHandle
): Promise<{ regions: TextRegion[]; debug: OcrRunDebugInfo }> {
  const charset = await loadCharset(model.dictUrl);
  const inputHeight = model.input?.[0] ?? 48;
  const inputWidth = model.input?.[1] ?? 320;
  const normalize = model.normalize ?? "minus_one_to_one";
  const imageInput = sessionHandle.inputNames[0];
  const debugInfo = createOcrDebugInfo("ctc");
  if (!imageInput) {
    return { regions: [], debug: finalizeOcrDebugInfo(debugInfo) };
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
        const inputData = buildOcrInput(image, region, direction, inputHeight, inputWidth, normalize);
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
        const batchResults = await runOcrBatchDecode(
          sessionHandle.sessionId,
          inputNames,
          batchItems,
          { seqLen, encoderLen, maxSteps, charset, inputHeight, inputWidth }
        );
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
              validEncoderLength: result.validEncoderLength
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
            const result = await runOcrSingleDecode(
              sessionHandle.sessionId,
              inputNames,
              candidate.inputData.data,
              candidate.inputData.dims,
              candidate.validEncoderLength,
              { seqLen, encoderLen, maxSteps, charset }
            );
            const fallbackDurationMs = performance.now() - fallbackT0;
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
      return { regions: [], debug: finalizeOcrDebugInfo(debugInfo) };
    }

    // Phase 2: batch color decoding for all successfully decoded regions.
    const colorItems: OcrColorBatchInputItem[] = decoded.map((d) => ({
      imageData: d.inputData.data,
      imageDims: d.inputData.dims,
      validEncoderLength: d.validEncoderLength,
      tokenIds: d.tokenIds
    }));

    let batchColors: (OcrColorResult | null)[];
    const colorT0 = performance.now();
    debugInfo.colorBatchSize = colorItems.length;
    try {
      debugInfo.colorDecodeMode = 'batch';
      batchColors = await runOcrColorBatch(
        sessionHandle.sessionId,
        inputNames,
        colorItems,
        seqLen,
        encoderLen,
        inputHeight,
        inputWidth
      );
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
          const colors = await runOcrColorSingle(
            sessionHandle.sessionId,
            inputNames,
            d.inputData.data,
            d.inputData.dims,
            d.validEncoderLength,
            d.tokenIds,
            seqLen,
            encoderLen
          );
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

    const next: TextRegion[] = [];
    for (let i = 0; i < decoded.length; i += 1) {
      const d = decoded[i];
      const colors = batchColors[i] ?? null;
      next.push({
        ...d.region,
        direction: d.direction,
        prob: d.confidence,
        fgColor: colors?.fgColor,
        bgColor: colors?.bgColor,
        sourceText: d.text,
        translatedText: ""
      });
    }

    return { regions: next, debug: finalizeOcrDebugInfo(debugInfo) };
  }

  // CTC path — use Worker for inference, main thread for postprocessing.
  const next: TextRegion[] = [];
  const candidates = generateTextDirection(detectedRegions);
  debugInfo.candidateCount = candidates.length;
  const preprocessT0 = performance.now();
  for (const item of candidates) {
    const { region, direction } = item;
    let bestText = "";
    let bestLength = 0;
    const regionPreprocessT0 = performance.now();
    const { data: inputData, dims: inputDims } = buildOcrInput(image, region, direction, inputHeight, inputWidth, normalize);
    debugInfo.preprocessPerRegionMs.push({
      regionId: region.id,
      durationMs: performance.now() - regionPreprocessT0
    });
    debugInfo.preparedCount += 1;
    let outputTensors: Record<string, TensorTransport>;
    try {
      const runT0 = performance.now();
      const result = await runInference(sessionHandle.sessionId, { [imageInput]: { data: inputData, dims: inputDims, type: "float32" } });
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
      next.push({
        ...region,
        direction,
        sourceText: bestText,
        translatedText: ""
      });
    }
  }
  debugInfo.preprocessTotalMs = performance.now() - preprocessT0;
  return { regions: next, debug: finalizeOcrDebugInfo(debugInfo) };
}

async function runOcrByOnnx(image: HTMLImageElement, detectedRegions: TextRegion[]): Promise<OcrResult> {
  const model = await getModel("ocr");
  const primaryHandle = await getModelSession("ocr", ["webgpu", "webnn", "wasm"]);

  let actualProvider: RuntimeProvider = primaryHandle.provider;
  let actualWebnnDeviceType = primaryHandle.webnnDeviceType;
  let debug: OcrRunDebugInfo = createOcrDebugInfo('ctc');

  try {
    const result = await runOcrByOnnxWithSession(image, detectedRegions, model, primaryHandle);
    return { regions: result.regions, actualProvider, actualWebnnDeviceType, debug: result.debug };
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

    let recovered: TextRegion[] | null = null;
    let lastFallbackError: unknown = null;
    console.warn(`[ocr] ${primaryHandle.provider} ${reason}, 尝试回退: ${message}`);

    for (const preferred of fallbackPlans) {
      try {
        const handle = await getModelSession("ocr", preferred);
        const result = await runOcrByOnnxWithSession(image, detectedRegions, model, handle);
        recovered = result.regions;
        debug = result.debug;
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

    return { regions: recovered, actualProvider, actualWebnnDeviceType, debug };
  }
}

export async function runOcr(image: HTMLImageElement, detectedRegions: TextRegion[]): Promise<OcrResult> {
  const onnxResult = await runOcrByOnnx(image, detectedRegions);
  if (onnxResult.regions.length > 0) {
    return onnxResult;
  }
  throw new Error("OCR ONNX 未返回有效识别结果");
}