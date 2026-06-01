import { createServer } from "http";
import type { AddressInfo } from "net";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, extname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { chromium } from "@playwright/test";

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

type StageTiming = {
  stage: string;
  label: string;
  durationMs: number;
};

type OcrDebugChunk = {
  encoderCache?: boolean;
  encoderRunMs?: number;
  decoderRunMs?: number;
  decodeSessionRunCount: number;
  decodeSessionRunTotalMs: number;
  decodeSteps: Array<{
    step: number;
    activeCount: number;
    batchSize?: number;
    durationMs: number;
    postprocessMode?: "cpu" | "gpu" | "gpu-fallback";
    postprocessMs?: number;
  }>;
};

type OcrDebug = {
  candidateCount: number;
  preparedCount: number;
  preprocessTotalMs: number;
  chunks: OcrDebugChunk[];
  colorDecodeMode: string;
  colorBatchSize: number;
  colorSessionRunCount: number;
  colorSessionRunTotalMs: number;
  colorTotalMs: number;
  fallbackTriggerCount: number;
  totalSessionRunCount: number;
  totalSessionRunMs: number;
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
};

type ModeResult = {
  mode: "old-full-ar" | "new-split";
  extensionDir: string;
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
  improvement: {
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
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function pickUrl(): string {
  return argValue("url") ?? DEFAULT_X_URL;
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
    "chunks/orchestrator.js",
    "onnxWorker.js",
    "models/models.json",
    "models/ocr.onnx",
    "models/ocr_encoder.onnx",
    "models/ocr_decoder.onnx",
    "models/detector.onnx",
    "models/lama_fp32.onnx",
    "models/bubble.onnx",
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

async function resolveXImage(xUrl: string): Promise<XImage> {
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
    const imageUrl = toOrigTwitterImageUrl(candidates.find((url) => url.includes("pbs.twimg.com/media")) ?? "");
    if (!imageUrl) {
      throw new Error(`Could not find a pbs.twimg.com image on ${xUrl}. candidates=${JSON.stringify(candidates)}`);
    }
    const response = await context.request.get(imageUrl, {
      headers: {
        referer: xUrl,
      },
      timeout: 120000,
    });
    if (!response.ok()) {
      throw new Error(`Image fetch failed: ${response.status()} ${response.statusText()} ${imageUrl}`);
    }
    const body = await response.body();
    const contentType = response.headers()["content-type"]?.split(";")[0] ?? contentTypeFromUrl(imageUrl);
    return {
      pageUrl: page.url(),
      imageUrl,
      contentType,
      dataUrl: `data:${contentType};base64,${body.toString("base64")}`,
      bytes: body.length,
    };
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
    if (req.url !== "/" && req.url !== "/probe.html") {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
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

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
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

async function runMode(mode: ModeResult["mode"], extensionDir: string, image: XImage, runs: number): Promise<ModeResult> {
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
      const run = await page.evaluate<PipelineRun, { dataUrl: string; contentType: string; runIndex: number }>(
        async ({ dataUrl, contentType, runIndex }) => {
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
            ocrEngine: "builtin",
            processMode: "erase",
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
        { dataUrl: image.dataUrl, contentType: image.contentType, runIndex: i }
      );
      run.ocrSummary = summarizeOcr(run);
      results.push(roundRun(run));
      console.log(`${mode} run ${i + 1}/${runs}: total=${formatMs(run.totalMs)}, ocr=${formatMs(run.ocrSummary.stageMs)}, decode=${formatMs(run.ocrSummary.decodeSessionRunTotalMs)}, encoderCache=${run.ocrSummary.encoderCache}`);
    }
    return {
      mode,
      extensionDir,
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
  console.log("\n=== X image compare summary ===");
  console.log(`URL: ${report.xUrl}`);
  console.log(`Image: ${report.image.imageUrl}`);
  for (const mode of report.modes) {
    console.log(`\n${mode.mode}`);
    console.log(`  warm median total: ${formatMs(mode.warmMedian.totalMs)}`);
    console.log(`  warm median OCR:   ${formatMs(mode.warmMedian.ocrStageMs)}`);
    console.log(`  warm median decode:${formatMs(mode.warmMedian.decodeSessionRunTotalMs)}`);
    const latestWarm = warmRuns(mode.runs).at(-1) ?? mode.runs.at(-1);
    if (latestWarm) {
      console.log(`  regions/chars:     ${latestWarm.regionCount}/${latestWarm.sourceCharCount}`);
      console.log(`  sample:            ${latestWarm.sampleTexts.slice(0, 3).join(" | ")}`);
    }
  }
  console.log("\nimprovement (warm median, old-full-ar -> new-split)");
  console.log(`  total:  -${formatMs(report.improvement.totalMsSaved)} (${report.improvement.totalPct}%, ${report.improvement.totalSpeedup}x)`);
  console.log(`  OCR:    -${formatMs(report.improvement.ocrStageMsSaved)} (${report.improvement.ocrStagePct}%, ${report.improvement.ocrStageSpeedup}x)`);
  console.log(`  decode: -${formatMs(report.improvement.decodeSessionRunMsSaved)} (${report.improvement.decodeSessionRunPct}%, ${report.improvement.decodeSessionRunSpeedup}x)`);
}

async function main(): Promise<void> {
  ensureDistReady();
  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(REPORTS_DIR, { recursive: true });
  const xUrl = pickUrl();
  const runs = pickRunCount();
  console.log(`Resolving X image: ${xUrl}`);
  const image = await resolveXImage(xUrl);
  console.log(`Resolved image: ${image.imageUrl} (${image.contentType}, ${image.bytes} bytes)`);
  const server = await startProbeServer();
  const oldExtensionDir = createOldFullArExtensionDir();
  try {
    // Keep the local server alive so Chrome treats the process like a real page
    // benchmark session if future runs need a non-extension page.
    void server.url;
    const oldResult = await runMode("old-full-ar", oldExtensionDir, image, runs);
    const newResult = await runMode("new-split", DIST_DIR, image, runs);
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
