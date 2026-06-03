import { createServer } from "http";
import type { AddressInfo } from "net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { chromium } from "@playwright/test";
import type { ConsoleMessage, Page } from "@playwright/test";
import type { Worker as PlaywrightWorker } from "playwright-core";
import { defaultExtensionSettings, extensionSettingsStorageKey } from "../../../src/shared/config";
import type { ExtensionSettings, ProcessMode } from "../../../src/shared/config";
import type { ProgressJankReport } from "../../../src/content/core/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DIST_DIR = join(ROOT, "dist");
const TMP_DIR = join(ROOT, ".tmp");
const REPORTS_DIR = join(ROOT, "benchmark/perf/reports");
const USER_DATA_DIR = join(TMP_DIR, `browser-ui-jank-smoke-${Date.now()}`);
const DEFAULT_IMAGE = join(ROOT, "benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png");
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

type RuntimeResponse = {
  ok?: boolean;
  type?: string;
  error?: string;
};

type SpinnerSmokeStatus = {
  renderer: string | null;
  hasCanvas: boolean;
  hasFallback: boolean;
  visible: boolean;
};

type JankSmokeReport = {
  createdAt: string;
  extensionId: string;
  pageUrl: string;
  image: string;
  processMode: ProcessMode;
  spinner: SpinnerSmokeStatus;
  response: RuntimeResponse;
  jank: ProgressJankReport;
};

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function pickImagePath(): string {
  const imagePath = argValue("image") ? resolve(argValue("image") ?? "") : DEFAULT_IMAGE;
  if (!existsSync(imagePath)) {
    throw new Error(`Image does not exist: ${imagePath}`);
  }
  return imagePath;
}

function pickProcessMode(): ProcessMode {
  const raw = argValue("process-mode");
  if (raw === "translate" || raw === "erase" || raw === "original") {
    return raw;
  }
  return "erase";
}

