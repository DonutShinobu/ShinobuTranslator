import { createServer } from "http";
import type { AddressInfo } from "net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, extname, join, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { chromium } from "@playwright/test";
import type { BrowserContext } from "@playwright/test";
import { resolveExtensionBuildTarget } from "../../../apps/extension/scripts/build-targets.mjs";
import type { OcrEngine, ProcessMode } from "../../../src/shared/config";
import type { OcrRunDebugInfo, PaddleOcrRunDebug } from "../../../src/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DIST_DIR = resolveExtensionBuildTarget("benchmark").absoluteOutDir;
const TMP_DIR = join(ROOT, ".tmp");
const REPORTS_DIR = join(ROOT, "benchmark/perf/reports");
const DEFAULT_X_URL = "https://x.com/nanashiwan/status/2061024890195435823/photo/1";
const USE_SYSTEM_CHROME = process.argv.includes("--system-chrome") || Boolean(process.env.CHROME_PATH);
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  ...(USE_SYSTEM_CHROME
    ? [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      ]
    : []),
].filter((value): value is string => !!value);

type RuntimeProvider = "webnn" | "webgpu" | "wasm" | "cuda" | "cpu";
type PaddleBatchCliMode = "default" | "serial" | "width-bucket";
type PaddleProviderCliMode = "default" | "webgpu" | "webnn" | "wasm";
type PaddleColdFirstCliMode = "default" | "on" | "off";
type PaddleModelCliMode = "medium";

type StageTiming = {
  stage: string;
  label: string;
  durationMs: number;
};

type OcrDebugChunk = {
  encoderCache?: boolean;
  compactActiveBatch?: boolean;
  encoderRunMs?: number;
  decoderRunMs?: number;
  decodeSessionRunCount: number;
  decodeSessionRunTotalMs: number;
  decodeSteps: Array<{
    step: number;
    activeCount: number;
    batchSize?: number;
    compactFallback?: boolean;
    durationMs: number;
    postprocessMode?: "cpu" | "gpu" | "gpu-fallback";
    postprocessMs?: number;
  }>;
};

type OcrDebug = OcrRunDebugInfo & {
  chunks: OcrDebugChunk[];
};

type PaddleSummary = {
  modelName: string;
  provider?: RuntimeProvider;
  webnnDeviceType?: string;
  batchMode: PaddleOcrRunDebug["batchMode"];
  batchBucketWidth?: number;
  coldFirstSerial?: boolean;
  fixedInputWidth?: number;
  sessionOptionsKey?: string;
  inferenceRunCount: number;
  acceptedCount: number;
  rejectedCount: number;
  missingOutputCount: number;
  preprocessTotalMs: number;
  inferenceTotalMs: number;
  decodeTotalMs: number;
  colorFillMs: number;
  inputBytesTotal: number;
  outputBytesTotal: number;
  widthSummary: {
    min: number;
    max: number;
    avg: number;
    values: number[];
  };
};

type PipelineRun = {
  runIndex: number;
  isColdStart: boolean;
  totalMs: number;
  imageWidth: number;
  imageHeight: number;
  regionCount: number;
  sourceCharCount: number;
  sourceTexts: string[];
  regions: Array<{
    id: string;
    sourceText: string;
    probability?: number;
    box: { x: number; y: number; width: number; height: number };
    bubbleBox?: { x: number; y: number; width: number; height: number };
    originalLineCount?: number;
  }>;
  sampleTexts: string[];
  runtimeStages: Array<{ model: string; enabled: boolean; provider?: RuntimeProvider; detail: string }>;
  stageTimings: StageTiming[];
  ocrDebug: OcrDebug | null;
  ocrSummary: OcrSummary;
};

type OcrSummary = {
  stageMs: number;
  encoderCache: boolean;
  decodeSessionRunCount: number;
  decodeSessionRunTotalMs: number;
  decodeStepCount: number;
  encoderRunMs: number;
  decoderRunMs: number;
  gpuPostprocessStepCount: number;
  postprocessMs: number;
  colorDecodeMode: string;
  colorTotalMs: number;
  fallbackTriggerCount: number;
  paddle?: PaddleSummary;
};

type PaddleProfileResult = {
  extensionDir: string;
  ocrEngine: OcrEngine;
  processMode: ProcessMode;
  ocrCompactActiveBatch?: boolean;
  paddleBatchMode?: PaddleBatchCliMode;
  paddleProviderMode?: PaddleProviderCliMode;
  paddleColdFirstMode?: PaddleColdFirstCliMode;
  paddleModelMode?: PaddleModelCliMode;
  paddleFixedInputWidth?: number;
  paddleGraphCapture?: boolean;
  runs: PipelineRun[];
  warmMedian: {
    totalMs: number;
    ocrStageMs: number;
    decodeSessionRunTotalMs: number;
  };
};

