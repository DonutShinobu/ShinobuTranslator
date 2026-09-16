import { createServer } from "http";
import type { AddressInfo } from "net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { cpus, freemem } from "node:os";
import { chromium } from "@playwright/test";
import type { ConsoleMessage, Page } from "@playwright/test";
import type { Worker as PlaywrightWorker } from "@playwright/test";
import type { ProcessMode } from "../../../apps/extension/src/shared/config";
import type { ProgressJankReport } from "../../../apps/extension/src/content/core/types";
import { applyExtensionControlPatch } from './extension-control-driver';
import { ensureExtensionDistReady } from './dist-contract';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DIST_DIR = join(ROOT, "apps", "extension", "dist-chromium");
const TMP_DIR = join(ROOT, ".tmp");
const REPORTS_DIR = join(ROOT, "benchmark/perf/reports");
const profileKey = argValue('profile-key') ?? String(Date.now());
if (!/^[\w-]+$/.test(profileKey)) throw new Error('Invalid --profile-key');
const USER_DATA_DIR = join(TMP_DIR, `browser-ui-jank-smoke-${profileKey}`);
const DEFAULT_IMAGE = join(ROOT, "benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png");

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

function ensureDistReady(): void {
  ensureExtensionDistReady(DIST_DIR);
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

async function startProbeServer(imagePath: string): Promise<{ url: string; workerProbeRecords: unknown[]; close(): Promise<void> }> {
  const imageBytes = readFileSync(imagePath);
  const imageContentType = contentTypeFromPath(imagePath);
  const workerProbeRecords: unknown[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/worker-probe" && req.method === "POST") {
      let body = "";
      let bytes = 0;
      req.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 2 * 1024 * 1024) req.destroy();
        else body += chunk;
      });
      req.on("end", () => {
        try { workerProbeRecords.push(JSON.parse(body)); res.writeHead(200).end("ok"); }
        catch { res.writeHead(400).end("invalid JSON"); }
      });
      return;
    }
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
<img id="target" src="/fixture.png" alt="fixture">`);
  });
  await new Promise<void>((resolveListen) => server.listen(Number(argValue("probe-port") ?? 0), "127.0.0.1", resolveListen));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}/probe.html`,
    workerProbeRecords,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    }),
  };
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
  await image.scrollIntoViewIfNeeded();
  const box = await image.boundingBox();
  if (!box) {
    throw new Error("Image bounding box is unavailable");
  }
  const viewport = page.viewportSize()!;
  const clientX = (Math.max(0, box.x) + Math.min(viewport.width, box.x + box.width)) / 2;
  const clientY = (Math.max(0, box.y) + Math.min(viewport.height, box.y + box.height)) / 2;
  await page.mouse.move(clientX, clientY);
  await image.dispatchEvent("mousemove", { clientX, clientY });
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
  const runs = Number(argValue("runs") ?? 1);
  const maxFrameMs = Number(argValue("max-frame-ms") ?? Infinity);
  const maxWorkerFrameMs = Number(argValue("max-worker-frame-ms") ?? Infinity);
  if (!Number.isInteger(runs) || runs < 1 || !(maxFrameMs > 0) || !(maxWorkerFrameMs > 0)) {
    throw new Error("--runs must be a positive integer; frame budgets must be positive");
  }
  ensureDistReady();
  mkdirSync(USER_DATA_DIR, { recursive: true });
  mkdirSync(REPORTS_DIR, { recursive: true });

  const imagePath = pickImagePath();
  const processMode = pickProcessMode();
  const server = await startProbeServer(imagePath);
  const reports: ProgressJankReport[] = [];

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: chromium.executablePath(),
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      `--disable-extensions-except=${DIST_DIR}`,
      `--load-extension=${DIST_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-features=CalculateNativeWinOcclusion",
      "--enable-unsafe-webgpu",
      ...(process.argv.includes('--disable-gpu-shader-disk-cache') ? ['--disable-gpu-shader-disk-cache'] : []),
    ],
  });
  context.setDefaultTimeout(900000);
  const workerProbeRecords = server.workerProbeRecords;
  const witnessBrowser = process.argv.includes("--witness") ? await chromium.launch({
    headless: false,
    args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows", "--disable-features=CalculateNativeWinOcclusion"],
  }) : null;
  const witnessPage = await witnessBrowser?.newPage();
  if (witnessPage) {
    await witnessPage.setContent("<title>Independent browser responsiveness probe</title><p>Independent browser responsiveness probe</p>");
    await witnessPage.evaluate("var __name = (target) => target;");
  }

  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 30000 });
    const extensionId = worker.url().match(/^chrome-extension:\/\/([^/]+)/)?.[1];
    if (!extensionId) {
      throw new Error(`Unable to parse extension id from service worker URL: ${worker.url()}`);
    }
    await applyExtensionControlPatch(context, extensionId, {
      patch: {
        processMode,
        translator: 'google_web',
        enableDebugLog: false,
        showTypesetDebug: false,
        showEraseDebug: false,
        showElapsedTime: true,
        showStageTimingDetails: true,
      },
    });

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

    console.log(`browser=${context.browser()?.version()}`);
    const browserCdp = await context.browser()!.newBrowserCDPSession();
    const { gpu } = await browserCdp.send("SystemInfo.getInfo");
    console.log(JSON.stringify({ gpu: gpu.devices }));
    const cdp = await context.newCDPSession(page);
    const trace = process.argv.includes("--trace");
    if (trace) await cdp.send("Tracing.start", {
      categories: "toplevel,gpu,viz,blink,devtools.timeline,disabled-by-default-gpu.service,disabled-by-default-gpu.dawn",
      transferMode: "ReturnAsStream",
    });
    let exceeded = false;
    for (let runIndex = 0; runIndex < runs; runIndex += 1) {
      reports.length = 0;
      await page.goto(server.url, { waitUntil: "domcontentloaded" });
      await page.bringToFront();
      await page.waitForFunction(() => Boolean(document.getElementById("mt-overlay-style")), undefined, {
        timeout: 30000,
      });
      await moveMouseToImage(page);

      const cpuBefore = cpus();
      if (witnessPage) await witnessPage.evaluate(() => {
        const state = { raf: [] as number[], timer: [] as number[], active: true };
        (globalThis as any).__responsiveness = state;
        let frameAt = performance.now();
        let timerAt = frameAt;
        const frame = (now: number) => {
          state.raf.push(now - frameAt);
          frameAt = now;
          if (state.active) requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
        const timer = setInterval(() => {
          const now = performance.now();
          state.timer.push(now - timerAt);
          timerAt = now;
          if (!state.active) clearInterval(timer);
        }, 16);
      });
      let minFreeMemoryBytes = freemem();
      const memoryTimer = setInterval(() => { minFreeMemoryBytes = Math.min(minFreeMemoryBytes, freemem()); }, 100);
      let response: RuntimeResponse;
      try {
        response = await sendHoverShortcut(worker, server.url);
      } finally {
        clearInterval(memoryTimer);
      }
      const cpuAfter = cpus();
      let totalTicks = 0;
      let idleTicks = 0;
      cpuAfter.forEach((cpu, index) => {
        for (const key of Object.keys(cpu.times) as Array<keyof typeof cpu.times>) {
          totalTicks += cpu.times[key] - cpuBefore[index].times[key];
        }
        idleTicks += cpu.times.idle - cpuBefore[index].times.idle;
      });
      if (!response.ok) {
        throw new Error(`Hover shortcut failed: ${response.error ?? JSON.stringify(response)}`);
      }
      const report = await waitForJankReport(reports);
      const spinner = await readSpinnerStatus(page);
      const resultImage = await page.locator('.mt-x-screenshot-result[data-image="translated"] img').evaluate(async (element) => {
        const image = element as HTMLImageElement;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const hash = await crypto.subtle.digest('SHA-256', pixels);
        return { width: canvas.width, height: canvas.height,
          sha256: Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('') };
      });
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
      const witness = await witnessPage?.evaluate(() => {
        const state = (globalThis as any).__responsiveness;
        state.active = false;
        const summarize = (values: number[]) => ({ samples: values.length, maxMs: Math.max(0, ...values), over100: values.filter(x => x > 100).length });
        return { raf: summarize(state.raf), timer: summarize(state.timer) };
      });
      const system = { cpuBusyPercent: 100 * (1 - idleTicks / totalTicks), minFreeMemoryBytes, witness };
      writeFileSync(reportPath, JSON.stringify({ ...smokeReport, runIndex, browserVersion: context.browser()?.version(), gpuDevices: gpu.devices, system, workerProbeRecords, resultImage }, null, 2));
      console.log(JSON.stringify({ system }));
      console.log(`run=${runIndex + 1} cold=${runIndex === 0}`);
      printSummary(report, spinner);
      console.log(`report=${reportPath}`);
      // Let the optional shader descriptor cache finish its debounced disk write.
      await page.waitForTimeout(750);
      exceeded ||= report.frame.maxDeltaMs > maxFrameMs;
      exceeded ||= report.workerHeartbeat.maxDeltaMs > maxWorkerFrameMs;
    }
    if (trace) {
      const complete = new Promise<{ stream?: string }>((resolveTrace) => cdp.once("Tracing.tracingComplete", resolveTrace));
      await cdp.send("Tracing.end");
      const { stream } = await complete;
      if (!stream) throw new Error("Trace stream is missing");
      const chunks: Buffer[] = [];
      for (;;) {
        const chunk = await cdp.send("IO.read", { handle: stream });
        chunks.push(Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8"));
        if (chunk.eof) break;
      }
      await cdp.send("IO.close", { handle: stream });
      const tracePath = join(REPORTS_DIR, `ui-jank-trace-${Date.now()}.json`);
      writeFileSync(tracePath, Buffer.concat(chunks));
      console.log(`trace=${tracePath}`);
    }
    if (exceeded) throw new Error(`Frame gap exceeded budget (page=${maxFrameMs} ms, worker=${maxWorkerFrameMs} ms)`);
  } finally {
    await witnessBrowser?.close();
    await context.close();
    await server.close();
  }
}

await main();
