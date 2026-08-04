import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { chromium } from "@playwright/test";
import type { ShinobuBenchmarkWindow } from "../../../apps/extension/src/benchmark/browserEntry";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DIST_DIR = join(ROOT, "apps", "extension", "dist-chromium");
const TMP_DIR = join(ROOT, ".tmp");
const USER_DATA_DIR = join(TMP_DIR, `browser-pipeline-smoke-${Date.now()}`);
const DEFAULT_IMAGE = join(ROOT, "benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png");
const EXERCISE_ALL_API = process.argv.includes("--all-api");

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
  apiSmoke?: {
    render: boolean;
    renderDebug: boolean;
    renderFixtureDebug: boolean;
  };
};

function requireFile(relativePath: string): void {
  const fullPath = join(DIST_DIR, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Missing dist asset: ${fullPath}. Run npm run build:benchmark first.`);
  }
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

async function main(): Promise<void> {
  requireFile("manifest.json");
  requireFile("content.js");
  requireFile("benchmark.html");
  requireFile("benchmark.js");
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
    await page.goto(`chrome-extension://${extensionId}/benchmark.html`, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(
      (window as ShinobuBenchmarkWindow).__shinobuBenchmark__,
    ));
    await page.evaluate("var __name = (target) => target;");

    const result = await page.evaluate<
      PipelineSmokeResult,
      { dataUrl: string; imagePath: string; extensionId: string; exerciseAllApi: boolean }
    >(
      async ({
        dataUrl: pageDataUrl,
        imagePath: pageImagePath,
        extensionId: pageExtensionId,
        exerciseAllApi,
      }) => {
        const api = (window as ShinobuBenchmarkWindow).__shinobuBenchmark__;
        if (!api) throw new Error("Benchmark API is unavailable");
        const bakeResult = await api.bake(pageDataUrl);
        const regions: BakeRegion[] = bakeResult.regions;
        let apiSmoke: PipelineSmokeResult["apiSmoke"];
        if (exerciseAllApi) {
          const rendered = await api.render(pageDataUrl);
          const renderDebug = await api.renderDebug(pageDataUrl);
          const fixtureDebug = await api.renderFixtureDebug(pageDataUrl, bakeResult.regions);
          apiSmoke = {
            render: rendered.startsWith("data:image/png;base64,"),
            renderDebug: renderDebug.dataUrl.startsWith("data:image/png;base64,"),
            renderFixtureDebug: fixtureDebug.dataUrl.startsWith("data:image/png;base64,"),
          };
          if (!Object.values(apiSmoke).every(Boolean)) {
            throw new Error(`Benchmark render API smoke failed: ${JSON.stringify(apiSmoke)}`);
          }
        }
        const sampleTexts = regions
          .map((region) => region.sourceText)
          .filter((text) => text.length > 0)
          .slice(0, 5);
        return {
          extensionId: pageExtensionId,
          pageUrl: location.href,
          image: pageImagePath,
          imageWidth: bakeResult.imageWidth,
          imageHeight: bakeResult.imageHeight,
          regionCount: regions.length,
          nonEmptySourceCount: regions.filter((region) => region.sourceText.length > 0).length,
          sourceCharCount: regions.reduce((sum, region) => sum + region.sourceText.length, 0),
          sampleTexts,
          firstBox: regions[0]?.box ?? null,
          apiSmoke,
        };
      },
      { dataUrl, imagePath, extensionId, exerciseAllApi: EXERCISE_ALL_API }
    );

    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context.close();
  }
}

await main();
