import type { OcrProvider, OcrRecognizeOutput, OcrRecognizeResult } from './provider';
import type {
  OcrRunDebugChunk,
  OcrRunDebugInfo,
  PaddleOcrInferenceDebug,
  PaddleOcrRunDebug,
  TextRegion,
  QuadPoint,
} from '../../types';
import type { PlatformProvider, PipelineImage } from '../../runtime/platform';
import type { ModelName } from '../../runtime/modelRegistry';
import type { RuntimeProvider } from '../../runtime/onnxTypes';
import type { TensorTransport } from '../../runtime/onnxWorkerTypes';
import { getModel, getModelSession } from '../../runtime/modelRegistry';
import { buildPaddleOcrInput } from './paddleocrPreprocess';
import type { PaddleOcrInputData } from './paddleocrPreprocess';
import { decodePaddleCtc } from './paddleocrDecode';
import type { PaddleCtcResult } from './paddleocrDecode';
import { loadCharset } from './ocrShared';
import { runInference } from '../../runtime/onnxBridge';
import type { Direction } from './preprocess';

const PADDLEOCR_CONFIDENCE_THRESHOLD = 0.2;
const PADDLEOCR_BATCH_BUCKET_WIDTH = 32;
const warmedPaddleSessionIds = new Set<string>();

type PaddleOcrModelName = Extract<
  ModelName,
  'paddleocr_v6_medium_rec'
>;

type PaddleOcrRuntimeFlags = typeof globalThis & {
  __shinobuPaddleOcrWidthBucketBatch?: boolean;
  __shinobuPaddleOcrProviders?: RuntimeProvider[];
  __shinobuPaddleOcrColdFirstSerial?: boolean;
};

type PreparedPaddleRegion = {
  index: number;
  region: TextRegion;
  direction: Direction;
  inputData: PaddleOcrInputData;
  inputBytes: number;
};

type PaddleBatchDecodeOutput = {
  decoded: PaddleCtcResult[];
  timeSteps: number;
  numClasses: number;
};

function inferDirection(region: TextRegion): Direction {
  if (region.direction) return region.direction;
  return region.box.height > region.box.width ? 'v' : 'h';
}

function tensorByteLength(tensor: TensorTransport | undefined): number {
  return tensor?.data.byteLength ?? 0;
}

function shouldUsePaddleWidthBucketBatch(
  provider: PaddleOcrRunDebug['provider'],
  webnnDeviceType: PaddleOcrRunDebug['webnnDeviceType'],
): boolean {
  const configured = (globalThis as PaddleOcrRuntimeFlags).__shinobuPaddleOcrWidthBucketBatch;
  if (configured !== undefined) {
    return configured;
  }
  return provider === 'webgpu' || provider === 'cuda' || (provider === 'webnn' && webnnDeviceType !== 'cpu');
}

function shouldUsePaddleColdFirstSerial(
  provider: PaddleOcrRunDebug['provider'],
  sessionId: string,
): boolean {
  const configured = (globalThis as PaddleOcrRuntimeFlags).__shinobuPaddleOcrColdFirstSerial;
  if (configured !== undefined) {
    return configured;
  }
  return provider === 'webgpu' && !warmedPaddleSessionIds.has(sessionId);
}

function resolvePaddleRuntimeProviders(modelRuntime: RuntimeProvider[] | undefined): RuntimeProvider[] {
  const configured = (globalThis as PaddleOcrRuntimeFlags).__shinobuPaddleOcrProviders;
  if (configured && configured.length > 0) {
    return configured;
  }
  return modelRuntime ?? ['webgpu', 'webnn', 'wasm'];
}

function makeRegionQuad(region: TextRegion): [QuadPoint, QuadPoint, QuadPoint, QuadPoint] {
  return region.quad ?? [
    { x: region.box.x, y: region.box.y },
    { x: region.box.x + region.box.width, y: region.box.y },
    { x: region.box.x + region.box.width, y: region.box.y + region.box.height },
    { x: region.box.x, y: region.box.y + region.box.height },
  ];
}

