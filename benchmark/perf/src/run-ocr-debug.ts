/**
 * OCR substage benchmark/debug runner.
 *
 * Runs detect + builtin OCR on a single image and prints the OCR debug summary
 * as JSON. This is intentionally narrower than run-perf.ts so AR decode
 * changes can be measured quickly.
 */

import { existsSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { detectTextRegionsWithMask } from "../../../src/pipeline/detect";
import { runOcr } from "../../../src/pipeline/ocr";
import { nodePlatform } from "../../../src/runtime/nodePlatform";

const ROOT = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_IMAGE = join(ROOT, "benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png");

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

async function main(): Promise<void> {
  const imagePath = pickImagePath();
  const image = await nodePlatform.loadImage(imageToDataUrl(imagePath));

  const detectT0 = performance.now();
  const detected = await detectTextRegionsWithMask(image, nodePlatform);
  const detectMs = performance.now() - detectT0;

  const ocrT0 = performance.now();
  const ocr = await runOcr(image, detected.regions, "builtin", nodePlatform);
  const ocrMs = performance.now() - ocrT0;
  const debug = ocr.debug;

  const decodeSessionRunCount = debug.chunks.reduce((acc, chunk) => acc + chunk.decodeSessionRunCount, 0);
  const decodeSessionRunTotalMs = debug.chunks.reduce((acc, chunk) => acc + chunk.decodeSessionRunTotalMs, 0);
  const decodeStepCount = debug.chunks.reduce((acc, chunk) => acc + chunk.decodeSteps.length, 0);

  console.log(JSON.stringify({
    image: imagePath,
    detectedRegions: detected.regions.length,
    ocrRegions: ocr.regions.length,
    provider: ocr.actualProvider,
    detectMs: Math.round(detectMs * 100) / 100,
    ocrMs: Math.round(ocrMs * 100) / 100,
    mode: debug.mode,
    candidateCount: debug.candidateCount,
    preparedCount: debug.preparedCount,
    preprocessTotalMs: Math.round(debug.preprocessTotalMs * 100) / 100,
    chunkBatchSize: debug.chunkBatchSize,
    decodeSessionRunCount,
    decodeSessionRunTotalMs: Math.round(decodeSessionRunTotalMs * 100) / 100,
    decodeStepCount,
    chunks: debug.chunks.map((chunk) => ({
      chunkIndex: chunk.chunkIndex,
      chunkSize: chunk.chunkSize,
      decodeAccepted: chunk.decodeAccepted,
      encoderCache: chunk.encoderCache,
      encoderRunMs: chunk.encoderRunMs === undefined ? undefined : Math.round(chunk.encoderRunMs * 100) / 100,
      decoderRunMs: chunk.decoderRunMs === undefined ? undefined : Math.round(chunk.decoderRunMs * 100) / 100,
      decodeSessionRunCount: chunk.decodeSessionRunCount,
      decodeSessionRunTotalMs: Math.round(chunk.decodeSessionRunTotalMs * 100) / 100,
      decodeSteps: chunk.decodeSteps.map((step) => ({
        step: step.step,
        activeCount: step.activeCount,
        batchSize: step.batchSize,
        compactFallback: step.compactFallback,
        durationMs: Math.round(step.durationMs * 100) / 100,
        postprocessMode: step.postprocessMode,
        postprocessMs: step.postprocessMs === undefined ? undefined : Math.round(step.postprocessMs * 100) / 100,
      })),
      fallbackRegions: chunk.fallbackRegions,
    })),
    colorDecodeMode: debug.colorDecodeMode,
    colorBatchSize: debug.colorBatchSize,
    colorSessionRunCount: debug.colorSessionRunCount,
    colorSessionRunTotalMs: Math.round(debug.colorSessionRunTotalMs * 100) / 100,
    colorTotalMs: Math.round(debug.colorTotalMs * 100) / 100,
    fallbackTriggerCount: debug.fallbackTriggerCount,
    totalSessionRunCount: debug.totalSessionRunCount,
    totalSessionRunMs: Math.round(debug.totalSessionRunMs * 100) / 100,
    samples: ocr.regions.slice(0, 5).map((region) => ({
      id: region.id,
      text: region.sourceText,
      fgColor: region.fgColor,
      bgColor: region.bgColor,
    })),
  }, null, 2));
}

await main();
