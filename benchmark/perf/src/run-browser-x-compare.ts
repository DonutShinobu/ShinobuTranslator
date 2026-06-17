import { createServer } from "http";
import type { AddressInfo } from "net";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, extname, join, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { chromium } from "@playwright/test";
import type { BrowserContext } from "@playwright/test";
import type { OcrEngine, ProcessMode } from "../../../src/shared/config";
import type { OcrRunDebugInfo, PaddleOcrRunDebug } from "../../../src/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DIST_DIR = join(ROOT, "dist");
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

type ModeResult = {
  mode: "old-full-ar" | "new-split" | "current";
  extensionDir: string;
  ocrEngine: OcrEngine;
  processMode: ProcessMode;
  ocrCompactActiveBatch?: boolean;
  paddleBatchMode?: PaddleBatchCliMode;
  paddleProviderMode?: PaddleProviderCliMode;
  paddleColdFirstMode?: PaddleColdFirstCliMode;
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

type CompareReport = {
  createdAt: string;
  xUrl: string;
  image: Omit<XImage, "dataUrl">;
  runsPerMode: number;
  modes: ModeResult[];
  improvement?: {
    totalMsSaved: number;
    totalPct: number;
    totalSpeedup: number;
    ocrStageMsSaved: number;
    ocrStagePct: number;
    ocrStageSpeedup: number;
    decodeSessionRunMsSaved: number;
    decodeSessionRunPct: number;
    decodeSessionRunSpeedup: number;
  };
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
    case "48px":
    case "builtin":
      return "48px";
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
  return raw ? normalizeOcrEngine(raw) : "48px";
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

function pickPrewarmOcrBatch(): number {
  const raw = argValue("prewarm-ocr-batch");
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid --prewarm-ocr-batch value: ${raw}`);
  }
  return parsed;
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

function isCurrentOnly(): boolean {
  return process.argv.includes("--current-only") || argValue("mode") === "current";
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

function ensureDistReady(options: { includeLegacyOcr: boolean; ocrEngine: OcrEngine }): void {
  const required = [
    "manifest.json",
    "content.js",
    "chunks/orchestrator.js",
    "onnxWorker.js",
    "models/models.json",
    "models/ocr_encoder.onnx",
    "models/ocr_decoder.onnx",
    "models/detector.onnx",
    "models/lama_fp32.onnx",
    "models/bubble.onnx",
    "ort/ort-wasm-simd-threaded.jsep.mjs",
    "ort/ort-wasm-simd-threaded.jsep.wasm",
  ];
  if (options.includeLegacyOcr) {
    required.push("models/ocr.onnx");
  }
  if (options.ocrEngine === "paddleocr_v6_medium") {
    required.push("models/PP-OCRv6_medium_rec.onnx", "models/paddleocr_v6_dict.txt");
  }
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

function createOldFullArExtensionDir(): string {
  const target = join(TMP_DIR, `x-compare-old-full-ar-${Date.now()}`);
  rmInsideTmp(target);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(DIST_DIR, target, { recursive: true });
  const manifestPath = join(target, "models/models.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    models?: Record<string, unknown>;
  };
  if (!manifest.models) {
    throw new Error(`Invalid model manifest: ${manifestPath}`);
  }
  delete manifest.models.ocr_encoder;
  delete manifest.models.ocr_decoder;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return target;
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
    res.end("<!doctype html><meta charset=\"utf-8\"><title>x compare</title><body>x compare</body>");
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

function computeWarmMedian(runs: PipelineRun[]): ModeResult["warmMedian"] {
  const selected = warmRuns(runs);
  return {
    totalMs: round(median(selected.map((run) => run.totalMs))),
    ocrStageMs: round(median(selected.map((run) => run.ocrSummary.stageMs))),
    decodeSessionRunTotalMs: round(median(selected.map((run) => run.ocrSummary.decodeSessionRunTotalMs))),
  };
}

function improvement(oldMs: number, newMs: number): { saved: number; pct: number; speedup: number } {
  if (oldMs <= 0 || newMs <= 0) {
    return { saved: 0, pct: 0, speedup: 0 };
  }
  return {
    saved: round(oldMs - newMs),
    pct: round(((oldMs - newMs) / oldMs) * 100),
    speedup: round(oldMs / newMs),
  };
}

async function runMode(
  mode: ModeResult["mode"],
  extensionDir: string,
  image: XImage,
  runs: number,
  ocrEngine: OcrEngine,
  processMode: ProcessMode,
): Promise<ModeResult> {
  const userDataDir = join(TMP_DIR, `x-compare-${mode}-${Date.now()}`);
  rmInsideTmp(userDataDir);
  mkdirSync(userDataDir, { recursive: true });
  const chromePath = findChromeExecutable();
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...(chromePath ? { executablePath: chromePath } : {}),
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--enable-unsafe-webgpu",
    ],
  });
  context.setDefaultTimeout(900000);
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 30000 });
    const extensionId = worker.url().match(/^chrome-extension:\/\/([^/]+)/)?.[1];
    if (!extensionId) {
      throw new Error(`Unable to parse extension id from service worker URL: ${worker.url()}`);
    }
    const extensionUrl = (path: string) => `chrome-extension://${extensionId}/${path.replace(/^\/+/, "")}`;
    const page = await context.newPage();
    page.setDefaultTimeout(900000);
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("[ocr] encoder cache")) return;
      console.log(`[${mode}:browser:${message.type()}] ${text}`);
    });
    page.on("pageerror", (error) => {
      console.log(`[${mode}:pageerror] ${error.message}`);
    });
    await page.goto(extensionUrl("popup.html"), { waitUntil: "load" });
    await page.addScriptTag({ url: extensionUrl("content.js") });
    await page.waitForFunction(() => Boolean((window as any).__shinobu_shared), undefined, { timeout: 30000 });
    await page.evaluate("var __name = (target) => target;");

    const results: PipelineRun[] = [];
    for (let i = 0; i < runs; i += 1) {
      const run = await page.evaluate<PipelineRun, {
        dataUrl: string;
        contentType: string;
        runIndex: number;
        ocrEngine: OcrEngine;
        processMode: ProcessMode;
      }>(
        async ({ dataUrl, contentType, runIndex, ocrEngine, processMode }) => {
          type Orchestrator = {
            runPipeline(file: File, config: Record<string, unknown>, onProgress: () => void): Promise<{
              original: { naturalWidth: number; naturalHeight: number };
              detectedRegions: Array<{ sourceText: string }>;
              runtimeStages: PipelineRun["runtimeStages"];
              stageTimings: StageTiming[];
              ocrDebug: OcrDebug | null;
            }>;
          };
          const chromeApi = (globalThis as any).chrome;
          const module = await import(chromeApi.runtime.getURL("chunks/orchestrator.js")) as Orchestrator;
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
          const artifacts = await module.runPipeline(file, config, () => {});
          const totalMs = performance.now() - totalT0;
          const sourceTexts = artifacts.detectedRegions.map((region) => region.sourceText);
          const runResult = {
            runIndex,
            isColdStart: runIndex === 0,
            totalMs,
            imageWidth: artifacts.original.naturalWidth,
            imageHeight: artifacts.original.naturalHeight,
            regionCount: artifacts.detectedRegions.length,
            sourceCharCount: sourceTexts.reduce((sum, text) => sum + text.length, 0),
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
          return runResult;
        },
        { dataUrl: image.dataUrl, contentType: image.contentType, runIndex: i, ocrEngine, processMode }
      );
      run.ocrSummary = summarizeOcr(run);
      results.push(roundRun(run));
      console.log(`${mode} run ${i + 1}/${runs}: total=${formatMs(run.totalMs)}, ocr=${formatMs(run.ocrSummary.stageMs)}, decode=${formatMs(run.ocrSummary.decodeSessionRunTotalMs)}, encoderCache=${run.ocrSummary.encoderCache}`);
    }
    return {
      mode,
      extensionDir,
      ocrEngine,
      processMode,
      runs: results,
      warmMedian: computeWarmMedian(results),
    };
  } finally {
    await context.close();
  }
}