function resolvePaddleBucketWidth(resizedWidth: number, maxInputWidth: number): number {
  return Math.max(
    1,
    Math.min(maxInputWidth, Math.ceil(resizedWidth / PADDLEOCR_BATCH_BUCKET_WIDTH) * PADDLEOCR_BATCH_BUCKET_WIDTH),
  );
}

function packPaddleBatch(items: PreparedPaddleRegion[], inputHeight: number, width: number): Float32Array {
  const batchData = new Float32Array(items.length * 3 * inputHeight * width);
  for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
    const input = items[itemIndex].inputData;
    const srcWidth = input.resizedWidth;
    for (let channel = 0; channel < 3; channel += 1) {
      const srcChannelOffset = channel * inputHeight * srcWidth;
      const dstChannelOffset = itemIndex * 3 * inputHeight * width + channel * inputHeight * width;
      for (let y = 0; y < inputHeight; y += 1) {
        batchData.set(
          input.data.subarray(srcChannelOffset + y * srcWidth, srcChannelOffset + y * srcWidth + srcWidth),
          dstChannelOffset + y * width,
        );
      }
    }
  }
  return batchData;
}

function buildPaddleGroupInput(items: PreparedPaddleRegion[], inputHeight: number, width: number): Float32Array {
  if (items.length === 1 && items[0].inputData.resizedWidth === width) {
    return items[0].inputData.data;
  }
  return packPaddleBatch(items, inputHeight, width);
}

function decodePaddleBatchOutput(
  output: TensorTransport,
  batchSize: number,
  ctcCharset: string[],
): PaddleBatchDecodeOutput | null {
  const logitsData = output.data as Float32Array;
  const logitsDims = output.dims;
  if (logitsDims.length === 3) {
    const outputBatchSize = logitsDims[0];
    const timeSteps = logitsDims[1];
    const numClasses = logitsDims[2];
    if (outputBatchSize < batchSize) {
      return null;
    }
    const itemStride = timeSteps * numClasses;
    const decoded = Array.from({ length: batchSize }, (_, index) => {
      const logits = logitsData.subarray(index * itemStride, (index + 1) * itemStride);
      return decodePaddleCtc(logits, timeSteps, numClasses, ctcCharset);
    });
    return { decoded, timeSteps, numClasses };
  }
  if (logitsDims.length === 2 && batchSize === 1) {
    const timeSteps = logitsDims[0];
    const numClasses = logitsDims[1];
    return {
      decoded: [decodePaddleCtc(logitsData, timeSteps, numClasses, ctcCharset)],
      timeSteps,
      numClasses,
    };
  }
  return null;
}

function createPaddleDebugInfo(
  modelName: PaddleOcrModelName,
  inputHeight: number,
  maxInputWidth: number,
  normalize: 'zero_to_one' | 'minus_one_to_one',
  channelOrder: 'rgb' | 'bgr',
  timings: {
    modelLoadMs: number;
    sessionLoadMs: number;
    charsetLoadMs: number;
  },
): { debugInfo: OcrRunDebugInfo; paddleDebug: PaddleOcrRunDebug } {
  const paddleDebug: PaddleOcrRunDebug = {
    modelName,
    batchMode: 'serial',
    inputHeight,
    maxInputWidth,
    normalize,
    channelOrder,
    modelLoadMs: timings.modelLoadMs,
    sessionLoadMs: timings.sessionLoadMs,
    charsetLoadMs: timings.charsetLoadMs,
    preprocessTotalMs: 0,
    inferenceTotalMs: 0,
    decodeTotalMs: 0,
    inputBytesTotal: 0,
    outputBytesTotal: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    missingOutputCount: 0,
    regions: [],
    inferenceRuns: [],
  };
  const debugInfo: OcrRunDebugInfo = {
    mode: 'ctc',
    candidateCount: 0,
    preparedCount: 0,
    preprocessTotalMs: 0,
    preprocessPerRegionMs: [],
    chunkBatchSize: 1,
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
    paddle: paddleDebug,
  };
  return { debugInfo, paddleDebug };
}