function requireDistAsset(relativePath: string): void {
  const fullPath = join(DIST_DIR, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Missing dist asset: ${fullPath}. Run npm run build first.`);
  }
}

function ensureDistReady(): void {
  [
    "manifest.json",
    "content.js",
    "chunks/orchestrator.js",
    "onnxWorker.js",
    "models/models.json",
    "models/detector.onnx",
    "models/ocr_encoder.onnx",
    "models/ocr_decoder.onnx",
    "models/lama_fp32.onnx",
    "models/bubble.onnx",
    "ort/ort-wasm-simd-threaded.jsep.mjs",
    "ort/ort-wasm-simd-threaded.jsep.wasm",
  ].forEach(requireDistAsset);
}

function findChromeExecutable(): string | undefined {
  if (!USE_SYSTEM_CHROME) return undefined;
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Chrome executable not found. Set CHROME_PATH to chrome.exe.");
}

function contentTypeFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/png";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isProgressJankReport(value: unknown): value is ProgressJankReport {
  if (!isRecord(value)) return false;
  return typeof value.runId === "string"
    && typeof value.totalMs === "number"
    && isRecord(value.frame)
    && isRecord(value.workerHeartbeat)
    && Array.isArray(value.stages)
    && Array.isArray(value.longFrames)
    && Array.isArray(value.longTasks);
}

function createSmokeSettings(processMode: ProcessMode): ExtensionSettings {
  const settings = JSON.parse(JSON.stringify(defaultExtensionSettings)) as ExtensionSettings;
  settings.processMode = processMode;
  settings.translator = "google_web";
  settings.enableDebugLog = false;
  settings.showTypesetDebug = false;
  settings.showEraseDebug = false;
  settings.showElapsedTime = true;
  settings.showStageTimingDetails = true;
  return settings;
}

async function startProbeServer(imagePath: string): Promise<{ url: string; close(): Promise<void> }> {
  const imageBytes = readFileSync(imagePath);
  const imageContentType = contentTypeFromPath(imagePath);
  const server = createServer((req, res) => {
    if (req.url === "/fixture.png") {
      res.writeHead(200, {
        "content-type": imageContentType,
        "cache-control": "no-store",
      });
      res.end(imageBytes);
      return;
    }
    if (req.url !== "/" && req.url !== "/probe.html") {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<meta charset="utf-8">
<title>shinobu ui jank smoke</title>
<style>
  body { margin: 0; min-height: 100vh; background: #111; display: grid; place-items: start center; }
  img { display: block; width: min(720px, 92vw); height: auto; margin: 24px auto; }
</style>
<script>
  window.__shinobuReady = false;
  window.addEventListener("message", function (event) {
    if (event.data && event.data.type === "__shinobu_bake_ready__") {
      window.__shinobuReady = true;
    }
  });
</script>
<img id="target" src="/fixture.png" alt="fixture">`);
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

async function configureSettings(worker: PlaywrightWorker, settings: ExtensionSettings): Promise<void> {
  await worker.evaluate(
    async ({ key, value }: { key: string; value: ExtensionSettings }) => {
      type ChromeApi = {
        storage?: {
          local?: {
            set?: (items: Record<string, unknown>) => Promise<void>;
          };
        };
      };
      const chromeApi = (globalThis as typeof globalThis & { chrome?: ChromeApi }).chrome;
      if (!chromeApi?.storage?.local?.set) {
        throw new Error("chrome.storage.local.set is unavailable");
      }
      await chromeApi.storage.local.set({ [key]: value });
    },
    { key: extensionSettingsStorageKey, value: settings },
  );
}

async function sendHoverShortcut(worker: PlaywrightWorker, pageUrl: string): Promise<RuntimeResponse> {
  const response = await worker.evaluate<RuntimeResponse, { pageUrl: string }>(
    async ({ pageUrl: targetUrl }: { pageUrl: string }) => {
      type Tab = { id?: number; url?: string };
      type ChromeApi = {
        tabs?: {
          query?: (queryInfo: Record<string, unknown>) => Promise<Tab[]>;
          sendMessage?: (tabId: number, message: unknown) => Promise<unknown>;
        };
      };
      const chromeApi = (globalThis as typeof globalThis & { chrome?: ChromeApi }).chrome;
      if (!chromeApi?.tabs?.query || !chromeApi.tabs.sendMessage) {
        throw new Error("chrome.tabs API is unavailable");
      }
      const tabs = await chromeApi.tabs.query({});
      const tab = tabs.find((item) => item.url === targetUrl) ?? tabs.find((item) => item.url?.startsWith(targetUrl));
      if (!tab?.id) {
        throw new Error(`Unable to find tab for ${targetUrl}`);
      }
      const rawResponse = await chromeApi.tabs.sendMessage(tab.id, { type: "mt:shortcut-translate-hover" });
      if (!rawResponse || typeof rawResponse !== "object" || Array.isArray(rawResponse)) {
        return { ok: false, error: "Empty shortcut response" };
      }
      const record = rawResponse as Record<string, unknown>;
      return {
        ok: typeof record.ok === "boolean" ? record.ok : false,
        type: typeof record.type === "string" ? record.type : undefined,
        error: typeof record.error === "string" ? record.error : undefined,
      };
    },
    { pageUrl },
  );
  return response;
}

async function moveMouseToImage(page: Page): Promise<void> {
  const image = page.locator("#target");
  await image.waitFor({ state: "visible", timeout: 30000 });
  const box = await image.boundingBox();
  if (!box) {
    throw new Error("Image bounding box is unavailable");
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(100);
}

async function readJankReportFromConsole(message: ConsoleMessage): Promise<ProgressJankReport | null> {
  if (!message.text().includes("[shinobu:jank]")) {
    return null;
  }
  const args = message.args();
  if (args.length < 2) {
    return null;
  }
  const value = await args[1].jsonValue();
  return isProgressJankReport(value) ? value : null;
}

async function waitForJankReport(reports: ProgressJankReport[]): Promise<ProgressJankReport> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    if (reports.length > 0) return reports[reports.length - 1];
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Timed out waiting for [shinobu:jank] console report");
}

async function readSpinnerStatus(page: Page): Promise<SpinnerSmokeStatus> {
  return page.evaluate(() => {
    const spinner = document.querySelector(".mt-x-screenshot-result .mt-x-spinner")
      ?? document.querySelector(".mt-x-spinner");
    if (!(spinner instanceof HTMLElement)) {
      return {
        renderer: null,
        hasCanvas: false,
        hasFallback: false,
        visible: false,
      };
    }
    const style = window.getComputedStyle(spinner);
    return {
      renderer: spinner.dataset.renderer ?? null,
      hasCanvas: Boolean(spinner.querySelector("canvas")),
      hasFallback: Boolean(spinner.querySelector("svg")),
      visible: style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0",
    };
  });
}

function printSummary(report: ProgressJankReport, spinner: SpinnerSmokeStatus): void {
  const topStages = [...report.stages]
    .sort((left, right) => right.maxFrameDeltaMs - left.maxFrameDeltaMs)
    .slice(0, 5)
    .map((stage) => ({
      stage: stage.stage,
      durationMs: stage.durationMs,
      maxFrameDeltaMs: stage.maxFrameDeltaMs,
      longFrameCount: stage.longFrameCount,
      longTaskCount: stage.longTaskCount,
      workerCallCount: stage.workerCallCount,
      maxWorkerCallMs: stage.maxWorkerCallMs,
    }));
  console.log(JSON.stringify({
    runId: report.runId,
    entry: report.entry,
    totalMs: report.totalMs,
    observerSupport: report.observerSupport,
    frame: report.frame,
    workerHeartbeat: report.workerHeartbeat,
    ui: report.ui,
    spinner,
    longFrameCount: report.longFrames.length,
    longTaskCount: report.longTasks.length,
    topStages,
  }, null, 2));
}

async function main(): Promise<void> {
  ensureDistReady();
  mkdirSync(USER_DATA_DIR, { recursive: true });
  mkdirSync(REPORTS_DIR, { recursive: true });

  const imagePath = pickImagePath();
  const processMode = pickProcessMode();
  const server = await startProbeServer(imagePath);
  const chromePath = findChromeExecutable();
  const reports: ProgressJankReport[] = [];

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    ...(chromePath ? { executablePath: chromePath } : {}),
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${DIST_DIR}`,
      `--load-extension=${DIST_DIR}`,
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
    await configureSettings(worker, createSmokeSettings(processMode));

    const page = await context.newPage();
    page.setDefaultTimeout(900000);
    page.on("console", (message) => {
      void readJankReportFromConsole(message).then((report) => {
        if (report) reports.push(report);
      });
      const text = message.text();
      if (!text.includes("[ocr] encoder cache")) {
        console.log(`[browser:${message.type()}] ${text}`);
      }
    });
    page.on("pageerror", (error) => {
      console.log(`[pageerror] ${error.message}`);
    });

    await page.goto(server.url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean((window as typeof window & { __shinobuReady?: boolean }).__shinobuReady), undefined, {
      timeout: 30000,
    });
    await moveMouseToImage(page);

    const response = await sendHoverShortcut(worker, server.url);
    if (!response.ok) {
      throw new Error(`Hover shortcut failed: ${response.error ?? JSON.stringify(response)}`);
    }
    const report = await waitForJankReport(reports);
    const spinner = await readSpinnerStatus(page);
    const smokeReport: JankSmokeReport = {
      createdAt: new Date().toISOString(),
      extensionId,
      pageUrl: server.url,
      image: imagePath,
      processMode,
      spinner,
      response,
      jank: report,
    };
    const reportPath = join(REPORTS_DIR, `ui-jank-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(reportPath, JSON.stringify(smokeReport, null, 2));
    printSummary(report, spinner);
    console.log(`report=${reportPath}`);
  } finally {
    await context.close();
    await server.close();
  }
}

await main();
