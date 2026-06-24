import { createServer } from "http";
import type { AddressInfo } from "net";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { chromium } from "@playwright/test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DIST_DIR = join(ROOT, "dist");
const TMP_DIR = join(ROOT, ".tmp");
const USER_DATA_DIR = join(TMP_DIR, `browser-pipeline-smoke-${Date.now()}`);
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

type BakeRegion = {
  sourceText: string;
  box: { x: number; y: number; width: number; height: number };
};

type PipelineSmokeResult = {
  extensionId: string;
  pageUrl: string;
  image: string;
  imageWidth: number;
  imageHeight: number;
  regionCount: number;
  nonEmptySourceCount: number;
  sourceCharCount: number;
  sampleTexts: string[];
  firstBox: BakeRegion["box"] | null;
};

function requireFile(relativePath: string): void {
  const fullPath = join(DIST_DIR, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Missing dist asset: ${fullPath}. Run npm run build first.`);
  }
}

function findChromeExecutable(): string | undefined {
  if (!USE_SYSTEM_CHROME) {
    return undefined;
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("Chrome executable not found. Set CHROME_PATH to chrome.exe.");
}

function pickImagePath(): string {
  const arg = process.argv.find((value) => value.startsWith("--image="));
  const imagePath = arg ? resolve(arg.slice("--image=".length)) : DEFAULT_IMAGE;
  if (!existsSync(imagePath)) {
    throw new Error(`Image does not exist: ${imagePath}`);
  }
  return imagePath;
}

function imageToDataUrl(path: string): string {
  const buf = readFileSync(path);
  const ext = path.toLowerCase().endsWith(".jpg") || path.toLowerCase().endsWith(".jpeg") ? "jpeg" : "png";
  return `data:image/${ext};base64,${buf.toString("base64")}`;
}

async function startProbeServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    if (req.url !== "/" && req.url !== "/probe.html") {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html>
<meta charset="utf-8">
<title>shinobu pipeline smoke</title>
<script>
window.__shinobuMessages = [];
window.addEventListener("message", function (event) {
  window.__shinobuMessages.push(event.data);
});
</script>
<body>pipeline smoke</body>`);
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

async function main(): Promise<void> {
  requireFile("manifest.json");
  requireFile("content.js");
  requireFile("onnxWorker.js");
  requireFile("models/models.json");
  requireFile("models/detector.onnx");
  requireFile("models/bubble.onnx");
  requireFile("models/aot_inpaint_512.onnx");
  requireFile("models/PP-OCRv6_medium_rec.onnx");
  requireFile("models/paddleocr_v6_dict.txt");
  mkdirSync(USER_DATA_DIR, { recursive: true });

  const imagePath = pickImagePath();
  const dataUrl = imageToDataUrl(imagePath);
  const server = await startProbeServer();
  const chromePath = findChromeExecutable();
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
  context.setDefaultTimeout(600000);

  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 30000 });
    const extensionId = worker.url().match(/^chrome-extension:\/\/([^/]+)/)?.[1];
    if (!extensionId) {
      throw new Error(`Unable to parse extension id from service worker URL: ${worker.url()}`);
    }

    const page = await context.newPage();
    page.setDefaultTimeout(600000);
    page.on("console", (message) => {
      console.log(`[browser:${message.type()}] ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      console.log(`[pageerror] ${error.message}`);
    });
    await page.goto(server.url, { waitUntil: "domcontentloaded" });
    await page.evaluate("var __name = (target) => target;");

    const result = await page.evaluate<PipelineSmokeResult, { dataUrl: string; imagePath: string; extensionId: string }>(
      async ({ dataUrl: pageDataUrl, imagePath: pageImagePath, extensionId: pageExtensionId }) => {
        type BakeResponse = {
          type?: string;
          error?: string;
          result?: {
            imageWidth: number;
            imageHeight: number;
            regions: BakeRegion[];
          };
        };

        const response = await new Promise<BakeResponse>((resolveResponse, rejectResponse) => {
          const timeout = window.setTimeout(() => {
            window.removeEventListener("message", onMessage);
            rejectResponse(new Error("Timed out waiting for __shinobu_bake_response__"));
          }, 600000);
          function onMessage(event: MessageEvent) {
            const data = event.data as BakeResponse;
            if (data?.type !== "__shinobu_bake_response__") {
              return;
            }
            window.clearTimeout(timeout);
            window.removeEventListener("message", onMessage);
            resolveResponse(data);
          }
          window.addEventListener("message", onMessage);
          window.postMessage({ type: "__shinobu_bake_request__", dataUrl: pageDataUrl }, "*");
        });

        if (response.error) {
          throw new Error(response.error);
        }
        if (!response.result) {
          throw new Error("Bake response did not include result");
        }
        const regions = response.result.regions;
        const sampleTexts = regions
          .map((region) => region.sourceText)
          .filter((text) => text.length > 0)
          .slice(0, 5);
        return {
          extensionId: pageExtensionId,
          pageUrl: location.href,
          image: pageImagePath,
          imageWidth: response.result.imageWidth,
          imageHeight: response.result.imageHeight,
          regionCount: regions.length,
          nonEmptySourceCount: regions.filter((region) => region.sourceText.length > 0).length,
          sourceCharCount: regions.reduce((sum, region) => sum + region.sourceText.length, 0),
          sampleTexts,
          firstBox: regions[0]?.box ?? null,
        };
      },
      { dataUrl, imagePath, extensionId }
    );

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context.close();
    await server.close();
  }
}

await main();
