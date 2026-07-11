import { createServer } from "http";
import type { AddressInfo } from "net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, extname, join, resolve, sep } from "path";
import { fileURLToPath } from "url";
import { chromium } from "@playwright/test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DIST_DIR = join(ROOT, "dist");
const REPORTS_DIR = join(ROOT, "benchmark/perf/reports");
const DEFAULT_MODEL_URL = "/models/PP-OCRv6_medium_rec.onnx";

type PaddleGraphCaptureProbeResult = {
  ok: boolean;
  modelUrl: string;
  inputDims: number[];
  outputDims: number[];
  inputBytes: number;
  outputBytes: number;
  createSessionMs?: number;
  runMs: number[];
  error?: string;
};

type PaddleGraphCaptureBridge = {
  probePaddleGraphCapture(options: {
    modelUrl: string;
    inputWidth?: number;
    batchSize?: number;
    classCount?: number;
    runs?: number;
  }): Promise<PaddleGraphCaptureProbeResult>;
};

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const arg = process.argv.filter((value) => value.startsWith(prefix)).at(-1);
  return arg ? arg.slice(prefix.length) : null;
}

function pickPositiveInt(name: string, fallback: number): number {
  const raw = argValue(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid --${name} value: ${raw}`);
  }
  return parsed;
}

function contentTypeFromFilePath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js" || ext === ".mjs") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".wasm") return "application/wasm";
  if (ext === ".onnx" || ext === ".ort") return "application/octet-stream";
  if (ext === ".css") return "text/css; charset=utf-8";
  return "application/octet-stream";
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
    res.end("<!doctype html><meta charset=\"utf-8\"><title>paddle graph capture probe</title>");
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

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundResult(result: PaddleGraphCaptureProbeResult): PaddleGraphCaptureProbeResult {
  return {
    ...result,
    createSessionMs: result.createSessionMs === undefined ? undefined : round(result.createSessionMs),
    runMs: result.runMs.map(round),
  };
}

async function main(): Promise<void> {
  const modelUrl = argValue("model-url") ?? DEFAULT_MODEL_URL;
  const inputWidth = pickPositiveInt("width", 320);
  const batchSize = pickPositiveInt("batch", 1);
  const classCount = pickPositiveInt("classes", 18710);
  const runs = pickPositiveInt("runs", 3);

  mkdirSync(REPORTS_DIR, { recursive: true });
  const server = await startProbeServer();
  const browser = await chromium.launch({
    headless: false,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--enable-unsafe-webgpu",
    ],
  });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(900000);
    page.on("console", (message) => {
      console.log(`[graph-capture:${message.type()}] ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      console.log(`[graph-capture:pageerror] ${error.message}`);
    });
    await page.goto(server.url, { waitUntil: "load" });
    await page.evaluate(() => {
      (window as unknown as {
        chrome: {
          runtime: {
            getURL(path: string): string;
            onMessage: { addListener(): void };
          };
        };
      }).chrome = {
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
    await page.waitForFunction(() => Boolean((window as unknown as { __shinobu_shared?: unknown }).__shinobu_shared));
    const result = await page.evaluate<Promise<PaddleGraphCaptureProbeResult>, {
      modelUrl: string;
      inputWidth: number;
      batchSize: number;
      classCount: number;
      runs: number;
    }>(async (options) => {
      const bridgeUrl = "/chunks/onnxWorkerBridge.js";
      const bridge = await import(bridgeUrl) as PaddleGraphCaptureBridge;
      return bridge.probePaddleGraphCapture({
        ...options,
        modelUrl: new URL(options.modelUrl.replace(/^\/+/, ""), location.origin).toString(),
      });
    }, { modelUrl, inputWidth, batchSize, classCount, runs });

    const rounded = roundResult(result);
    console.log(JSON.stringify(rounded, null, 2));
    const reportPath = join(REPORTS_DIR, `paddle-graph-capture-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(reportPath, JSON.stringify(rounded, null, 2));
    console.log(`Report saved: ${reportPath}`);
  } finally {
    await browser.close();
    await server.close();
  }
}

await main();