type XImage = {
  pageUrl: string;
  imageUrl: string;
  contentType: string;
  dataUrl: string;
  bytes: number;
};

type PaddleProfileReport = {
  createdAt: string;
  xUrl: string;
  image: Omit<XImage, "dataUrl">;
  runCount: number;
  result: PaddleProfileResult;
};

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = process.argv.filter((value) => value.startsWith(prefix)).at(-1);
  return arg ? arg.slice(prefix.length) : null;
}

function pickUrl(): string {
  return argValue("url") ?? DEFAULT_X_URL;
}

function pickImageUrlOverride(): string | null {
  return argValue("image-url");
}

function pickImagePathOverride(): string | null {
  const raw = argValue("image");
  if (!raw) return null;
  const imagePath = resolve(raw);
  if (!existsSync(imagePath)) {
    throw new Error(`Image does not exist: ${imagePath}`);
  }
  return imagePath;
}

function pickRunCount(): number {
  const raw = argValue("runs");
  if (!raw) return 3;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --runs value: ${raw}`);
  }
  return parsed;
}

function normalizeOcrEngine(value: string): OcrEngine {
  switch (value) {
    case "paddle":
    case "paddleocr":
    case "paddleocr_v6_medium":
    case "v6-medium":
    case "paddle-v6-medium":
      return "paddleocr_v6_medium";
    default:
      throw new Error(`Invalid --ocr-engine value: ${value}`);
  }
}

function pickOcrEngine(): OcrEngine {
  const raw = argValue("ocr-engine");
  return raw ? normalizeOcrEngine(raw) : "paddleocr_v6_medium";
}

function pickProcessMode(): ProcessMode {
  const raw = argValue("process-mode");
  if (!raw) return "erase";
  if (raw === "translate" || raw === "erase" || raw === "original") {
    return raw;
  }
  throw new Error(`Invalid --process-mode value: ${raw}`);
}

function pickPaddleBatchMode(): PaddleBatchCliMode {
  if (process.argv.includes("--paddle-serial")) {
    return "serial";
  }
  if (process.argv.includes("--paddle-batch")) {
    return "width-bucket";
  }
  const raw = argValue("paddle-batch-mode");
  if (!raw) return "default";
  if (raw === "default" || raw === "serial" || raw === "width-bucket") {
    return raw;
  }
  throw new Error(`Invalid --paddle-batch-mode value: ${raw}`);
}

function pickPaddleProviderMode(): PaddleProviderCliMode {
  if (process.argv.includes("--paddle-wasm")) {
    return "wasm";
  }
  if (process.argv.includes("--paddle-webgpu")) {
    return "webgpu";
  }
  if (process.argv.includes("--paddle-webnn")) {
    return "webnn";
  }
  const raw = argValue("paddle-provider");
  if (!raw) return "default";
  if (raw === "default" || raw === "webgpu" || raw === "webnn" || raw === "wasm") {
    return raw;
  }
  throw new Error(`Invalid --paddle-provider value: ${raw}`);
}

function pickPaddleColdFirstMode(): PaddleColdFirstCliMode {
  if (process.argv.includes("--paddle-cold-first-serial")) {
    return "on";
  }
  if (process.argv.includes("--paddle-no-cold-first-serial")) {
    return "off";
  }
  const raw = argValue("paddle-cold-first-serial");
  if (!raw) return "default";
  if (raw === "default") return "default";
  if (raw === "true" || raw === "1" || raw === "yes" || raw === "on") return "on";
  if (raw === "false" || raw === "0" || raw === "no" || raw === "off") return "off";
  throw new Error(`Invalid --paddle-cold-first-serial value: ${raw}`);
}

function pickPaddleModelMode(): PaddleModelCliMode {
  const raw = argValue("paddle-model");
  if (!raw) return "medium";
  if (raw === "medium" || raw === "v6-medium" || raw === "paddleocr_v6_medium") {
    return "medium";
  }
  throw new Error(`Invalid --paddle-model value: ${raw}`);
}

function pickPaddleFixedInputWidth(): number | undefined {
  const raw = argValue("paddle-fixed-width");
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --paddle-fixed-width value: ${raw}`);
  }
  return parsed;
}

