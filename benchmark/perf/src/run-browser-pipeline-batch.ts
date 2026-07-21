import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "@playwright/test";
import type { ShinobuBenchmarkWindow } from "../../../src/benchmark/browserEntry";
import {
  defaultExtensionSettings,
  toPipelineConfig,
} from "../../../src/shared/config";
import type {
  OcrRunDebugInfo,
  OcrPostFilterDebugInfo,
  PipelineConfig,
  PipelineStageRegions,
  QuadPoint,
  Rect,
  RuntimeStageStatus,
  StageTiming,
  TextRegion,
} from "../../../src/types";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DIST_DIR = join(ROOT, "dist");
const TMP_DIR = join(ROOT, ".tmp");
const USER_DATA_DIR = join(TMP_DIR, `browser-pipeline-batch-${Date.now()}`);
const DEFAULT_CONCURRENCY = 2;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif"]);
const REQUIRED_WEBGPU_MODELS = ["detector", "bubble", "ocr"] as const;

type SerializableTextRegion = Omit<TextRegion, "bubbleMask">;
type SerializableStageRegions = {
  [Stage in keyof PipelineStageRegions]: SerializableTextRegion[];
};

type OcrScaleVariant = {
  name: string;
  scale: number;
};

type OcrVariantResult = OcrScaleVariant & {
  variantRegionId: string;
  box: Rect;
  quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  text: string;
  confidence: number;
  accepted: boolean;
};

type OcrVariantRegionResult = {
  regionId: string;
  sourceText: string;
  probability?: number;
  box: Rect;
  quad?: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  direction?: TextRegion["direction"];
  variants: OcrVariantResult[];
};

type RawMaskPayload = {
  width: number;
  height: number;
  pngBase64: string;
};

type RawMaskReference = {
  width: number;
  height: number;
  path: string;
};

type PagePipelineResult = {
  imageWidth: number;
  imageHeight: number;
  stageRegions: SerializableStageRegions;
  runtimeStages: RuntimeStageStatus[];
  stageTimings: StageTiming[];
  rawMask?: RawMaskPayload;
  ocrVariantRegions?: OcrVariantRegionResult[];
  ocrVariantDebug?: OcrRunDebugInfo;
  ocrPostFilterDebug?: OcrPostFilterDebugInfo | null;
};

type BatchResult = Omit<PagePipelineResult, "rawMask"> & {
  index: number;
  input: string;
  output: string;
  durationMs: number;
  rawMask?: RawMaskReference;
};

type BatchFailure = {
  index: number;
  input: string;
  error: string;
};

type BatchOptions = {
  inputDir: string;
  outputDir: string;
  concurrency: number;
  saveRawMask: boolean;
  ocrScales: OcrScaleVariant[];
  ocrPostFilter: NonNullable<PipelineConfig["ocrPostFilter"]>;
};

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return (
    process.argv.includes(`--${name}`)
    || process.argv.includes(`--${name}=true`)
  );
}

function parseOcrScales(value: string | undefined): OcrScaleVariant[] {
  if (!value) return [];
  const scales = value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item, index, all) => (
      Number.isFinite(item)
      && item >= 0.5
      && item <= 1.5
      && all.indexOf(item) === index
    ));
  if (scales.length === 0) {
    throw new Error(`无效 OCR scales: ${value}`);
  }
  return scales.map((scale) => ({
    name: Math.abs(scale - 1) < 1e-6
      ? "original"
      : scale < 1
        ? "inset"
        : "outset",
    scale,
  }));
}