async function runCurrentWebMode(
  pageUrl: string,
  image: XImage,
  runs: number,
  prewarmOcrBatch: number,
  ocrCompactActiveBatch: boolean | undefined,
  ocrEngine: OcrEngine,
  processMode: ProcessMode,
  paddleBatchMode: PaddleBatchCliMode,
  paddleProviderMode: PaddleProviderCliMode,
  paddleColdFirstMode: PaddleColdFirstCliMode,
): Promise<ModeResult> {
  const mode: ModeResult["mode"] = "current";
  const userDataDir = join(TMP_DIR, `x-current-web-${Date.now()}`);
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
      console.log(`[${mode}:browser:${message.type()}] ${text}`);
    });
    page.on("pageerror", (error) => {
      console.log(`[${mode}:pageerror] ${error.message}`);
    });
    await page.goto(pageUrl, { waitUntil: "load" });
    await page.evaluate(() => {
      (window as any).chrome = {
        runtime: {
          getURL(path: string) {
            return new URL(path.replace(/^\/+/, ""), `${location.origin}/`).toString();
          },
          onMessage: {
            addListener() {
              // No-op shim for the benchmark web harness.
            },
          },
        },
      };
    });
    await page.addScriptTag({ url: "/content.js" });
    await page.waitForFunction(() => Boolean((window as any).__shinobu_shared), undefined, { timeout: 30000 });
    await page.evaluate("var __name = (target) => target;");
    if (prewarmOcrBatch > 0 && ocrEngine !== "48px") {
      console.log(`current OCR prewarm skipped: --prewarm-ocr-batch is only for 48px OCR, current engine=${ocrEngine}`);
    }
    if (prewarmOcrBatch > 0 && ocrEngine === "48px") {
      const warmup = await page.evaluate(async ({ batchSize, compactActiveBatch }) => {
        type RuntimeProvider = "webnn" | "webgpu" | "wasm";
        type SessionHandle = {
          sessionId: string;
          provider: RuntimeProvider;
          inputNames: string[];
          outputNames: string[];
        };
        type DecodeItem = {
          regionId: string;
          imageData: Float32Array;
          imageDims: number[];
          validEncoderLength: number;
        };
        type Bridge = {
          createSession(modelKey: string, modelUrl: string, preferred: RuntimeProvider[]): Promise<SessionHandle>;
          runOcrSplitBatchDecode(
            encoderSessionId: string,
            decoderSessionId: string,
            inputNames: {
              encoderImageInput: string;
              encoderMaskInput: string;
              memoryOutput: string;
              decoderMemoryInput: string;
              decoderCharIdxInput: string;
              decoderMaskInput: string;
              decoderEncoderMaskInput: string;
            },
            items: DecodeItem[],
            options: {
              seqLen: number;
              encoderLen: number;
              maxSteps: number;
              charset: string[] | null;
              inputHeight: number;
              inputWidth: number;
              compactActiveBatch?: boolean;
            }
          ): Promise<{ telemetry: { sessionRunCount: number; sessionRunTotalMs: number; encoderRunMs?: number; decoderRunMs?: number } }>;
        };

        const pickName = (names: string[], candidates: string[], fallbackIndex = 0): string => {
          for (const candidate of candidates) {
            const exact = names.find((name) => name.toLowerCase() === candidate.toLowerCase());
            if (exact) return exact;
          }
          for (const candidate of candidates) {
            const fuzzy = names.find((name) => name.toLowerCase().includes(candidate.toLowerCase()));
            if (fuzzy) return fuzzy;
          }
          const fallback = names[fallbackIndex];
          if (!fallback) throw new Error(`No input/output name available. candidates=${candidates.join(",")}`);
          return fallback;
        };

        const bridge = await import("/chunks/onnxWorkerBridge.js") as Bridge;
        const assetUrl = (path: string) => new URL(path.replace(/^\/+/, ""), `${location.origin}/`).toString();
        const createT0 = performance.now();
        const encoder = await bridge.createSession("ocr_encoder", assetUrl("/models/ocr_encoder.onnx"), ["webgpu", "wasm"]);
        const decoder = await bridge.createSession("ocr_decoder", assetUrl("/models/ocr_decoder.onnx"), [encoder.provider]);
        const createMs = performance.now() - createT0;
        const dictResponse = await fetch(assetUrl("/models/ocr_dict.txt"));
        const charset = dictResponse.ok ? (await dictResponse.text()).split(/\r?\n/g).filter((line) => line.length > 0) : null;
        const inputHeight = 48;
        const inputWidth = 320;
        const encoderLen = 80;
        const seqLen = 64;
        const pixels = 3 * inputHeight * inputWidth;
        const items = Array.from({ length: batchSize }, (_, index) => ({
          regionId: `prewarm-${index}`,
          imageData: new Float32Array(pixels),
          imageDims: [1, 3, inputHeight, inputWidth],
          validEncoderLength: encoderLen,
        }));
        const runT0 = performance.now();
        const decode = await bridge.runOcrSplitBatchDecode(
          encoder.sessionId,
          decoder.sessionId,
          {
            encoderImageInput: pickName(encoder.inputNames, ["image", "input"], 0),
            encoderMaskInput: pickName(encoder.inputNames, ["encoder_mask", "mask"], 1),
            memoryOutput: pickName(encoder.outputNames, ["memory", "encoder"], 0),
            decoderMemoryInput: pickName(decoder.inputNames, ["memory", "encoder"], 0),
            decoderCharIdxInput: pickName(decoder.inputNames, ["char_idx", "char"], 1),
            decoderMaskInput: pickName(decoder.inputNames, ["decoder_mask"], 2),
            decoderEncoderMaskInput: pickName(decoder.inputNames, ["encoder_mask"], 3),
          },
          items,
          { seqLen, encoderLen, maxSteps: 1, charset, inputHeight, inputWidth, compactActiveBatch }
        );
        return {
          batchSize,
          compactActiveBatch,
          provider: encoder.provider,
          createMs,
          runMs: performance.now() - runT0,
          telemetry: decode.telemetry,
        };
      }, { batchSize: prewarmOcrBatch, compactActiveBatch: ocrCompactActiveBatch });
      console.log(
        `current OCR prewarm: batch=${warmup.batchSize}, compact=${warmup.compactActiveBatch}, provider=${warmup.provider}, create=${formatMs(warmup.createMs)}, run=${formatMs(warmup.runMs)}, session=${formatMs(warmup.telemetry.sessionRunTotalMs)}`
      );
    }

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
      }>(
        async ({ dataUrl, contentType, runIndex, ocrCompactActiveBatch, ocrEngine, processMode, paddleBatchMode, paddleProviderMode, paddleColdFirstMode }) => {
          type PaddleRuntimeFlags = typeof globalThis & {
            __shinobuPaddleOcrWidthBucketBatch?: boolean;
            __shinobuPaddleOcrProviders?: RuntimeProvider[];
            __shinobuPaddleOcrColdFirstSerial?: boolean;
          };
          type Orchestrator = {
            runPipeline(file: File, config: Record<string, unknown>, onProgress: () => void): Promise<{
              original: { naturalWidth: number; naturalHeight: number };
              detectedRegions: Array<{ sourceText: string }>;
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
          if (paddleProviderMode === "default") {
            delete runtimeFlags.__shinobuPaddleOcrProviders;
          } else {
            runtimeFlags.__shinobuPaddleOcrProviders = [paddleProviderMode];
          }
          if (paddleColdFirstMode === "default") {
            delete runtimeFlags.__shinobuPaddleOcrColdFirstSerial;
          } else {
            runtimeFlags.__shinobuPaddleOcrColdFirstSerial = paddleColdFirstMode === "on";
          }
          const module = await import("/chunks/orchestrator.js") as Orchestrator;
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
            ocrCompactActiveBatch,
            processMode,
          };
          const totalT0 = performance.now();
          const artifacts = await module.runPipeline(file, config, () => {});
          const totalMs = performance.now() - totalT0;
          const sourceTexts = artifacts.detectedRegions.map((region) => region.sourceText);
          return {
            runIndex,
            isColdStart: runIndex === 0,
            totalMs,
            imageWidth: artifacts.original.naturalWidth,
            imageHeight: artifacts.original.naturalHeight,
            regionCount: artifacts.detectedRegions.length,
            sourceCharCount: sourceTexts.reduce((sum, text) => sum + text.length, 0),
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
        }
      );
      run.ocrSummary = summarizeOcr(run);
      results.push(roundRun(run));
      console.log(`${mode} run ${i + 1}/${runs}: total=${formatMs(run.totalMs)}, ocr=${formatMs(run.ocrSummary.stageMs)}, decode=${formatMs(run.ocrSummary.decodeSessionRunTotalMs)}, encoderCache=${run.ocrSummary.encoderCache}`);
    }
    return {
      mode,
      extensionDir: DIST_DIR,
      ocrEngine,
      processMode,
      ocrCompactActiveBatch,
      paddleBatchMode,
      paddleProviderMode,
      paddleColdFirstMode,
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

function printSummary(report: CompareReport): void {
  console.log(`\n=== X image ${report.modes.length === 1 ? "current" : "compare"} summary ===`);
  console.log(`URL: ${report.xUrl}`);
  console.log(`Image: ${report.image.imageUrl}`);
  for (const mode of report.modes) {
    console.log(`\n${mode.mode}`);
    console.log(`  OCR engine:        ${mode.ocrEngine}`);
    console.log(`  process mode:      ${mode.processMode}`);
    if (typeof mode.ocrCompactActiveBatch === "boolean") {
      console.log(`  OCR compact batch: ${mode.ocrCompactActiveBatch}`);
    }
    if (mode.paddleBatchMode) {
      console.log(`  Paddle batch mode: ${mode.paddleBatchMode}`);
    }
    if (mode.paddleProviderMode) {
      console.log(`  Paddle provider mode: ${mode.paddleProviderMode}`);
    }
    if (mode.paddleColdFirstMode) {
      console.log(`  Paddle cold-first: ${mode.paddleColdFirstMode}`);
    }
    console.log(`  warm median total: ${formatMs(mode.warmMedian.totalMs)}`);
    console.log(`  warm median OCR:   ${formatMs(mode.warmMedian.ocrStageMs)}`);
    console.log(`  warm median decode:${formatMs(mode.warmMedian.decodeSessionRunTotalMs)}`);
    const latestWarm = warmRuns(mode.runs).at(-1) ?? mode.runs.at(-1);
    if (latestWarm) {
      console.log(`  regions/chars:     ${latestWarm.regionCount}/${latestWarm.sourceCharCount}`);
      console.log(`  sample:            ${latestWarm.sampleTexts.slice(0, 3).join(" | ")}`);
      if (latestWarm.ocrSummary.paddle) {
        const paddle = latestWarm.ocrSummary.paddle;
        console.log(`  Paddle provider:   ${paddle.provider ?? "unknown"}${paddle.webnnDeviceType ? `/${paddle.webnnDeviceType}` : ""}`);
        console.log(`  Paddle batch:      ${paddle.batchMode}${paddle.batchBucketWidth ? ` ${paddle.batchBucketWidth}px` : ""}, coldFirst=${paddle.coldFirstSerial === true}, runs=${paddle.inferenceRunCount}`);
        console.log(`  Paddle OCR split:  preprocess=${formatMs(paddle.preprocessTotalMs)}, inference=${formatMs(paddle.inferenceTotalMs)}, ctc=${formatMs(paddle.decodeTotalMs)}, color=${formatMs(paddle.colorFillMs)}`);
        console.log(`  Paddle widths:     min=${paddle.widthSummary.min}, max=${paddle.widthSummary.max}, avg=${paddle.widthSummary.avg}`);
      }
    }
  }
  if (report.improvement) {
    console.log("\nimprovement (warm median, old-full-ar -> new-split)");
    console.log(`  total:  -${formatMs(report.improvement.totalMsSaved)} (${report.improvement.totalPct}%, ${report.improvement.totalSpeedup}x)`);
    console.log(`  OCR:    -${formatMs(report.improvement.ocrStageMsSaved)} (${report.improvement.ocrStagePct}%, ${report.improvement.ocrStageSpeedup}x)`);
    console.log(`  decode: -${formatMs(report.improvement.decodeSessionRunMsSaved)} (${report.improvement.decodeSessionRunPct}%, ${report.improvement.decodeSessionRunSpeedup}x)`);
  }
}

async function main(): Promise<void> {
  const currentOnly = isCurrentOnly();
  const ocrEngine = pickOcrEngine();
  const processMode = pickProcessMode();
  const paddleBatchMode = pickPaddleBatchMode();
  const paddleProviderMode = pickPaddleProviderMode();
  const paddleColdFirstMode = pickPaddleColdFirstMode();
  if (!currentOnly && ocrEngine !== "48px") {
    throw new Error("--ocr-engine=paddleocr_v6_medium is supported in --current-only mode only");
  }
  if (!currentOnly && paddleProviderMode !== "default") {
    throw new Error("--paddle-provider is supported in --current-only mode only");
  }
  if (!currentOnly && paddleColdFirstMode !== "default") {
    throw new Error("--paddle-cold-first-serial is supported in --current-only mode only");
  }
  ensureDistReady({ includeLegacyOcr: !currentOnly, ocrEngine });
  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(REPORTS_DIR, { recursive: true });
  const xUrl = pickUrl();
  const imageUrlOverride = pickImageUrlOverride();
  const imagePathOverride = pickImagePathOverride();
  const runs = pickRunCount();
  const prewarmOcrBatch = pickPrewarmOcrBatch();
  const ocrCompactActiveBatch = pickOcrCompactActiveBatch();
  console.log(`Browser profile config: ocr=${ocrEngine}, process=${processMode}, paddleBatch=${paddleBatchMode}, paddleProvider=${paddleProviderMode}, paddleColdFirst=${paddleColdFirstMode}, runs=${runs}`);
  console.log(imagePathOverride ? `Loading local image: ${imagePathOverride}` : `Resolving X image: ${xUrl}`);
  const image = imagePathOverride ? loadImageFromFile(imagePathOverride) : await resolveXImage(xUrl, imageUrlOverride);
  console.log(`Resolved image: ${image.imageUrl} (${image.contentType}, ${image.bytes} bytes)`);
  const server = await startProbeServer();
  try {
    // Keep the local server alive so Chrome treats the process like a real page
    // benchmark session if future runs need a non-extension page.
    void server.url;
    if (currentOnly) {
      const currentResult = await runCurrentWebMode(
        server.url,
        image,
        runs,
        prewarmOcrBatch,
        ocrCompactActiveBatch,
        ocrEngine,
        processMode,
        paddleBatchMode,
        paddleProviderMode,
        paddleColdFirstMode,
      );
      const report: CompareReport = {
        createdAt: new Date().toISOString(),
        xUrl,
        image: {
          pageUrl: image.pageUrl,
          imageUrl: image.imageUrl,
          contentType: image.contentType,
          bytes: image.bytes,
        },
        runsPerMode: runs,
        modes: [currentResult],
      };
      printSummary(report);
      const reportPath = join(REPORTS_DIR, `x-current-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`\nReport saved: ${reportPath}`);
      return;
    }

    const oldExtensionDir = createOldFullArExtensionDir();
    const oldResult = await runMode("old-full-ar", oldExtensionDir, image, runs, ocrEngine, processMode);
    const newResult = await runMode("new-split", DIST_DIR, image, runs, ocrEngine, processMode);
    const total = improvement(oldResult.warmMedian.totalMs, newResult.warmMedian.totalMs);
    const ocr = improvement(oldResult.warmMedian.ocrStageMs, newResult.warmMedian.ocrStageMs);
    const decode = improvement(oldResult.warmMedian.decodeSessionRunTotalMs, newResult.warmMedian.decodeSessionRunTotalMs);
    const report: CompareReport = {
      createdAt: new Date().toISOString(),
      xUrl,
      image: {
        pageUrl: image.pageUrl,
        imageUrl: image.imageUrl,
        contentType: image.contentType,
        bytes: image.bytes,
      },
      runsPerMode: runs,
      modes: [oldResult, newResult],
      improvement: {
        totalMsSaved: total.saved,
        totalPct: total.pct,
        totalSpeedup: total.speedup,
        ocrStageMsSaved: ocr.saved,
        ocrStagePct: ocr.pct,
        ocrStageSpeedup: ocr.speedup,
        decodeSessionRunMsSaved: decode.saved,
        decodeSessionRunPct: decode.pct,
        decodeSessionRunSpeedup: decode.speedup,
      },
    };
    printSummary(report);
    const reportPath = join(REPORTS_DIR, `x-compare-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nReport saved: ${reportPath}`);
  } finally {
    await server.close();
  }
}

await main();