function pickPaddleGraphCapture(): boolean {
  return process.argv.includes("--paddle-graph-capture");
}

function pickOcrCompactActiveBatch(): boolean | undefined {
  if (process.argv.includes("--fixed-ocr-batch")) {
    return false;
  }
  const raw = argValue("ocr-compact-active-batch");
  if (!raw) return undefined;
  const normalized = raw.toLowerCase();
  if (normalized === "false" || normalized === "0" || normalized === "no") return false;
  if (normalized === "true" || normalized === "1" || normalized === "yes") return true;
  throw new Error(`Invalid --ocr-compact-active-batch value: ${raw}`);
}

function findChromeExecutable(): string | undefined {
  if (!USE_SYSTEM_CHROME) return undefined;
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Chrome executable not found. Set CHROME_PATH to chrome.exe.");
}

function requireDistAsset(relativePath: string): void {
  const fullPath = join(DIST_DIR, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Missing dist asset: ${fullPath}. Run npm run build first.`);
  }
}

function ensureDistReady(): void {
  const required = [
    "manifest.json",
    "content.js",
    "benchmark-chunks/orchestrator.js",
    "onnxWorker.js",
    "models/models.json",
    "models/detector.onnx",
    "models/aot_inpaint_512.onnx",
    "models/bubble.onnx",
    "models/PP-OCRv6_medium_rec.onnx",
    "models/paddleocr_v6_dict.txt",
    "ort/ort-wasm-simd-threaded.jsep.mjs",
    "ort/ort-wasm-simd-threaded.jsep.wasm",
  ];
  for (const item of required) {
    requireDistAsset(item);
  }
}

function toOrigTwitterImageUrl(input: string): string {
  const url = new URL(input);
  if (!url.hostname.endsWith("twimg.com")) {
    return input;
  }
  if (url.searchParams.has("name")) {
    url.searchParams.set("name", "orig");
  }
  return url.toString();
}

async function fetchImageFromContext(
  context: BrowserContext,
  imageUrl: string,
  referer: string
): Promise<XImage> {
  const response = await context.request.get(imageUrl, {
    headers: {
      referer,
    },
    timeout: 120000,
  });
  if (!response.ok()) {
    throw new Error(`Image fetch failed: ${response.status()} ${response.statusText()} ${imageUrl}`);
  }
  const body = await response.body();
  const contentType = response.headers()["content-type"]?.split(";")[0] ?? contentTypeFromUrl(imageUrl);
  return {
    pageUrl: referer,
    imageUrl,
    contentType,
    dataUrl: `data:${contentType};base64,${body.toString("base64")}`,
    bytes: body.length,
  };
}

function loadImageFromFile(imagePath: string): XImage {
  const body = readFileSync(imagePath);
  const contentType = contentTypeFromFilePath(imagePath);
  return {
    pageUrl: imagePath,
    imageUrl: imagePath,
    contentType,
    dataUrl: `data:${contentType};base64,${body.toString("base64")}`,
    bytes: body.length,
  };
}

async function resolveXImage(xUrl: string, imageUrlOverride: string | null): Promise<XImage> {
  const chromePath = findChromeExecutable();
  const browser = await chromium.launch({
    ...(chromePath ? { executablePath: chromePath } : {}),
    headless: false,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });
  try {
    const context = await browser.newContext();
    if (imageUrlOverride) {
      return await fetchImageFromContext(context, toOrigTwitterImageUrl(imageUrlOverride), xUrl);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    await page.goto(xUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForTimeout(5000);
    const candidates = await page.evaluate(() => {
      const urls = new Set<string>();
      for (const selector of ["meta[property='og:image']", "meta[name='twitter:image']"]) {
        for (const node of Array.from(document.querySelectorAll<HTMLMetaElement>(selector))) {
          if (node.content) urls.add(node.content);
        }
      }
      for (const node of Array.from(document.querySelectorAll<HTMLImageElement>("img"))) {
        if (node.src.includes("pbs.twimg.com/media")) urls.add(node.src);
      }
      return Array.from(urls);
    });
    const imageCandidate = candidates.find((url) => url.includes("pbs.twimg.com/media"));
    if (!imageCandidate) {
      throw new Error(`Could not find a pbs.twimg.com image on ${xUrl}. candidates=${JSON.stringify(candidates)}`);
    }
    const imageUrl = toOrigTwitterImageUrl(imageCandidate);
    return await fetchImageFromContext(context, imageUrl, page.url());
  } finally {
    await browser.close();
  }
}

function contentTypeFromUrl(url: string): string {
  const parsed = new URL(url);
  const format = parsed.searchParams.get("format")?.toLowerCase();
  if (format === "jpg" || format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  const ext = extname(parsed.pathname).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

function rmInsideTmp(target: string): void {
  const tmpFull = resolve(TMP_DIR);
  const targetFull = resolve(target);
  if (!targetFull.startsWith(tmpFull + "\\")) {
    throw new Error(`Refusing to delete outside .tmp: ${targetFull}`);
  }
  if (existsSync(targetFull)) {
    rmSync(targetFull, { recursive: true, force: true });
  }
}

async function startProbeServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/" && url.pathname !== "/probe.html") {
      const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      const filePath = resolve(DIST_DIR, relativePath);
      const distRoot = resolve(DIST_DIR);
      if (!filePath.startsWith(distRoot + sep) || !existsSync(filePath)) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": contentTypeFromFilePath(filePath),
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
        "cross-origin-resource-policy": "same-origin",
      });
      res.end(readFileSync(filePath));
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cross-origin-resource-policy": "same-origin",
    });
    res.end("<!doctype html><meta charset=\"utf-8\"><title>Paddle OCR profile</title><body>Paddle OCR profile</body>");
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/probe.html`,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    }),
  };
}