function parseOptions(): BatchOptions {
  const inputValue = readOption("input");
  if (!inputValue) {
    throw new Error(
      "缺少输入目录。用法: npm run bench:browser-pipeline-batch -- --input=<图片目录>",
    );
  }

  const inputDir = resolve(inputValue);
  const outputDir = resolve(
    readOption("output")
      ?? join(ROOT, "benchmark", "reports", `pipeline-batch-${new Date().toISOString().replace(/[:.]/g, "-")}`),
  );
  const rawConcurrency = Number(readOption("concurrency") ?? DEFAULT_CONCURRENCY);
  if (!Number.isInteger(rawConcurrency) || rawConcurrency < 1) {
    throw new Error(`无效并发度: ${rawConcurrency}`);
  }

  const ocrScales = parseOcrScales(readOption("ocr-scales"));
  const requestedPostFilter = readOption("ocr-post-filter")
    ?? (ocrScales.length > 0 ? "off" : "balanced");
  if (requestedPostFilter !== "off" && requestedPostFilter !== "balanced") {
    throw new Error(`无效 OCR post-filter 模式: ${requestedPostFilter}`);
  }

  return {
    inputDir,
    outputDir,
    concurrency: rawConcurrency,
    saveRawMask: hasFlag("save-raw-mask"),
    ocrScales,
    ocrPostFilter: requestedPostFilter,
  };
}

function requireFile(relativePath: string): void {
  const fullPath = join(DIST_DIR, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`缺少构建产物: ${fullPath}。请先运行 npm run build:benchmark。`);
  }
}

function findChromeExecutable(): string {
  const playwrightChromiumRoot = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, "ms-playwright")
    : null;
  const installedPlaywrightChromium = playwrightChromiumRoot && existsSync(playwrightChromiumRoot)
    ? readdirSync(playwrightChromiumRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
      .map((entry) => join(playwrightChromiumRoot, entry.name, "chrome-win64", "chrome.exe"))
    : [];
  const candidates = [
    process.env.CHROME_PATH,
    chromium.executablePath(),
    ...installedPlaywrightChromium,
    "C:/Program Files/Google/Chrome for Testing/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome for Testing/Application/chrome.exe",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "未找到可加载未打包扩展的 Chrome/Chromium。请安装 Playwright Chromium，"
      + "或通过 CHROME_PATH 指定 Chrome for Testing。",
  );
}

async function collectImages(rootDir: string): Promise<string[]> {
  const rootStat = await stat(rootDir).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`输入目录不存在: ${rootDir}`);
  }

  const images: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        images.push(path);
      }
    }
  };
  await walk(rootDir);
  return images;
}

function mimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".avif":
      return "image/avif";
    case ".gif":
      return "image/gif";
    default:
      return "image/jpeg";
  }
}

function toPortablePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function assertWebGpuStages(stages: RuntimeStageStatus[]): void {
  for (const model of REQUIRED_WEBGPU_MODELS) {
    const stage = stages.find((item) => item.model === model);
    if (!stage?.enabled || stage.provider !== "webgpu") {
      throw new Error(
        `${model} 未使用 WebGPU: ${stage?.detail ?? "缺少 runtime stage"}`,
      );
    }
    if (model === "detector" && stage.engine !== "onnx") {
      throw new Error(`detector 已回退到 ${stage.engine ?? "unknown"}`);
    }
  }
}

