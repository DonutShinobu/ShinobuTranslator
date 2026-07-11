/**
 * Node CLI entry point for standalone pipeline baking.
 *
 * Replaces bake-fixtures.ts (Chrome CDP path) with a native Node.js runner
 * that uses nodePlatform + onnxNodeBridge (CUDA EP). Runs detect -> OCR ->
 * merge -> bake and outputs Fixture JSON files compatible with the existing
 * benchmark infrastructure.
 *
 * Usage:
 *   npx tsx benchmark/typeset/src/bake-node.ts [--suite-dir path] [--out-dir path] [--direction all|h|v] [image1.png image2.jpg ...]
 *   npm run bench:bake-node
 *
 * If no image paths are given, scans the selected suite's images/ directory.
 */

import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, dirname, extname, join, relative, resolve } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import type { BakeInfo, Fixture } from "./types";
import type { BakeDirection } from "../../../src/pipeline/bake";
import { shinobuBake } from "../../../src/pipeline/bake";
import { nodePlatform } from "../../../src/runtime/nodePlatform";
import { parseBakeDirectionArgs } from "./bake-options";
import { bakeResultRegionToFixtureRegion } from "./fixture-build";
import { parseTypesetSuiteArgs, resolveTypesetBenchmarkPath } from "./suite-paths";

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), "../../..");
const MODELS_DIR = join(ROOT, "public/models");

type BakeNodeOptions = {
  imagePaths: string[];
  imagesDir: string;
  fixturesDir: string;
  direction: BakeDirection;
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

function parseArgs(args: string[]): BakeNodeOptions {
  const parsed = parseTypesetSuiteArgs(args, { fixtureOutputAlias: true });
  const bakeOptions = parseBakeDirectionArgs(parsed.remainingArgs);
  const imagePaths: string[] = [];

  for (const arg of bakeOptions.remainingArgs) {
    if (arg.startsWith("--")) {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
    imagePaths.push(resolveTypesetBenchmarkPath(arg));
  }

  return {
    imagePaths,
    imagesDir: parsed.paths.imagesDir,
    fixturesDir: parsed.paths.fixturesDir,
    direction: bakeOptions.direction,
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
  const requiredModels = ["detector.onnx", "bubble.onnx", "aot_inpaint_512.onnx", "PP-OCRv6_medium_rec.onnx", "paddleocr_v6_dict.txt"];
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

  // Determine image files: from CLI args or scan the selected suite images directory.
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
    // Scan the selected suite images directory.
    if (!existsSync(options.imagesDir)) {
      console.error(`Images directory not found: ${options.imagesDir}`);
      process.exit(1);
    }
    const dirEntries = readdirSync(options.imagesDir).filter((f) =>
      /\.(png|jpe?g|webp)$/i.test(f),
    );
    if (dirEntries.length === 0) {
      console.error(`No images found in ${options.imagesDir}`);
      console.error("Add image files or provide paths as CLI arguments.");
      process.exit(1);
    }
    imageFiles = dirEntries.map((f) => join(options.imagesDir, f));
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
    ocrModel: "PP-OCRv6_medium_rec.onnx",
    direction: options.direction,
  };

  let successCount = 0;
  let failCount = 0;

  for (const imgPath of imageFiles) {
    const relativeImagePath = relative(options.imagesDir, imgPath);
    const imgFile = relativeImagePath.startsWith("..")
      ? basename(imgPath)
      : relativeImagePath;
    console.log(`Baking: ${imgFile}`);

    try {
      const dataUrl = imageToDataUrl(imgPath);

      const result = await shinobuBake(dataUrl, nodePlatform, {
        direction: options.direction,
      });

      const fixtureRegions = result.regions.map(bakeResultRegionToFixtureRegion);

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