function contentTypeFromFilePath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".wasm") return "application/wasm";
  if (ext === ".onnx") return "application/octet-stream";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function summarizePaddleDebug(paddle: PaddleOcrRunDebug | undefined): PaddleSummary | undefined {
  if (!paddle) return undefined;
  const widths = paddle.regions.map((region) => region.resizedWidth);
  const widthSummary = widths.length > 0
    ? {
        min: Math.min(...widths),
        max: Math.max(...widths),
        avg: round(widths.reduce((sum, width) => sum + width, 0) / widths.length),
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
    coldFirstSerial: paddle.coldFirstSerial,
    fixedInputWidth: paddle.fixedInputWidth,
    sessionOptionsKey: paddle.sessionOptionsKey,
    inferenceRunCount: paddle.inferenceRuns.length,
    acceptedCount: paddle.acceptedCount,
    rejectedCount: paddle.rejectedCount,
    missingOutputCount: paddle.missingOutputCount,
    preprocessTotalMs: round(paddle.preprocessTotalMs),
    inferenceTotalMs: round(paddle.inferenceTotalMs),
    decodeTotalMs: round(paddle.decodeTotalMs),
    colorFillMs: round(paddle.colorFillMs ?? 0),
    inputBytesTotal: paddle.inputBytesTotal,
    outputBytesTotal: paddle.outputBytesTotal,
    widthSummary,
  };
}

function summarizeOcr(run: PipelineRun): OcrSummary {
  const stageMs = run.stageTimings.find((stage) => stage.stage === "ocr")?.durationMs ?? 0;
  const debug = run.ocrDebug;
  if (!debug) {
    return {
      stageMs,
      encoderCache: false,
      decodeSessionRunCount: 0,
      decodeSessionRunTotalMs: 0,
      decodeStepCount: 0,
      encoderRunMs: 0,
      decoderRunMs: 0,
      gpuPostprocessStepCount: 0,
      postprocessMs: 0,
      colorDecodeMode: "none",
      colorTotalMs: 0,
      fallbackTriggerCount: 0,
      paddle: undefined,
    };
  }
  const chunks = debug.chunks ?? [];
  return {
    stageMs,
    encoderCache: chunks.some((chunk) => chunk.encoderCache === true),
    decodeSessionRunCount: chunks.reduce((sum, chunk) => sum + chunk.decodeSessionRunCount, 0),
    decodeSessionRunTotalMs: chunks.reduce((sum, chunk) => sum + chunk.decodeSessionRunTotalMs, 0),
    decodeStepCount: chunks.reduce((sum, chunk) => sum + chunk.decodeSteps.length, 0),
    encoderRunMs: chunks.reduce((sum, chunk) => sum + (chunk.encoderRunMs ?? 0), 0),
    decoderRunMs: chunks.reduce((sum, chunk) => sum + (chunk.decoderRunMs ?? 0), 0),
    gpuPostprocessStepCount: chunks.reduce(
      (sum, chunk) => sum + chunk.decodeSteps.filter((step) => step.postprocessMode === "gpu").length,
      0
    ),
    postprocessMs: chunks.reduce(
      (sum, chunk) => sum + chunk.decodeSteps.reduce((inner, step) => inner + (step.postprocessMs ?? 0), 0),
      0
    ),
    colorDecodeMode: debug.colorDecodeMode,
    colorTotalMs: debug.colorTotalMs,
    fallbackTriggerCount: debug.fallbackTriggerCount,
    paddle: summarizePaddleDebug(debug.paddle),
  };
}

