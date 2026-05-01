import { chromium } from "playwright";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { extname, join, resolve } from "path";
import { execSync } from "child_process";
import type { BakeInfo, Fixture, FixtureRegion, GroundTruthColumn } from "./types";

const ROOT = resolve(import.meta.dirname, "../..");
const IMAGES_DIR = join(ROOT, "benchmark/images");
const FIXTURES_DIR = join(ROOT, "benchmark/fixtures");
const DIST_DIR = join(ROOT, "dist");

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
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

function buildGroundTruthColumns(
  detected: Array<{
    centerX: number; topY: number; bottomY: number;
    width: number; height: number; text: string; charCount: number;
  }>,
): GroundTruthColumn[] {
  if (detected.length === 0) return [];

  return detected.map((col, i) => {
    const chars = [...col.text];
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

async function main(): Promise<void> {
  console.log("Building extension...");
  execSync("npm run build", { cwd: ROOT, stdio: "inherit" });

  const imageFiles = readdirSync(IMAGES_DIR).filter((f) =>
    /\.(png|jpe?g|webp)$/i.test(f),
  );
  if (imageFiles.length === 0) {
    console.error("No images found in benchmark/images/");
    process.exit(1);
  }

  mkdirSync(FIXTURES_DIR, { recursive: true });

  const browser = await chromium.launchPersistentContext("", {
    headless: false,
    args: [
      `--disable-extensions-except=${DIST_DIR}`,
      `--load-extension=${DIST_DIR}`,
    ],
  });

  const bakeInfo: BakeInfo = {
    gitCommit: gitCommit(),
    detectorModel: "detector.onnx",
    ocrModel: "ocr.onnx",
  };

  for (const imgFile of imageFiles) {
    console.log(`Baking: ${imgFile}`);
    const imgPath = join(IMAGES_DIR, imgFile);
    const dataUrl = imageToDataUrl(imgPath);

    const page = await browser.newPage();
    await page.goto("about:blank");

    const result = await page.evaluate(async (dataUrl: string) => {
      if (typeof (window as any).__shinobu_bake__ !== "function") {
        throw new Error("__shinobu_bake__ not available. Is the extension loaded?");
      }
      return (window as any).__shinobu_bake__(dataUrl);
    }, dataUrl);

    const regions: FixtureRegion[] = result.regions.map((r: any) => ({
      id: r.id,
      direction: r.direction as "v" | "h",
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
    }));

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
      regions,
    };

    const fixtureName = imgFile.replace(/\.[^.]+$/, "") + ".fixture.json";
    writeFileSync(
      join(FIXTURES_DIR, fixtureName),
      JSON.stringify(fixture, null, 2),
    );
    console.log(`  -> ${fixtureName} (${regions.length} regions)`);
    await page.close();
  }

  await browser.close();
  console.log("Bake complete.");
}

main();
