/**
 * OCR substage benchmark/debug runner.
 *
 * Runs detect + Paddle OCR on a single image and prints the OCR debug summary
 * as JSON. This is intentionally narrower than run-perf.ts so OCR recognition
 * changes can be measured quickly.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { detectTextRegionsWithMask } from "../../../src/pipeline/detect";
import { runOcr } from "../../../src/pipeline/ocr";
import { nodePlatform } from "../../../src/runtime/nodePlatform";
import {
  createProductionProviderSessionResolver,
} from "../../../src/runtime/productionProviderExecution";
import type { OcrEngine } from "../../../src/shared/config";

const ROOT = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_IMAGE = join(ROOT, "benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png");
const DEFAULT_ENGINES: OcrEngine[] = ["paddleocr_v6_medium"];

type EngineRunResult = {
  runIndex: number;
  isColdStart: boolean;
  ocrMs: number;
  ocrRegions: number;
  provider: string;
  samples: Array<{
    id: string;
    text: string;
    fgColor?: [number, number, number];
    bgColor?: [number, number, number];
  }>;
  debug: ReturnType<typeof summarizeDebug>;
};

type EngineResult = {
  engine: OcrEngine;
  runs: EngineRunResult[];
  error?: string;
};

type OcrDebug = Awaited<ReturnType<typeof runOcr>>["debug"];
type PaddleDebug = NonNullable<OcrDebug["paddle"]>;

type PaddleOcrRuntimeFlags = typeof globalThis & {
  __shinobuPaddleOcrWidthBucketBatch?: boolean;
};

type PaddleBatchCliMode = "default" | "serial" | "width-bucket";

function imageToDataUrl(path: string): string {
  const buf = readFileSync(path);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

function pickImagePath(): string {
  const arg = process.argv.find((value) => value.startsWith("--image="));
  const path = arg ? resolve(arg.slice("--image=".length)) : DEFAULT_IMAGE;
  if (!existsSync(path)) {
    throw new Error(`图片不存在: ${path}`);
  }
  return path;
}

function parseRunCount(): number {
  const arg = process.argv.find((value) => value.startsWith("--runs="));
  if (!arg) return 1;
  const count = Number(arg.slice("--runs=".length));
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(`--runs 必须是正整数: ${arg}`);
  }
  return count;
}

function configurePaddleBatchMode(): PaddleBatchCliMode {
  if (process.argv.includes("--paddle-serial")) {
    (globalThis as PaddleOcrRuntimeFlags).__shinobuPaddleOcrWidthBucketBatch = false;
    return "serial";
  }
  if (process.argv.includes("--paddle-batch")) {
    (globalThis as PaddleOcrRuntimeFlags).__shinobuPaddleOcrWidthBucketBatch = true;
    return "width-bucket";
  }
  delete (globalThis as PaddleOcrRuntimeFlags).__shinobuPaddleOcrWidthBucketBatch;
  return "default";
}

function normalizeEngineArg(value: string): OcrEngine | "all" {
  switch (value) {
    case "all":
    case "matrix":
      return "all";
    case "paddle":
    case "paddleocr":
    case "paddleocr_v6_medium":
    case "v6-medium":
    case "paddle-v6-medium":
      return "paddleocr_v6_medium";
    default:
      throw new Error(`未知 OCR 引擎: ${value}`);
  }
}

function pickOcrEngines(): OcrEngine[] {
  const arg = process.argv.find((value) => value.startsWith("--ocr-engine="));
  if (!arg) {
    return DEFAULT_ENGINES;
  }
  const parsed = normalizeEngineArg(arg.slice("--ocr-engine=".length));
  return parsed === "all" ? DEFAULT_ENGINES : [parsed];
}

function roundMetric(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.round(value * 100) / 100;
}

function summarizePaddleDebug(paddle: PaddleDebug | undefined) {
  if (!paddle) {
    return undefined;
  }
  const widths = paddle.regions.map((region) => region.resizedWidth);
  const widthSummary = widths.length > 0
    ? {
        min: Math.min(...widths),
        max: Math.max(...widths),
        avg: roundMetric(widths.reduce((sum, width) => sum + width, 0) / widths.length),
        values: widths,
      }
    : {
        min: 0,
        max: 0,
        avg: 0,
        values: [],
      };
  return {
    modelName: paddle.modelName,
    provider: paddle.provider,
    webnnDeviceType: paddle.webnnDeviceType,
    batchMode: paddle.batchMode,
    batchBucketWidth: paddle.batchBucketWidth,
    inputHeight: paddle.inputHeight,
    maxInputWidth: paddle.maxInputWidth,
    normalize: paddle.normalize,
    channelOrder: paddle.channelOrder,
    modelLoadMs: roundMetric(paddle.modelLoadMs),
    sessionLoadMs: roundMetric(paddle.sessionLoadMs),
    charsetLoadMs: roundMetric(paddle.charsetLoadMs),
    preprocessTotalMs: roundMetric(paddle.preprocessTotalMs),
    inferenceTotalMs: roundMetric(paddle.inferenceTotalMs),
    decodeTotalMs: roundMetric(paddle.decodeTotalMs),
    colorFillMs: roundMetric(paddle.colorFillMs),
    inputBytesTotal: paddle.inputBytesTotal,
    outputBytesTotal: paddle.outputBytesTotal,
    acceptedCount: paddle.acceptedCount,
    rejectedCount: paddle.rejectedCount,
    missingOutputCount: paddle.missingOutputCount,
    widthSummary,
    inferenceRuns: paddle.inferenceRuns.map((run) => ({
      runIndex: run.runIndex,
      regionIds: run.regionIds,
      inputDims: run.inputDims,
      outputDims: run.outputDims,
      inputBytes: run.inputBytes,
      outputBytes: run.outputBytes,
      durationMs: roundMetric(run.durationMs),
      decodeMs: roundMetric(run.decodeMs),
      timeSteps: run.timeSteps,
      numClasses: run.numClasses,
      accepted: run.accepted,
      acceptedCount: run.acceptedCount,
      rejectedCount: run.rejectedCount,
      text: run.text,
      texts: run.texts,
      confidence: roundMetric(run.confidence),
      error: run.error,
    })),
  };
}

function summarizeDebug(debug: OcrDebug) {
  const decodeSessionRunCount = debug.chunks.reduce((acc, chunk) => acc + chunk.decodeSessionRunCount, 0);
  const decodeSessionRunTotalMs = debug.chunks.reduce((acc, chunk) => acc + chunk.decodeSessionRunTotalMs, 0);
  const decodeStepCount = debug.chunks.reduce((acc, chunk) => acc + chunk.decodeSteps.length, 0);

  return {
    mode: debug.mode,
    candidateCount: debug.candidateCount,
    preparedCount: debug.preparedCount,
    preprocessTotalMs: Math.round(debug.preprocessTotalMs * 100) / 100,
    chunkBatchSize: debug.chunkBatchSize,
    decodeSessionRunCount,
    decodeSessionRunTotalMs: Math.round(decodeSessionRunTotalMs * 100) / 100,
    decodeStepCount,
    colorDecodeMode: debug.colorDecodeMode,
    colorBatchSize: debug.colorBatchSize,
    colorSessionRunCount: debug.colorSessionRunCount,
    colorSessionRunTotalMs: Math.round(debug.colorSessionRunTotalMs * 100) / 100,
    colorTotalMs: Math.round(debug.colorTotalMs * 100) / 100,
    fallbackTriggerCount: debug.fallbackTriggerCount,
    totalSessionRunCount: debug.totalSessionRunCount,
    totalSessionRunMs: Math.round(debug.totalSessionRunMs * 100) / 100,
    paddle: summarizePaddleDebug(debug.paddle),
  };
}

async function runEngine(
  image: Awaited<ReturnType<typeof nodePlatform.loadImage>>,
  regions: Awaited<ReturnType<typeof detectTextRegionsWithMask>>["regions"],
  engine: OcrEngine,
  runCount: number,
): Promise<EngineResult> {
  const runs: EngineRunResult[] = [];
  try {
    for (let i = 0; i < runCount; i += 1) {
      const ocrT0 = performance.now();
      const ocr = await runOcr(image, regions, engine, nodePlatform);
      const ocrMs = performance.now() - ocrT0;
      runs.push({
        runIndex: i,
        isColdStart: i === 0,
        ocrMs: Math.round(ocrMs * 100) / 100,
        ocrRegions: ocr.regions.length,
        provider: ocr.actualProvider,
        samples: ocr.regions.slice(0, 5).map((region) => ({
          id: region.id,
          text: region.sourceText,
          fgColor: region.fgColor,
          bgColor: region.bgColor,
        })),
        debug: summarizeDebug(ocr.debug),
      });
    }
    return { engine, runs };
  } catch (error) {
    return { engine, runs, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  const imagePath = pickImagePath();
  const engines = pickOcrEngines();
  const runCount = parseRunCount();
  const paddleBatchMode = configurePaddleBatchMode();
  const image = await nodePlatform.loadImage(imageToDataUrl(imagePath));

  const detectT0 = performance.now();
  const detected = await detectTextRegionsWithMask(
    image,
    nodePlatform,
    createProductionProviderSessionResolver(),
  );
  const detectMs = performance.now() - detectT0;

  const engineResults: EngineResult[] = [];
  for (const engine of engines) {
    engineResults.push(await runEngine(image, detected.regions, engine, runCount));
  }

  console.log(JSON.stringify({
    image: imagePath,
    engines,
    runsPerEngine: runCount,
    paddleBatchMode,
    detectedRegions: detected.regions.length,
    detectMs: Math.round(detectMs * 100) / 100,
    results: engineResults,
  }, null, 2));
}

await main();