async function runImageInPage(
  page: Page,
  imagePath: string,
  config: PipelineConfig,
  options: Pick<BatchOptions, "saveRawMask" | "ocrScales">,
): Promise<PagePipelineResult> {
  const bytes = await readFile(imagePath);
  const task = {
    dataUrl: `data:${mimeType(imagePath)};base64,${bytes.toString("base64")}`,
    fileName: basename(imagePath),
    config,
    saveRawMask: options.saveRawMask,
    ocrScales: options.ocrScales,
  };

  return page.evaluate<PagePipelineResult, typeof task>(
    async ({
      dataUrl,
      fileName,
      config: pipelineConfig,
      saveRawMask,
      ocrScales,
    }) => {
      const api = (window as ShinobuBenchmarkWindow).__shinobuBenchmark__;
      if (!api) throw new Error("Benchmark API 不可用");

      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const file = new File([blob], fileName, { type: blob.type });
      const artifacts = await api.runPipeline(
        file,
        pipelineConfig,
        () => undefined,
        { stopAfter: "order" },
      );
      const serializeRegions = (regions: TextRegion[]): SerializableTextRegion[] => (
        regions.map((region) => {
          const { bubbleMask: _bubbleMask, ...serializable } = region;
          return serializable;
        })
      );

      const clamp = (value: number, minimum: number, maximum: number): number => (
        Math.max(minimum, Math.min(maximum, value))
      );
      const regionQuad = (
        region: TextRegion,
      ): [QuadPoint, QuadPoint, QuadPoint, QuadPoint] => (
        region.quad ?? [
          { x: region.box.x, y: region.box.y },
          { x: region.box.x + region.box.width, y: region.box.y },
          { x: region.box.x + region.box.width, y: region.box.y + region.box.height },
          { x: region.box.x, y: region.box.y + region.box.height },
        ]
      );
      const scaledQuad = (
        region: TextRegion,
        scale: number,
      ): [QuadPoint, QuadPoint, QuadPoint, QuadPoint] => {
        const quad = regionQuad(region);
        const centerX = quad.reduce((sum, point) => sum + point.x, 0) / quad.length;
        const centerY = quad.reduce((sum, point) => sum + point.y, 0) / quad.length;
        return quad.map((point) => ({
          x: clamp(
            centerX + (point.x - centerX) * scale,
            0,
            Math.max(0, artifacts.original.naturalWidth - 1),
          ),
          y: clamp(
            centerY + (point.y - centerY) * scale,
            0,
            Math.max(0, artifacts.original.naturalHeight - 1),
          ),
        })) as [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
      };
      const quadBox = (
        quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint],
      ): Rect => {
        const minX = Math.floor(Math.min(...quad.map((point) => point.x)));
        const minY = Math.floor(Math.min(...quad.map((point) => point.y)));
        const maxX = Math.ceil(Math.max(...quad.map((point) => point.x)));
        const maxY = Math.ceil(Math.max(...quad.map((point) => point.y)));
        return {
          x: minX,
          y: minY,
          width: Math.max(1, maxX - minX),
          height: Math.max(1, maxY - minY),
        };
      };

      let ocrVariantRegions: OcrVariantRegionResult[] | undefined;
      let ocrVariantDebug: OcrRunDebugInfo | undefined;
      if (ocrScales.length > 0 && artifacts.stageRegions.ordered.length > 0) {
        const variantMetadata: Array<{
          sourceRegion: TextRegion;
          variant: OcrScaleVariant;
          variantRegion: TextRegion;
        }> = [];
        for (const sourceRegion of artifacts.stageRegions.ordered) {
          for (const variant of ocrScales) {
            const quad = scaledQuad(sourceRegion, variant.scale);
            variantMetadata.push({
              sourceRegion,
              variant,
              variantRegion: {
                id: `${sourceRegion.id}::ocr-${variant.name}-${variant.scale}`,
                box: quadBox(quad),
                quad,
                direction: sourceRegion.direction,
                sourceText: "",
                translatedText: "",
              },
            });
          }
        }
        const rawOcr = await api.recognizeOcrRegions(
          artifacts.original,
          variantMetadata.map((item) => item.variantRegion),
          pipelineConfig.ocrEngine,
        );
        ocrVariantDebug = rawOcr.debug;
        const debugByRegionId = new Map(
          (rawOcr.debug?.paddle?.regions ?? []).map((item) => [item.regionId, item]),
        );
        const acceptedByRegionId = new Map(
          rawOcr.results
            .filter((item) => item.regionId)
            .map((item) => [item.regionId!, item]),
        );
        ocrVariantRegions = artifacts.stageRegions.ordered.map((sourceRegion) => ({
          regionId: sourceRegion.id,
          sourceText: sourceRegion.sourceText,
          probability: sourceRegion.prob,
          box: { ...sourceRegion.box },
          quad: sourceRegion.quad?.map((point) => ({ ...point })) as
            | [QuadPoint, QuadPoint, QuadPoint, QuadPoint]
            | undefined,
          direction: sourceRegion.direction,
          variants: variantMetadata
            .filter((item) => item.sourceRegion.id === sourceRegion.id)
            .map((item) => {
              const debug = debugByRegionId.get(item.variantRegion.id);
              const accepted = acceptedByRegionId.get(item.variantRegion.id);
              return {
                ...item.variant,
                variantRegionId: item.variantRegion.id,
                box: { ...item.variantRegion.box },
                quad: regionQuad(item.variantRegion),
                text: debug?.decodedText ?? accepted?.text ?? "",
                confidence: debug?.confidence ?? accepted?.confidence ?? 0,
                accepted: debug?.accepted ?? Boolean(accepted),
              };
            }),
        }));
      }

      let rawMask: RawMaskPayload | undefined;
      if (saveRawMask && artifacts.segmentationCanvas) {
        const dataUrl = artifacts.segmentationCanvas.toDataURL("image/png");
        const separator = dataUrl.indexOf(",");
        if (separator < 0) {
          throw new Error("detector raw mask 无法编码为 PNG");
        }
        rawMask = {
          width: artifacts.segmentationCanvas.width,
          height: artifacts.segmentationCanvas.height,
          pngBase64: dataUrl.slice(separator + 1),
        };
      }

      return {
        imageWidth: artifacts.original.naturalWidth,
        imageHeight: artifacts.original.naturalHeight,
        stageRegions: {
          detected: serializeRegions(artifacts.stageRegions.detected),
          ocr: serializeRegions(artifacts.stageRegions.ocr),
          merged: serializeRegions(artifacts.stageRegions.merged),
          ordered: serializeRegions(artifacts.stageRegions.ordered),
        },
        runtimeStages: artifacts.runtimeStages,
        stageTimings: artifacts.stageTimings,
        rawMask,
        ocrVariantRegions,
        ocrVariantDebug,
        ocrPostFilterDebug: artifacts.ocrPostFilterDebug,
      };
    },
    task,
  );
}

