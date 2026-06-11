/**
 * Node CLI entry point for standalone pipeline baking.
 *
 * Replaces bake-fixtures.ts (Chrome CDP path) with a native Node.js runner
 * that uses nodePlatform + onnxNodeBridge (CUDA EP). Runs detect -> OCR ->
 * merge -> bake and outputs Fixture JSON files compatible with the existing
 * benchmark infrastructure.
 *
 * Usage:
 *   npx tsx benchmark/typeset/src/bake-node.ts [--out-dir path] [image1.png image2.jpg ...]
 *   npm run bench:bake-node
 *
 * If no image paths are given, scans benchmark/typeset/images/ directory.
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { dirname, extname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import type { BakeInfo, Fixture, FixtureRegion, GroundTruthColumn } from "./types";
import type { BakeResultRegion } from "../../../src/pipeline/bake";
import { shinobuBake } from "../../../src/pipeline/bake";
import { nodePlatform } from "../../../src/runtime/nodePlatform";

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), "../../..");
const IMAGES_DIR = join(ROOT, "benchmark/typeset/images");
const FIXTURES_DIR = join(ROOT, "benchmark/typeset/fixtures");
const MODELS_DIR = join(ROOT, "public/models");

type BakeNodeOptions = {
  imagePaths: string[];
  fixturesDir: string;
};

// ---------------------------------------------------------------------------
// Utility functions (from bake-fixtures.ts)
// ---------------------------------------------------------------------------

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

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

function resolveCliPath(path: string): string {
  return resolve(ROOT, path);
}

function parseArgs(args: string[]): BakeNodeOptions {
  const imagePaths: string[] = [];
  let fixturesDir = FIXTURES_DIR;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--out-dir") {
      const outDir = args[i + 1];
      if (!outDir) {
        console.error("--out-dir requires a path.");
        process.exit(1);
      }
      fixturesDir = resolveCliPath(outDir);
      i++;
      continue;
    }
    if (arg.startsWith("--out-dir=")) {
      fixturesDir = resolveCliPath(arg.slice("--out-dir=".length));
      continue;
    }
    if (arg.startsWith("--")) {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
    imagePaths.push(resolveCliPath(arg));
  }

  return { imagePaths, fixturesDir };
}

// ---------------------------------------------------------------------------
// Fixture format converters (from bake-fixtures.ts)
// ---------------------------------------------------------------------------

function buildGroundTruthColumns(
  detected: Array<{
    centerX: number; topY: number; bottomY: number;
    width: number; height: number; text: string; charCount: number;
  }>,
): GroundTruthColumn[] {
  if (detected.length === 0) return [];

  return detected.map((col, i) => {
    const chars = [...col.text.replace(/\s+/g, "")];
    const charCenters: { y: number }[] = [];
    if (chars.length > 0) {
      const step = col.height / chars.length;
      for (let j = 0; j < chars.length; j++) {
        charCenters.push({ y: col.topY + step * j + step / 2 });
      }
    }

    return {
      index: i,
      text: col.text,
      charCount: col.charCount,
      centerX: col.centerX,
      topY: col.topY,
      bottomY: col.bottomY,
      width: col.width,
      height: col.height,
      estimatedFontSize: Math.min(col.width, chars.length > 0 ? col.height / chars.length : 24),
      charCenters,
    };
  });
}

function buildTypesetSnapshotColumns(
  boxes: Array<{ x: number; y: number; width: number; height: number }>,
  sourceText: string,
  fontSize: number,
): GroundTruthColumn[] {
  if (boxes.length === 0) return [];

  const chars = [...sourceText.replace(/\s+/g, "")];
  const totalHeight = boxes.reduce((s, b) => s + b.height, 0);
  const columns: GroundTruthColumn[] = [];
  let charIdx = 0;

  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    const proportion = totalHeight > 0 ? box.height / totalHeight : 1 / boxes.length;
    const colCharCount = Math.max(1, Math.round(proportion * chars.length));
    const colChars = chars.slice(charIdx, charIdx + colCharCount);
    charIdx += colChars.length;

    const charCenters: { y: number }[] = [];
    if (colChars.length > 0) {
      const step = box.height / colChars.length;
      for (let j = 0; j < colChars.length; j++) {
        charCenters.push({ y: box.y + step * j + step / 2 });
      }
    }

    columns.push({
      index: i,
      text: colChars.join(""),
      charCount: colChars.length,
      centerX: box.x + box.width / 2,
      topY: box.y,
      bottomY: box.y + box.height,
      width: box.width,
      height: box.height,
      estimatedFontSize: Math.min(box.width, colChars.length > 0 ? box.height / colChars.length : fontSize),
      charCenters,
    });
  }

  return columns;
}

function bakeRegionToFixtureRegion(r: BakeResultRegion): FixtureRegion {
  return {
    id: r.id,
    direction: r.direction,
    box: r.box,
    quad: r.quad,
    sourceText: r.sourceText,
    fontSize: r.fontSize,
    fgColor: r.fgColor,
    bgColor: r.bgColor,
    originalLineCount: r.originalLineCount,
    translatedColumns: r.translatedColumns,
    groundTruth: {
      columns: buildGroundTruthColumns(r.detectedColumns ?? []),
    },
    currentTypeset: {
      fittedFontSize: r.typesetDebug?.fittedFontSize ?? 0,
      columns: buildTypesetSnapshotColumns(
        r.typesetDebug?.columnBoxes ?? [],
        r.sourceText ?? "",
        r.typesetDebug?.fittedFontSize ?? 24,
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Font registration
// ---------------------------------------------------------------------------

function registerFonts(): void {
  // Register project fonts from public/fonts/
  // Note: node-canvas registerFont only supports .ttf/.otf, NOT .woff2.
  // If only .woff2 files exist, they cannot be used by node-canvas.
  // Users must install the .ttf version for the Node bake path.
  const fontsDir = join(ROOT, "public/fonts");
  if (existsSync(fontsDir)) {
    const fontFiles = readdirSync(fontsDir).filter((f) =>
      /\.(ttf|otf|ttc)$/i.test(f),
    );
    if (fontFiles.length === 0) {
      console.warn("  No .ttf/.otf font files found in public/fonts/ (node-canvas cannot use .woff2)");
      console.warn("  Install .ttf versions for accurate CJK text measurement in the Node bake path.");
    }
    for (const fontFile of fontFiles) {
      const fontPath = join(fontsDir, fontFile);
      // Extract family name from filename convention:
      // SourceHanSansCN-VF.ttf -> SourceHanSansCN
      const baseName = fontFile.replace(/-VF\.(ttf|otf)$/i, "");
      nodePlatform.registerFont(fontPath, baseName);
      console.log(`  Registered font: ${baseName} (${fontFile})`);
    }
  }

  // Register system CJK fonts as fallbacks
  const systemFontPaths = [
    { path: "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf", family: "IPAGothic" },
    { path: "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", family: "WenQuanYi Zen Hei" },
  ];
  for (const { path, family } of systemFontPaths) {
    if (existsSync(path)) {
      nodePlatform.registerFont(path, family);
      console.log(`  Registered system font: ${family}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Model file check
// ---------------------------------------------------------------------------

function checkModelFiles(): void {
  const requiredModels = ["detector.onnx", "ocr.onnx"];
  const missing = requiredModels.filter((m) => !existsSync(join(MODELS_DIR, m)));
  if (missing.length > 0) {
    console.error(`Missing model files in ${MODELS_DIR}:`);
    for (const m of missing) {
      console.error(`  - ${m}`);
    }
    console.error("Please download the model files before running bake-node.");
    process.exit(1);
  }
  console.log(`Model files OK in ${MODELS_DIR}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  // Determine image files: from CLI args or scan IMAGES_DIR
  let imageFiles: string[];
  if (options.imagePaths.length > 0) {
    // Absolute or relative paths provided via CLI
    imageFiles = options.imagePaths;
    // Verify all files exist
    for (const imgPath of imageFiles) {
      if (!existsSync(imgPath)) {
        console.error(`Image file not found: ${imgPath}`);
        process.exit(1);
      }
    }
  } else {
    // Scan default images directory
    if (!existsSync(IMAGES_DIR)) {
      console.error(`Images directory not found: ${IMAGES_DIR}`);
      process.exit(1);
    }
    const dirEntries = readdirSync(IMAGES_DIR).filter((f) =>
      /\.(png|jpe?g|webp)$/i.test(f),
    );
    if (dirEntries.length === 0) {
      console.error(`No images found in ${IMAGES_DIR}`);
      console.error("Add image files or provide paths as CLI arguments.");
      process.exit(1);
    }
    imageFiles = dirEntries.map((f) => join(IMAGES_DIR, f));
  }

  console.log(`Found ${imageFiles.length} images to bake`);
  console.log(`Writing fixtures to ${options.fixturesDir}`);

  // Pre-flight checks
  checkModelFiles();
  registerFonts();

  // Ensure fixtures output directory exists
  mkdirSync(options.fixturesDir, { recursive: true });

  const bakeInfo: BakeInfo = {
    gitCommit: gitCommit(),
    detectorModel: "detector.onnx",
    ocrModel: "ocr.onnx",
  };

  let successCount = 0;
  let failCount = 0;

  for (const imgPath of imageFiles) {
    const imgFile = imgPath.includes(IMAGES_DIR)
      ? imgPath.slice(IMAGES_DIR.length + 1)
      : imgPath;
    console.log(`Baking: ${imgFile}`);

    try {
      const dataUrl = imageToDataUrl(imgPath);

      const result = await shinobuBake(dataUrl, nodePlatform);

      const fixtureRegions: FixtureRegion[] = result.regions.map(bakeRegionToFixtureRegion);

      const fixture: Fixture = {
        schemaVersion: 1,
        image: {
          file: `images/${imgFile}`,
          width: result.imageWidth,
          height: result.imageHeight,
          sha256: sha256File(imgPath),
        },
        bakedAt: new Date().toISOString(),
        bakedWith: bakeInfo,
        regions: fixtureRegions,
      };

      const fixtureName = imgFile.replace(/\.[^.]+$/, "") + ".fixture.json";
      const fixturePath = join(options.fixturesDir, fixtureName);
      writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
      console.log(`  -> ${fixtureName} (${fixtureRegions.length} regions)`);
      successCount++;
    } catch (error) {
      console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && error.stack) {
        console.error(`  Stack: ${error.stack}`);
      }
      failCount++;
    }
  }

  console.log(`\nBake complete: ${successCount} succeeded, ${failCount} failed`);
}

main();