function warmRuns(runs: PipelineRun[]): PipelineRun[] {
  const warm = runs.filter((run) => !run.isColdStart);
  return warm.length > 0 ? warm : runs;
}

function computeWarmMedian(runs: PipelineRun[]): PaddleProfileResult["warmMedian"] {
  const selected = warmRuns(runs);
  return {
    totalMs: round(median(selected.map((run) => run.totalMs))),
    ocrStageMs: round(median(selected.map((run) => run.ocrSummary.stageMs))),
    decodeSessionRunTotalMs: round(median(selected.map((run) => run.ocrSummary.decodeSessionRunTotalMs))),
  };
}

async function runPaddleProfile(
  pageUrl: string,
  image: XImage,
  runs: number,
  ocrCompactActiveBatch: boolean | undefined,
  ocrEngine: OcrEngine,
  processMode: ProcessMode,
  paddleBatchMode: PaddleBatchCliMode,
  paddleProviderMode: PaddleProviderCliMode,
  paddleColdFirstMode: PaddleColdFirstCliMode,
  paddleModelMode: PaddleModelCliMode,
  paddleFixedInputWidth: number | undefined,
  paddleGraphCapture: boolean,
): Promise<PaddleProfileResult> {
  const label = "paddle-profile";
  const userDataDir = join(TMP_DIR, `paddle-profile-web-${Date.now()}`);
  rmInsideTmp(userDataDir);
  mkdirSync(userDataDir, { recursive: true });
  const chromePath = findChromeExecutable();
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...(chromePath ? { executablePath: chromePath } : {}),
    headless: false,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--enable-unsafe-webgpu",
    ],
  });
  context.setDefaultTimeout(900000);
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(900000);
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("[ocr] encoder cache")) return;
      console.log(`[${label}:browser:${message.type()}] ${text}`);
    });
    page.on("pageerror", (error) => {
      console.log(`[${label}:pageerror] ${error.message}`);
    });
    await page.goto(new URL('/benchmark.html', pageUrl).toString(), { waitUntil: "load" });
    await page.evaluate(() => {
      (window as typeof window & {
        chrome?: { runtime: { getURL(path: string): string } };
      }).chrome = {
        runtime: {
          getURL(path: string) {
            return new URL(path.replace(/^\/+/, ""), `${location.origin}/`).toString();
          },
        },
      };
    });
    await page.waitForFunction(() => Boolean((window as any).__shinobuBenchmark__), undefined, { timeout: 30000 });
    await page.evaluate("var __name = (target) => target;");
    const results: PipelineRun[] = [];
    for (let i = 0; i < runs; i += 1) {
      const run = await page.evaluate<PipelineRun, {
        dataUrl: string;
        contentType: string;
        runIndex: number;
        ocrCompactActiveBatch?: boolean;
        ocrEngine: OcrEngine;
        processMode: ProcessMode;
        paddleBatchMode: PaddleBatchCliMode;
        paddleProviderMode: PaddleProviderCliMode;
        paddleColdFirstMode: PaddleColdFirstCliMode;
        paddleModelMode: PaddleModelCliMode;
        paddleFixedInputWidth?: number;
        paddleGraphCapture: boolean;
      }>(
        async ({
          dataUrl,
          contentType,
          runIndex,
          ocrCompactActiveBatch,
          ocrEngine,
          processMode,
          paddleBatchMode,
          paddleProviderMode,
          paddleColdFirstMode,
          paddleModelMode,
          paddleFixedInputWidth,
          paddleGraphCapture,
        }) => {
          type PaddleRuntimeFlags = typeof globalThis & {
            __shinobuPaddleOcrWidthBucketBatch?: boolean;
            __shinobuPaddleOcrColdFirstSerial?: boolean;
            __shinobuPaddleOcrModelName?: "paddleocr_v6_medium_rec";
            __shinobuPaddleOcrFixedInputWidth?: number;
          };
          type BenchmarkApi = {
            runPipeline(
              file: File,
              config: Record<string, unknown>,
              onProgress: () => void,
              options?: {
                runtimeCapabilities?: {
                  providerExecution?: {
                    policy: {
                      schemaVersion: 1;
                      contract: {
                        id: string;
                        version: number;
                      };
                      rules: Array<{
                        model: "paddleocr_v6_medium_rec";
                        stage: "ocr";
                        providers: RuntimeProvider[];
                      }>;
                    };
                    sessionOptionsByModel?: {
                      paddleocr_v6_medium_rec?: {
                        enableGraphCapture?: boolean;
                        preferredOutputLocation?: "gpu-buffer";
                        freeDimensionOverrides?: Record<string, number>;
                      };
                    };
                  };
                  ocrExecution?: {
                    compactActiveBatch?: boolean;
                  };
                };
              },
            ): Promise<{
              original: { naturalWidth: number; naturalHeight: number };
              detectedRegions: Array<{
                id: string;
                sourceText: string;
                prob?: number;
                box: { x: number; y: number; width: number; height: number };
                bubbleBox?: { x: number; y: number; width: number; height: number };
                originalLineCount?: number;
              }>;
              runtimeStages: PipelineRun["runtimeStages"];
              stageTimings: StageTiming[];
              ocrDebug: OcrDebug | null;
            }>;
          };
          const runtimeFlags = globalThis as PaddleRuntimeFlags;
          if (paddleBatchMode === "serial") {
            runtimeFlags.__shinobuPaddleOcrWidthBucketBatch = false;
          } else if (paddleBatchMode === "width-bucket") {
            runtimeFlags.__shinobuPaddleOcrWidthBucketBatch = true;
          } else {
            delete runtimeFlags.__shinobuPaddleOcrWidthBucketBatch;
          }
          if (paddleColdFirstMode === "default") {
            delete runtimeFlags.__shinobuPaddleOcrColdFirstSerial;
          } else {
            runtimeFlags.__shinobuPaddleOcrColdFirstSerial = paddleColdFirstMode === "on";
          }
          runtimeFlags.__shinobuPaddleOcrModelName = paddleModelMode === "medium"
            ? "paddleocr_v6_medium_rec"
            : undefined;
          if (typeof paddleFixedInputWidth === "number") {
            runtimeFlags.__shinobuPaddleOcrFixedInputWidth = paddleFixedInputWidth;
          } else {
            delete runtimeFlags.__shinobuPaddleOcrFixedInputWidth;
          }
          const api = (globalThis as typeof globalThis & { __shinobuBenchmark__?: BenchmarkApi }).__shinobuBenchmark__;
          if (!api) throw new Error("Benchmark API is unavailable");
          const blob = await (await fetch(dataUrl)).blob();
          const file = new File([blob], `x-source.${contentType.includes("jpeg") ? "jpg" : "png"}`, { type: contentType });
          const config = {
            sourceLang: "ja",
            targetLang: "zh-CHS",
            translator: "google_web",
            llmProvider: "deepseek",
            llmBaseUrl: "https://api.deepseek.com",
            llmApiKey: "",
            llmModel: "deepseek-v4-flash",
            llmTemperature: 1,
            typesetDebug: false,
            eraseDebug: false,
            collectDebugLog: false,
            ocrEngine,
            processMode,
          };
          const totalT0 = performance.now();
          const artifacts = await api.runPipeline(file, config, () => {}, {
            runtimeCapabilities: {
              providerExecution: {
                policy: {
                  schemaVersion: 1,
                  contract: {
                    id: "shinobu.benchmark-provider-policy",
                    version: 1,
                  },
                  rules: paddleProviderMode === "default"
                    ? []
                    : [{
                        model: "paddleocr_v6_medium_rec",
                        stage: "ocr",
                        providers: [paddleProviderMode],
                      }],
                },
                ...(paddleGraphCapture
                  ? {
                      sessionOptionsByModel: {
                        paddleocr_v6_medium_rec: {
                          enableGraphCapture: true,
                          preferredOutputLocation: "gpu-buffer",
                          freeDimensionOverrides: {
                            "DynamicDimension.0": 1,
                            "DynamicDimension.1": paddleFixedInputWidth ?? 320,
                          },
                        },
                      },
                    }
                  : {}),
              },
              ocrExecution: {
                compactActiveBatch: ocrCompactActiveBatch,
              },
            },
          });
          const totalMs = performance.now() - totalT0;
          const sourceTexts = artifacts.detectedRegions.map((region) => region.sourceText);
          const regions = artifacts.detectedRegions.map((region) => ({
            id: region.id,
            sourceText: region.sourceText,
            probability: region.prob,
            box: { ...region.box },
            bubbleBox: region.bubbleBox ? { ...region.bubbleBox } : undefined,
            originalLineCount: region.originalLineCount,
          }));
          return {
            runIndex,
            isColdStart: runIndex === 0,
            totalMs,
            imageWidth: artifacts.original.naturalWidth,
            imageHeight: artifacts.original.naturalHeight,
            regionCount: artifacts.detectedRegions.length,
            sourceCharCount: sourceTexts.reduce((sum, text) => sum + text.length, 0),
            sourceTexts,
            regions,
            sampleTexts: sourceTexts.filter((text) => text.length > 0).slice(0, 5),
            runtimeStages: artifacts.runtimeStages,
            stageTimings: artifacts.stageTimings,
            ocrDebug: artifacts.ocrDebug,
            ocrSummary: {
              stageMs: 0,
              encoderCache: false,
              decodeSessionRunCount: 0,
              decodeSessionRunTotalMs: 0,
              decodeStepCount: 0,
              encoderRunMs: 0,
              decoderRunMs: 0,
              gpuPostprocessStepCount: 0,
              postprocessMs: 0,
              colorDecodeMode: "none",
              colorTotalMs: 0,
              fallbackTriggerCount: 0,
            },
          };
        },
        {
          dataUrl: image.dataUrl,
          contentType: image.contentType,
          runIndex: i,
          ocrCompactActiveBatch,
          ocrEngine,
          processMode,
          paddleBatchMode,
          paddleProviderMode,
          paddleColdFirstMode,
          paddleModelMode,
          paddleFixedInputWidth,
          paddleGraphCapture,
        }
      );
      run.ocrSummary = summarizeOcr(run);
      results.push(roundRun(run));
      console.log(`${label} run ${i + 1}/${runs}: total=${formatMs(run.totalMs)}, ocr=${formatMs(run.ocrSummary.stageMs)}, decode=${formatMs(run.ocrSummary.decodeSessionRunTotalMs)}, encoderCache=${run.ocrSummary.encoderCache}`);
    }
    return {
      extensionDir: DIST_DIR,
      ocrEngine,
      processMode,
      ocrCompactActiveBatch,
      paddleBatchMode,
      paddleProviderMode,
      paddleColdFirstMode,
      paddleModelMode,
      paddleFixedInputWidth,
      paddleGraphCapture,
      runs: results,
      warmMedian: computeWarmMedian(results),
    };
  } finally {
    await context.close();
  }
}