async function persistRawMask(
  outputDir: string,
  relativeInput: string,
  rawMask: RawMaskPayload | undefined,
): Promise<RawMaskReference | undefined> {
  if (!rawMask) return undefined;
  const maskPath = join(outputDir, "raw-masks", `${relativeInput}.mask.png`);
  await mkdir(dirname(maskPath), { recursive: true });
  await writeFile(maskPath, Buffer.from(rawMask.pngBase64, "base64"));
  return {
    width: rawMask.width,
    height: rawMask.height,
    path: toPortablePath(relative(outputDir, maskPath)),
  };
}

async function writeImageResult(
  outputDir: string,
  relativeInput: string,
  result: Omit<BatchResult, "output">,
): Promise<string> {
  const outputPath = join(outputDir, `${relativeInput}.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  const record: BatchResult = {
    ...result,
    output: toPortablePath(relative(outputDir, outputPath)),
  };
  await writeFile(outputPath, JSON.stringify(record, null, 2), "utf8");
  return outputPath;
}

async function main(): Promise<void> {
  const options = parseOptions();
  for (const asset of [
    "manifest.json",
    "benchmark.html",
    "benchmark.js",
    "onnxWorker.js",
    "models/models.json",
    "models/detector.onnx",
    "models/bubble.onnx",
    "models/PP-OCRv6_medium_rec.onnx",
    "models/paddleocr_v6_dict.txt",
  ]) {
    requireFile(asset);
  }

  const images = await collectImages(options.inputDir);
  if (images.length === 0) {
    throw new Error(`输入目录没有可处理图片: ${options.inputDir}`);
  }
  await mkdir(options.outputDir, { recursive: true });
  await mkdir(USER_DATA_DIR, { recursive: true });

  const config = toPipelineConfig({
    ...defaultExtensionSettings,
    processMode: "original",
    showTypesetDebug: false,
    showEraseDebug: false,
    enableDebugLog: false,
  });
  config.ocrPostFilter = options.ocrPostFilter;
  const startedAt = performance.now();
  const failures: BatchFailure[] = [];
  const results: Array<BatchResult | null> = Array.from({ length: images.length }, () => null);
  const chromePath = findChromeExecutable();
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: chromePath,
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
  context.setDefaultTimeout(600_000);

  try {
    const worker = context.serviceWorkers()[0]
      ?? await context.waitForEvent("serviceworker", { timeout: 30_000 });
    const extensionId = worker.url().match(/^chrome-extension:\/\/([^/]+)/)?.[1];
    if (!extensionId) {
      throw new Error(`无法解析扩展 ID: ${worker.url()}`);
    }

    const page = await context.newPage();
    page.setDefaultTimeout(600_000);
    page.on("pageerror", (error) => {
      console.error(`[pageerror] ${error.message}`);
    });
    await page.goto(`chrome-extension://${extensionId}/benchmark.html`, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(
      (window as ShinobuBenchmarkWindow).__shinobuBenchmark__,
    ));
    await page.evaluate("var __name = (target) => target;");
    const hasWebGpu = await page.evaluate(() => Boolean(navigator.gpu));
    if (!hasWebGpu) {
      throw new Error("Chrome 当前环境没有 navigator.gpu");
    }

    const processImage = async (index: number, lane: number): Promise<void> => {
      const imagePath = images[index];
      const relativeInput = toPortablePath(relative(options.inputDir, imagePath));
      const imageStartedAt = performance.now();
      console.log(`[${index + 1}/${images.length}] lane=${lane} ${relativeInput}`);
      try {
        const pageResult = await runImageInPage(page, imagePath, config, options);
        assertWebGpuStages(pageResult.runtimeStages);
        const { rawMask: rawMaskPayload, ...serializablePageResult } = pageResult;
        const rawMask = await persistRawMask(
          options.outputDir,
          relativeInput,
          rawMaskPayload,
        );
        const recordWithoutOutput = {
          ...serializablePageResult,
          rawMask,
          index,
          input: relativeInput,
          durationMs: performance.now() - imageStartedAt,
        };
        const outputPath = await writeImageResult(
          options.outputDir,
          relativeInput,
          recordWithoutOutput,
        );
        results[index] = {
          ...recordWithoutOutput,
          output: toPortablePath(relative(options.outputDir, outputPath)),
        };
        console.log(
          `[${index + 1}/${images.length}] 完成 ${relativeInput} (${Math.round(recordWithoutOutput.durationMs)}ms)`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ index, input: relativeInput, error: message });
        console.error(`[${index + 1}/${images.length}] 失败 ${relativeInput}: ${message}`);
      }
    };

    // Use the first real item as a warm run so all later lanes reuse the same model sessions.
    await processImage(0, 0);
    let nextIndex = 1;
    const processNext = async (lane: number): Promise<void> => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= images.length) return;
        await processImage(index, lane);
      }
    };

    if (images.length > 1) {
      await Promise.all(
        Array.from(
          { length: Math.min(options.concurrency, images.length - nextIndex) },
          (_, lane) => processNext(lane + 1),
        ),
      );
    }
  } finally {
    await context.close();
  }

  const completed = results.filter((result): result is BatchResult => result !== null);
  const summary = {
    createdAt: new Date().toISOString(),
    inputDir: options.inputDir,
    outputDir: options.outputDir,
    concurrency: options.concurrency,
    saveRawMask: options.saveRawMask,
    ocrScales: options.ocrScales,
    ocrPostFilter: options.ocrPostFilter,
    total: images.length,
    completed: completed.length,
    failed: failures.length,
    durationMs: performance.now() - startedAt,
    results: completed.map(({ index, input, output, durationMs }) => ({
      index,
      input,
      output,
      durationMs,
    })),
    failures: failures.sort((a, b) => a.index - b.index),
  };
  const summaryPath = join(options.outputDir, "batch-summary.json");
  await writeFile(summaryPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`批处理完成: ${completed.length}/${images.length}`);
  console.log(`结果目录: ${options.outputDir}`);

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

await main();