function addPaddleChunk(
  debugInfo: OcrRunDebugInfo,
  runIndex: number,
  regionIds: string[],
  durationMs: number,
  acceptedCount: number,
): void {
  const chunk: OcrRunDebugChunk = {
    chunkIndex: runIndex,
    chunkSize: regionIds.length,
    regionIds,
    decodeMode: 'batch',
    decodeAccepted: acceptedCount,
    decodeSessionRunCount: 1,
    decodeSessionRunTotalMs: durationMs,
    decodeSteps: [{
      step: runIndex,
      activeCount: regionIds.length,
      batchSize: regionIds.length,
      durationMs,
    }],
    fallbackRegions: [],
  };
  debugInfo.chunks.push(chunk);
  debugInfo.totalSessionRunCount += 1;
  debugInfo.totalSessionRunMs += durationMs;
}

function createPaddleOcrProvider(name: string, modelName: PaddleOcrModelName): OcrProvider {
  return {
    name,
    async recognize(image: PipelineImage, regions: TextRegion[], platform?: PlatformProvider): Promise<OcrRecognizeOutput> {
      if (!platform) {
        throw new Error('PaddleOCR 需要可用的运行平台');
      }
      const modelT0 = performance.now();
      const model = await getModel(modelName);
      const modelLoadMs = performance.now() - modelT0;
      const sessionT0 = performance.now();
      const sessionHandle = await getModelSession(modelName, resolvePaddleRuntimeProviders(model.runtime));
      const sessionLoadMs = performance.now() - sessionT0;
      const charsetT0 = performance.now();
      const charset = await loadCharset(model.dictUrl);
      const charsetLoadMs = performance.now() - charsetT0;
      if (!charset) {
        throw new Error('PaddleOCR 字典加载失败');
      }

      // CTC 解码需要索引 0 为 blank，在字典前插入空字符串作为 blank token。
      // PaddleOCR use_space_char: 在字典末尾追加半角空格。
      const ctcCharset = ['', ...charset, ' '];
      const inputHeight = model.input[0];
      const maxInputWidth = model.input[1];
      const normalize = model.normalize ?? 'minus_one_to_one';
      const channelOrder = model.channelOrder ?? 'rgb';
      const { debugInfo, paddleDebug } = createPaddleDebugInfo(
        modelName,
        inputHeight,
        maxInputWidth,
        normalize,
        channelOrder,
        { modelLoadMs, sessionLoadMs, charsetLoadMs },
      );
      debugInfo.candidateCount = regions.length;
      paddleDebug.provider = sessionHandle.provider;
      paddleDebug.webnnDeviceType = sessionHandle.webnnDeviceType;

      const imageInputName = sessionHandle.inputNames[0];
      if (!imageInputName) {
        return { results: [], provider: sessionHandle.provider, webnnDeviceType: sessionHandle.webnnDeviceType, debug: debugInfo };
      }

      const preparedRegions: PreparedPaddleRegion[] = [];
      const resultsByIndex: Array<OcrRecognizeResult | null> = Array.from({ length: regions.length }, () => null);
      for (const [index, region] of regions.entries()) {
        const direction = inferDirection(region);
        const preprocessT0 = performance.now();
        const inputData = buildPaddleOcrInput(
          image,
          region,
          direction,
          inputHeight,
          maxInputWidth,
          normalize,
          platform,
          channelOrder,
        );
        const preprocessMs = performance.now() - preprocessT0;
        const inputBytes = inputData.data.byteLength;
        debugInfo.preparedCount += 1;
        debugInfo.preprocessTotalMs += preprocessMs;
        debugInfo.preprocessPerRegionMs.push({ regionId: region.id, durationMs: preprocessMs });
        paddleDebug.preprocessTotalMs += preprocessMs;
        paddleDebug.regions.push({
          regionId: region.id,
          direction,
          box: { ...region.box },
          inputDims: [...inputData.dims],
          resizedWidth: inputData.resizedWidth,
          inputBytes,
          preprocessMs,
        });
        preparedRegions.push({ index, region, direction, inputData, inputBytes });
      }

      let inferenceRunIndex = 0;
      const runPreparedGroup = async (
        group: PreparedPaddleRegion[],
        inputWidth: number,
        allowFallback: boolean,
      ): Promise<void> => {
        const currentRunIndex = inferenceRunIndex;
        inferenceRunIndex += 1;
        const regionIds = group.map((item) => item.region.id);
        const batchInput = buildPaddleGroupInput(group, inputHeight, inputWidth);
        const inputDims = [group.length, 3, inputHeight, inputWidth];
        const inputBytes = batchInput.byteLength;
        const runDebug: PaddleOcrInferenceDebug = {
          runIndex: currentRunIndex,
          regionIds,
          inputDims,
          inputBytes,
          outputBytes: 0,
          durationMs: 0,
          decodeMs: 0,
          accepted: false,
          acceptedCount: 0,
          rejectedCount: 0,
        };

        const feeds: Record<string, TensorTransport> = {
          [imageInputName]: {
            data: batchInput,
            dims: inputDims,
            type: 'float32' as const,
          },
        };

        const inferenceT0 = performance.now();
        let inferenceResult: Awaited<ReturnType<typeof runInference>>;
        try {
          inferenceResult = await runInference(sessionHandle.sessionId, feeds);
        } catch (error) {
          const inferenceMs = performance.now() - inferenceT0;
          runDebug.durationMs = inferenceMs;
          runDebug.error = error instanceof Error ? error.message : String(error);
          paddleDebug.inferenceTotalMs += inferenceMs;
          paddleDebug.inputBytesTotal += inputBytes;
          paddleDebug.inferenceRuns.push(runDebug);
          addPaddleChunk(debugInfo, currentRunIndex, regionIds, inferenceMs, 0);
          if (allowFallback && group.length > 1) {
            for (const item of group) {
              await runPreparedGroup([item], item.inputData.resizedWidth, false);
            }
            return;
          }
          throw error;
        }
        const inferenceMs = performance.now() - inferenceT0;
        runDebug.durationMs = inferenceMs;
        paddleDebug.inferenceTotalMs += inferenceMs;
        paddleDebug.inputBytesTotal += inputBytes;
        if (inferenceResult.error) {
          runDebug.error = inferenceResult.error;
          paddleDebug.inferenceRuns.push(runDebug);
          addPaddleChunk(debugInfo, currentRunIndex, regionIds, inferenceMs, 0);
          if (allowFallback && group.length > 1) {
            for (const item of group) {
              await runPreparedGroup([item], item.inputData.resizedWidth, false);
            }
            return;
          }
          throw new Error(inferenceResult.error);
        }

        const logitsOutput = inferenceResult.outputs[sessionHandle.outputNames[0]];
        if (!logitsOutput) {
          paddleDebug.missingOutputCount += group.length;
          runDebug.error = '模型未返回 logits 输出';
          paddleDebug.inferenceRuns.push(runDebug);
          addPaddleChunk(debugInfo, currentRunIndex, regionIds, inferenceMs, 0);
          if (allowFallback && group.length > 1) {
            for (const item of group) {
              await runPreparedGroup([item], item.inputData.resizedWidth, false);
            }
          }
          return;
        }

        const logitsDims = logitsOutput.dims;
        const outputBytes = tensorByteLength(logitsOutput);
        paddleDebug.outputBytesTotal += outputBytes;
        runDebug.outputBytes = outputBytes;
        runDebug.outputDims = [...logitsDims];
        const decodeT0 = performance.now();
        const decodedOutput = decodePaddleBatchOutput(logitsOutput, group.length, ctcCharset);
        const decodeMs = performance.now() - decodeT0;
        runDebug.decodeMs = decodeMs;
        paddleDebug.decodeTotalMs += decodeMs;
        if (!decodedOutput) {
          runDebug.error = `不支持的 logits 维度: ${logitsDims.join('x')}`;
          paddleDebug.inferenceRuns.push(runDebug);
          addPaddleChunk(debugInfo, currentRunIndex, regionIds, inferenceMs, 0);
          if (allowFallback && group.length > 1) {
            for (const item of group) {
              await runPreparedGroup([item], item.inputData.resizedWidth, false);
            }
          }
          return;
        }

        let acceptedCount = 0;
        let rejectedCount = 0;
        const texts: string[] = [];
        for (let itemIndex = 0; itemIndex < group.length; itemIndex += 1) {
          const item = group[itemIndex];
          const decoded = decodedOutput.decoded[itemIndex];
          texts.push(decoded.text);
          if (decoded.confidence < PADDLEOCR_CONFIDENCE_THRESHOLD || decoded.text.trim() === '') {
            rejectedCount += 1;
            continue;
          }
          acceptedCount += 1;
          resultsByIndex[item.index] = {
            text: decoded.text,
            confidence: decoded.confidence,
            quad: makeRegionQuad(item.region),
          };
        }
        paddleDebug.acceptedCount += acceptedCount;
        paddleDebug.rejectedCount += rejectedCount;
        runDebug.accepted = acceptedCount > 0;
        runDebug.acceptedCount = acceptedCount;
        runDebug.rejectedCount = rejectedCount;
        runDebug.timeSteps = decodedOutput.timeSteps;
        runDebug.numClasses = decodedOutput.numClasses;
        runDebug.texts = texts;
        if (group.length === 1) {
          const decoded = decodedOutput.decoded[0];
          runDebug.text = decoded.text;
          runDebug.confidence = decoded.confidence;
        }
        paddleDebug.inferenceRuns.push(runDebug);
        addPaddleChunk(debugInfo, currentRunIndex, regionIds, inferenceMs, acceptedCount);
      };

      const useWidthBucketBatch = shouldUsePaddleWidthBucketBatch(sessionHandle.provider, sessionHandle.webnnDeviceType);
      paddleDebug.batchMode = useWidthBucketBatch ? 'width-bucket' : 'serial';
      if (useWidthBucketBatch) {
        paddleDebug.batchBucketWidth = PADDLEOCR_BATCH_BUCKET_WIDTH;
        const useColdFirstSerial = preparedRegions.length > 1
          && shouldUsePaddleColdFirstSerial(sessionHandle.provider, sessionHandle.sessionId);
        paddleDebug.coldFirstSerial = useColdFirstSerial;
        let bucketCandidates = preparedRegions;
        if (useColdFirstSerial) {
          warmedPaddleSessionIds.add(sessionHandle.sessionId);
          const [firstRegion, ...remainingRegions] = preparedRegions;
          await runPreparedGroup([firstRegion], firstRegion.inputData.resizedWidth, false);
          bucketCandidates = remainingRegions;
        }
        const groups = new Map<number, PreparedPaddleRegion[]>();
        for (const item of bucketCandidates) {
          const bucketWidth = resolvePaddleBucketWidth(item.inputData.resizedWidth, maxInputWidth);
          const group = groups.get(bucketWidth);
          if (group) {
            group.push(item);
          } else {
            groups.set(bucketWidth, [item]);
          }
        }
        debugInfo.chunkBatchSize = Math.max(1, ...Array.from(groups.values(), (group) => group.length));
        for (const [bucketWidth, group] of groups) {
          await runPreparedGroup(group, bucketWidth, true);
        }
      } else {
        warmedPaddleSessionIds.add(sessionHandle.sessionId);
        for (const item of preparedRegions) {
          await runPreparedGroup([item], item.inputData.resizedWidth, false);
        }
      }

      warmedPaddleSessionIds.add(sessionHandle.sessionId);
      const results = resultsByIndex.filter((result): result is OcrRecognizeResult => result !== null);
      return { results, provider: sessionHandle.provider, webnnDeviceType: sessionHandle.webnnDeviceType, debug: debugInfo };
    },
  };
}

export const paddleocrV6MediumProvider = createPaddleOcrProvider('paddleocr_v6_medium', 'paddleocr_v6_medium_rec');
