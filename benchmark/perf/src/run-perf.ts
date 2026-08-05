/**
 * Pipeline performance benchmark — Node.js runner.
 *
 * Runs the full translation pipeline N times, collects per-stage timings,
 * and writes a JSON report for before/after optimization comparison.
 *
 * Usage:
 *   npx tsx benchmark/perf/src/run-perf.ts
 *   npm run bench:perf
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, extname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import {
  detectBubbles,
  detectByTesseract,
  detectTextRegionsWithMask,
  drawTypeset,
  imageToCanvas,
  matchRegionsToBubbles,
  mergeTextLines,
  refineTextMask,
  runInpaint,
  runOcr,
  sortRegionsForRender,
} from '@shinobu/image-pipeline/benchmark';
import { nodePipelinePlatform as nodePlatform } from '../../nodePipelinePlatform';
import type { OcrRunDebugInfo } from '@shinobu/image-pipeline/benchmark';
import { benchmarkModelRuntime } from '../../model-runtime';

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), "../../..");
const REPORTS_DIR = join(ROOT, "benchmark/perf/reports");
const MODELS_DIR = join(ROOT, "public/models");
const DEFAULT_IMAGES_DIR = join(ROOT, "benchmark/typeset/images");

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8", cwd: ROOT }).trim();
  } catch {
    return "unknown";
  }
}

function imageToDataUrl(path: string): string {
  const ext = extname(path).toLowerCase();
  const mime = ext === ".png" ? "image/png" : "image/jpeg";
  const buf = readFileSync(path);
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function registerFonts(): void {
  const fontsDir = join(ROOT, "public/fonts");
  if (existsSync(fontsDir)) {
    const fontFiles = readdirSync(fontsDir).filter((f: string) =>
      /\.(ttf|otf|ttc)$/i.test(f),
    );
    for (const fontFile of fontFiles) {
      const fontPath = join(fontsDir, fontFile);
      const baseName = fontFile.replace(/-VF\.(ttf|otf)$/i, "");
      nodePlatform.registerFont(fontPath, baseName);
    }
  }

  const systemFontPaths = [
    { path: "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf", family: "IPAGothic" },
    { path: "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", family: "WenQuanYi Zen Hei" },
  ];
  for (const { path, family } of systemFontPaths) {
    if (existsSync(path)) {
      nodePlatform.registerFont(path, family);
    }
  }
}

function checkModelFiles(): void {
  const requiredModels = ["detector.ort", "bubble.onnx", "aot_inpaint_512.onnx", "PP-OCRv6_medium_rec.onnx", "paddleocr_v6_dict.txt"];
  const missing = requiredModels.filter((m) => !existsSync(join(MODELS_DIR, m)));
  if (missing.length > 0) {
    console.error(`Missing model files in ${MODELS_DIR}:`);
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StageTiming = { stage: string; label: string; durationMs: number };

type OcrDebugSummary = {
  mode: OcrRunDebugInfo["mode"];
  candidateCount: number;
  preparedCount: number;
  preprocessTotalMs: number;
  decodeSessionRunCount: number;
  decodeSessionRunTotalMs: number;
  decodeStepCount: number;
  colorDecodeMode: OcrRunDebugInfo["colorDecodeMode"];
  colorBatchSize: number;
  colorSessionRunCount: number;
  colorSessionRunTotalMs: number;
  colorTotalMs: number;
  fallbackTriggerCount: number;
  totalSessionRunCount: number;
  totalSessionRunMs: number;
};

type RunResult = {
  runIndex: number;
  isColdStart: boolean;
  totalMs: number;
  stages: StageTiming[];
  ocrDebug?: OcrDebugSummary;
};

type ImagePerfResult = {
  imageFile: string;
  runs: RunResult[];
  median: StageTiming[];
  medianTotalMs: number;
};

type PerfReport = {
  timestamp: string;
  gitCommit: string;
  images: ImagePerfResult[];
  runtime: string;
  overallMedianTotalMs: number;
};

function summarizeOcrDebug(debug: OcrRunDebugInfo): OcrDebugSummary {
  const decodeSessionRunCount = debug.chunks.reduce((acc, chunk) => acc + chunk.decodeSessionRunCount, 0);
  const decodeSessionRunTotalMs = debug.chunks.reduce((acc, chunk) => acc + chunk.decodeSessionRunTotalMs, 0);
  const decodeStepCount = debug.chunks.reduce((acc, chunk) => acc + chunk.decodeSteps.length, 0);
  return {
    mode: debug.mode,
    candidateCount: debug.candidateCount,
    preparedCount: debug.preparedCount,
    preprocessTotalMs: Math.round(debug.preprocessTotalMs * 100) / 100,
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
  };
}

// ---------------------------------------------------------------------------
// Pipeline runner with per-stage timing
// ---------------------------------------------------------------------------

async function runPipelineOnce(imageDataUrl: string): Promise<{ stages: StageTiming[]; ocrDebug?: OcrDebugSummary }> {
  const stages: StageTiming[] = [];

  const time = async <T>(stage: string, label: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    const result = await fn();
    stages.push({ stage, label, durationMs: performance.now() - t0 });
    return result;
  };

  // load
  const image = await time("load", "加载图片", () => nodePlatform.loadImage(imageDataUrl));
  const originalCanvas = imageToCanvas(image, nodePlatform);

  // detect
  const detected = await time("detect", "文本检测", () => detectTextRegionsWithMask(
    image,
    nodePlatform,
    benchmarkModelRuntime,
    {
      kind: 'tesseract-then-heuristic',
      detectWithTesseract: detectByTesseract,
    },
  ));
  let regions = detected.regions;
  const detectionMaskCanvas = detected.rawMaskCanvas;

  // bubble
  const bubbleResult = await time("bubble", "气泡检测", () => detectBubbles(image, nodePlatform, benchmarkModelRuntime));

  // ocr
  const ocrResult = await time("ocr", "OCR 日文识别", () => runOcr(
    image,
    regions,
    undefined,
    nodePlatform,
    undefined,
    benchmarkModelRuntime,
  ));
  regions = ocrResult.regions;
  const ocrDebug = summarizeOcrDebug(ocrResult.debug);

  // merge (synchronous)
  const mergeT0 = performance.now();
  regions = mergeTextLines(regions, image.naturalWidth, image.naturalHeight);
  stages.push({ stage: "merge", label: "合并文本行", durationMs: performance.now() - mergeT0 });

  // bubble match (after merge, not separately timed — included in merge)
  if (bubbleResult.bubbles.length > 0) {
    matchRegionsToBubbles(regions, bubbleResult.bubbles);
  }

  // order (synchronous)
  const orderT0 = performance.now();
  regions = sortRegionsForRender(regions, originalCanvas, nodePlatform);
  stages.push({ stage: "order", label: "文本顺序排序", durationMs: performance.now() - orderT0 });

  const orderedRegions = regions;

  // parallel: translate + erase (mask_refine + inpaint)
  const parallelT0 = performance.now();
  let translateTiming: StageTiming | null = null;
  let maskRefineTiming: StageTiming | null = null;
  let inpaintTiming: StageTiming | null = null;

  const [translatedRegions, inpaintedCanvas] = await Promise.all([
    (async () => {
      // Skip translation — network I/O, not relevant to CPU/GPU pipeline perf
      const t0 = performance.now();
      const skippedRegions = orderedRegions.map(r => ({ ...r, translatedText: r.sourceText }));
      translateTiming = { stage: "translate", label: "翻译(跳过)", durationMs: performance.now() - t0 };
      return skippedRegions;
    })(),
    (async () => {
      if (!detectionMaskCanvas) throw new Error("检测阶段未提供 mask");

      const regionsWithText = orderedRegions.filter(r => r.sourceText.trim() !== '');
      const mrT0 = performance.now();
      const refineResult = refineTextMask(originalCanvas, regionsWithText, detectionMaskCanvas, nodePlatform, {
        method: "fit_text",
        kernelSize: 3,
      }, false);
      maskRefineTiming = { stage: "mask_refine", label: "细化去字遮罩", durationMs: performance.now() - mrT0 };

      const ipT0 = performance.now();
      const inpaintResult = await runInpaint(
        originalCanvas,
        refineResult.refinedMaskCanvas,
        nodePlatform,
        benchmarkModelRuntime,
      );
      inpaintTiming = { stage: "inpaint", label: "去字", durationMs: performance.now() - ipT0 };
      return inpaintResult.canvas;
    })(),
  ]);

  if (translateTiming) stages.push(translateTiming);
  if (maskRefineTiming) stages.push(maskRefineTiming);
  if (inpaintTiming) stages.push(inpaintTiming);
  stages.push({ stage: "parallel", label: "并行处理(翻译 + 去字)", durationMs: performance.now() - parallelT0 });

  regions = translatedRegions;
  const cleanedCanvas = inpaintedCanvas;

  // typeset
  await time("typeset", "排版和嵌字", () =>
    drawTypeset(cleanedCanvas, regions, "zh-CN", { renderText: true }, nodePlatform),
  );

  return { stages, ocrDebug };
}

// ---------------------------------------------------------------------------
// Median computation
// ---------------------------------------------------------------------------

function computeMedian(runs: RunResult[]): { median: StageTiming[]; medianTotalMs: number } {
  const warmRuns = runs.filter(r => !r.isColdStart);
  const runsToUse = warmRuns.length >= 2 ? warmRuns : runs;

  const stageOrder = runsToUse[0].stages.map(s => s.stage);
  const median: StageTiming[] = stageOrder.map(stage => {
    const label = runsToUse[0].stages.find(s => s.stage === stage)!.label;
    const durations = runsToUse.map(r => r.stages.find(s => s.stage === stage)!.durationMs).sort((a, b) => a - b);
    const mid = Math.floor(durations.length / 2);
    const medianMs = durations.length % 2 !== 0 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2;
    return { stage, label, durationMs: Math.round(medianMs * 100) / 100 };
  });

  const totalDurations = runsToUse.map(r => r.totalMs).sort((a, b) => a - b);
  const mid = Math.floor(totalDurations.length / 2);
  const medianTotalMs = totalDurations.length % 2 !== 0
    ? totalDurations[mid]
    : (totalDurations[mid - 1] + totalDurations[mid]) / 2;

  return { median, medianTotalMs: Math.round(medianTotalMs * 100) / 100 };
}

// ---------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------

function printRunTable(run: RunResult): void {
  const tag = run.isColdStart ? " (冷启动)" : "";
  console.log(`\n  Run ${run.runIndex + 1}${tag} — 总耗时: ${(run.totalMs / 1000).toFixed(2)}s`);
  console.log("  ───────────────────────────────────────────");
  console.log("  阶段                耗时        占比");
  console.log("  ───────────────────────────────────────────");
  for (const s of run.stages) {
    const pct = run.totalMs > 0 ? ((s.durationMs / run.totalMs) * 100).toFixed(1) : "0.0";
    const dur = s.durationMs >= 1000
      ? `${(s.durationMs / 1000).toFixed(2)}s`
      : `${s.durationMs.toFixed(0)}ms`;
    console.log(`  ${s.label.padEnd(18)} ${dur.padStart(8)}  ${pct.padStart(5)}%`);
  }
  if (run.ocrDebug) {
    const d = run.ocrDebug;
    console.log(`  OCR子阶段           decode ${d.decodeSessionRunCount}次/${formatMs(d.decodeSessionRunTotalMs)}  color ${d.colorDecodeMode}/${formatMs(d.colorTotalMs)}`);
  }
  console.log("  ───────────────────────────────────────────");
}

function formatMs(durationMs: number): string {
  return durationMs >= 1000 ? `${(durationMs / 1000).toFixed(2)}s` : `${durationMs.toFixed(0)}ms`;
}

function printMedianTable(median: StageTiming[], totalMs: number): void {
  console.log(`\n  中位数 — 总耗时: ${(totalMs / 1000).toFixed(2)}s`);
  console.log("  ═══════════════════════════════════════════");
  console.log("  阶段                耗时        占比");
  console.log("  ═══════════════════════════════════════════");
  for (const s of median) {
    const pct = totalMs > 0 ? ((s.durationMs / totalMs) * 100).toFixed(1) : "0.0";
    const dur = s.durationMs >= 1000
      ? `${(s.durationMs / 1000).toFixed(2)}s`
      : `${s.durationMs.toFixed(0)}ms`;
    console.log(`  ${s.label.padEnd(18)} ${dur.padStart(8)}  ${pct.padStart(5)}%`);
  }
  console.log("  ═══════════════════════════════════════════");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const RUN_COUNT = 3;

function collectImages(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f: string) => /\.(png|jpe?g)$/i.test(f))
    .sort()
    .map((f: string) => join(dir, f));
}

async function benchmarkImage(imagePath: string, runCount: number): Promise<ImagePerfResult> {
  const fileName = imagePath.split(/[/\\]/).pop() ?? imagePath;
  const dataUrl = imageToDataUrl(imagePath);

  const runs: RunResult[] = [];

  for (let i = 0; i < runCount; i++) {
    const isColdStart = i === 0;
    const runT0 = performance.now();
    const { stages, ocrDebug } = await runPipelineOnce(dataUrl);
    const totalMs = performance.now() - runT0;

    const run: RunResult = { runIndex: i, isColdStart, totalMs, stages, ocrDebug };
    runs.push(run);
    printRunTable(run);
  }

  const { median, medianTotalMs } = computeMedian(runs);
  printMedianTable(median, medianTotalMs);

  return { imageFile: fileName, runs, median, medianTotalMs };
}

async function main(): Promise<void> {
  const imagesDir = DEFAULT_IMAGES_DIR;
  const images = collectImages(imagesDir);
  if (images.length === 0) {
    console.error(`No images found in ${imagesDir}`);
    process.exit(1);
  }

  console.log("Pipeline Performance Benchmark — Baseline");
  console.log(`Images dir: ${imagesDir} (${images.length} images)`);
  console.log(`Runs per image: ${RUN_COUNT}`);

  checkModelFiles();
  registerFonts();

  let runtime = "unknown";

  const imageResults: ImagePerfResult[] = [];

  for (let imgIdx = 0; imgIdx < images.length; imgIdx++) {
    const imagePath = images[imgIdx];
    const fileName = imagePath.split(/[/\\]/).pop() ?? imagePath;
    console.log(`\n${"═".repeat(60)}`);
    console.log(`[${imgIdx + 1}/${images.length}] ${fileName}`);
    console.log("═".repeat(60));

    const result = await benchmarkImage(imagePath, RUN_COUNT);
    imageResults.push(result);

    // Detect runtime on first image's first run
    if (imgIdx === 0 && runtime === "unknown") {
      try {
        const handle = await benchmarkModelRuntime.getSession('detector');
        runtime = handle.provider ?? "unknown";
      } catch {
        runtime = "unknown";
      }
    }
  }

  // Compute overall median total across all images
  const allMedians = imageResults.map(r => r.medianTotalMs).sort((a, b) => a - b);
  const mid = Math.floor(allMedians.length / 2);
  const overallMedianTotalMs = allMedians.length % 2 !== 0
    ? allMedians[mid]
    : (allMedians[mid - 1] + allMedians[mid]) / 2;

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log("Baseline Summary");
  console.log("═".repeat(60));
  for (const r of imageResults) {
    console.log(`  ${r.imageFile.padEnd(20)} ${(r.medianTotalMs / 1000).toFixed(2)}s`);
  }
  console.log(`  ${"─".repeat(40)}`);
  console.log(`  ${"Overall median".padEnd(20)} ${(overallMedianTotalMs / 1000).toFixed(2)}s`);

  // Write JSON report
  mkdirSync(REPORTS_DIR, { recursive: true });
  const report: PerfReport = {
    timestamp: new Date().toISOString(),
    gitCommit: gitCommit(),
    images: imageResults,
    runtime,
    overallMedianTotalMs: Math.round(overallMedianTotalMs * 100) / 100,
  };

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = join(REPORTS_DIR, `perf-baseline-${ts}.json`);
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${reportPath}`);
}

main();