function roundRun(run: PipelineRun): PipelineRun {
  return {
    ...run,
    totalMs: round(run.totalMs),
    stageTimings: run.stageTimings.map((stage) => ({ ...stage, durationMs: round(stage.durationMs) })),
    ocrSummary: {
      ...run.ocrSummary,
      stageMs: round(run.ocrSummary.stageMs),
      decodeSessionRunTotalMs: round(run.ocrSummary.decodeSessionRunTotalMs),
      encoderRunMs: round(run.ocrSummary.encoderRunMs),
      decoderRunMs: round(run.ocrSummary.decoderRunMs),
      postprocessMs: round(run.ocrSummary.postprocessMs),
      colorTotalMs: round(run.ocrSummary.colorTotalMs),
    },
  };
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

function printSummary(report: PaddleProfileReport): void {
  console.log("\n=== Paddle OCR browser profile ===");
  console.log(`URL: ${report.xUrl}`);
  console.log(`Image: ${report.image.imageUrl}`);
  const result = report.result;
  console.log(`  OCR engine:        ${result.ocrEngine}`);
  console.log(`  process mode:      ${result.processMode}`);
  if (typeof result.ocrCompactActiveBatch === "boolean") {
    console.log(`  OCR compact batch: ${result.ocrCompactActiveBatch}`);
  }
  if (result.paddleBatchMode) {
    console.log(`  Paddle batch mode: ${result.paddleBatchMode}`);
  }
  if (result.paddleProviderMode) {
    console.log(`  Paddle provider mode: ${result.paddleProviderMode}`);
  }
  if (result.paddleColdFirstMode) {
    console.log(`  Paddle cold-first: ${result.paddleColdFirstMode}`);
  }
  if (result.paddleModelMode) {
    console.log(`  Paddle model:      ${result.paddleModelMode}`);
  }
  if (typeof result.paddleFixedInputWidth === "number") {
    console.log(`  Paddle fixed W:    ${result.paddleFixedInputWidth}`);
  }
  if (result.paddleGraphCapture) {
    console.log("  Paddle graph cap:  true");
  }
  console.log(`  warm median total: ${formatMs(result.warmMedian.totalMs)}`);
  console.log(`  warm median OCR:   ${formatMs(result.warmMedian.ocrStageMs)}`);
  console.log(`  warm median decode:${formatMs(result.warmMedian.decodeSessionRunTotalMs)}`);
  const latestWarm = warmRuns(result.runs).at(-1) ?? result.runs.at(-1);
  if (latestWarm) {
    console.log(`  regions/chars:     ${latestWarm.regionCount}/${latestWarm.sourceCharCount}`);
    console.log(`  sample:            ${latestWarm.sampleTexts.slice(0, 3).join(" | ")}`);
    if (latestWarm.ocrSummary.paddle) {
      const paddle = latestWarm.ocrSummary.paddle;
      console.log(`  Paddle provider:   ${paddle.provider ?? "unknown"}${paddle.webnnDeviceType ? `/${paddle.webnnDeviceType}` : ""}`);
      console.log(`  Paddle batch:      ${paddle.batchMode}${paddle.batchBucketWidth ? ` ${paddle.batchBucketWidth}px` : ""}, coldFirst=${paddle.coldFirstSerial === true}, runs=${paddle.inferenceRunCount}`);
      if (typeof paddle.fixedInputWidth === "number" || paddle.sessionOptionsKey) {
        console.log(`  Paddle options:    fixedW=${paddle.fixedInputWidth ?? "default"}, session=${paddle.sessionOptionsKey ?? "default"}`);
      }
      console.log(`  Paddle OCR split:  preprocess=${formatMs(paddle.preprocessTotalMs)}, inference=${formatMs(paddle.inferenceTotalMs)}, ctc=${formatMs(paddle.decodeTotalMs)}, color=${formatMs(paddle.colorFillMs)}`);
      console.log(`  Paddle widths:     min=${paddle.widthSummary.min}, max=${paddle.widthSummary.max}, avg=${paddle.widthSummary.avg}`);
    }
  }
}

async function main(): Promise<void> {
  const ocrEngine = pickOcrEngine();
  const processMode = pickProcessMode();
  const paddleBatchMode = pickPaddleBatchMode();
  const paddleProviderMode = pickPaddleProviderMode();
  const paddleColdFirstMode = pickPaddleColdFirstMode();
  const paddleModelMode = pickPaddleModelMode();
  const paddleFixedInputWidth = pickPaddleFixedInputWidth();
  const paddleGraphCapture = pickPaddleGraphCapture();
  ensureDistReady();
  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(REPORTS_DIR, { recursive: true });
  const xUrl = pickUrl();
  const imageUrlOverride = pickImageUrlOverride();
  const imagePathOverride = pickImagePathOverride();
  const runs = pickRunCount();
  const ocrCompactActiveBatch = pickOcrCompactActiveBatch();
  console.log(`Browser profile config: ocr=${ocrEngine}, process=${processMode}, paddleBatch=${paddleBatchMode}, paddleProvider=${paddleProviderMode}, paddleColdFirst=${paddleColdFirstMode}, paddleModel=${paddleModelMode}, paddleFixedW=${paddleFixedInputWidth ?? "default"}, paddleGraphCapture=${paddleGraphCapture}, runs=${runs}`);
  console.log(imagePathOverride ? `Loading local image: ${imagePathOverride}` : `Resolving X image: ${xUrl}`);
  const image = imagePathOverride ? loadImageFromFile(imagePathOverride) : await resolveXImage(xUrl, imageUrlOverride);
  console.log(`Resolved image: ${image.imageUrl} (${image.contentType}, ${image.bytes} bytes)`);
  const server = await startProbeServer();
  try {
    const result = await runPaddleProfile(
      server.url,
      image,
      runs,
      ocrCompactActiveBatch,
      ocrEngine,
      processMode,
      paddleBatchMode,
      paddleProviderMode,
      paddleColdFirstMode,
      paddleModelMode,
      paddleFixedInputWidth,
      paddleGraphCapture,
    );
    const report: PaddleProfileReport = {
      createdAt: new Date().toISOString(),
      xUrl,
      image: {
        pageUrl: image.pageUrl,
        imageUrl: image.imageUrl,
        contentType: image.contentType,
        bytes: image.bytes,
      },
      runCount: runs,
      result,
    };
    printSummary(report);
    const reportPath = join(REPORTS_DIR, `paddle-profile-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nReport saved: ${reportPath}`);
  } finally {
    await server.close();
  }
}

await main();
