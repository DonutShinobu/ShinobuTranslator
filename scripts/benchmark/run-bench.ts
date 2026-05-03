import { createCanvas, loadImage, registerFont } from "canvas";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import { computeRegionMetrics } from "./metrics";
import type {
  BenchConfig,
  BenchmarkSummary,
  Fixture,
  GroundTruthColumn,
  ImageMetrics,
  RegionMetrics,
} from "./types";
import { computeFullVerticalTypeset } from "../../src/pipeline/typesetGeometry";
import type { TextRegion } from "../../src/types";

const ROOT = resolve(import.meta.dirname, "../..");

function loadConfig(): BenchConfig {
  const raw = readFileSync(join(ROOT, "benchmark/bench.config.json"), "utf-8");
  return JSON.parse(raw);
}

function sha256File(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

function registerFonts(): void {
  const fontsDir = join(ROOT, "benchmark/fonts");
  if (!existsSync(fontsDir)) {
    console.warn("No benchmark/fonts/ directory. Using system fonts.");
    return;
  }
  const files = readdirSync(fontsDir);
  for (const f of files) {
    if (f.endsWith(".ttf") || f.endsWith(".otf")) {
      const family = f.toLowerCase().includes("tw")
        ? "MTX-SourceHanSans-TW"
        : "MTX-SourceHanSans-CN";
      registerFont(join(fontsDir, f), { family });
    }
  }
}


function formatCsv(images: ImageMetrics[]): string {
  const header = [
    "image", "regionId", "skipped", "skipReason",
    "columnCountMatch", "columnCountDiff",
    "columnIouMean", "columnIouMin",
    "fontSizeRatio", "fontSizeError",
    "columnDxNormMean", "columnDxNormMax",
    "dTopNormMean", "dBottomNormMean", "heightRatioMean",
    "charDyNormMean", "charDyNormMax", "charDyNormP95",
    "compositeScore",
  ].join(",");
  const rows: string[] = [header];
  for (const img of images) {
    for (const r of img.regions) {
      rows.push([
        img.imageFile, r.regionId, r.skipped, r.skipReason ?? "",
        r.columnCountMatch, r.columnCountDiff,
        r.columnIouMean.toFixed(4), r.columnIouMin.toFixed(4),
        r.fontSizeRatio.toFixed(4), r.fontSizeError.toFixed(4),
        r.columnDxNormMean.toFixed(4), r.columnDxNormMax.toFixed(4),
        r.dTopNormMean.toFixed(4), r.dBottomNormMean.toFixed(4),
        r.heightRatioMean.toFixed(4),
        r.charDyNormMean.toFixed(4), r.charDyNormMax.toFixed(4),
        r.charDyNormP95.toFixed(4),
        r.compositeScore.toFixed(4),
      ].join(","));
    }
  }
  return rows.join("\n") + "\n";
}

function formatSummaryMd(summary: BenchmarkSummary): string {
  const lines: string[] = [
    `# Typeset Benchmark Report`,
    ``,
    `Generated: ${summary.generatedAt}`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Images | ${summary.imageCount} |`,
    `| Regions (total) | ${summary.totalRegionCount} |`,
    `| Regions (skipped) | ${summary.skippedRegionCount} |`,
    `| Composite Score (avg) | ${summary.avgCompositeScore.toFixed(4)} |`,
    `| Column IoU (avg) | ${summary.avgColumnIouMean.toFixed(4)} |`,
    `| Font Size Error (avg) | ${summary.avgFontSizeError.toFixed(4)} |`,
    `| Column Dx Norm (avg) | ${summary.avgColumnDxNorm.toFixed(4)} |`,
    `| Char Dy Norm (avg) | ${summary.avgCharDyNorm.toFixed(4)} |`,
    `| Column Count Match Rate | ${(summary.columnCountMatchRate * 100).toFixed(1)}% |`,
    ``,
    `## Worst Regions`,
    ``,
  ];

  const allRegions: (RegionMetrics & { imageFile: string })[] = [];
  for (const img of summary.images) {
    for (const r of img.regions) {
      if (!r.skipped) {
        allRegions.push({ ...r, imageFile: img.imageFile });
      }
    }
  }
  allRegions.sort((a, b) => a.compositeScore - b.compositeScore);
  const worst = allRegions.slice(0, 10);
  if (worst.length > 0) {
    lines.push(`| Image | Region | Score | IoU | FontErr | DxNorm |`);
    lines.push(`|-------|--------|-------|-----|---------|--------|`);
    for (const r of worst) {
      lines.push(
        `| ${r.imageFile} | ${r.regionId} | ${r.compositeScore.toFixed(3)} | ${r.columnIouMean.toFixed(3)} | ${r.fontSizeError.toFixed(3)} | ${r.columnDxNormMean.toFixed(3)} |`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

async function renderVisualization(
  fixturesDir: string,
  imagesDir: string,
  fontFamily: string,
  measureCtx: CanvasRenderingContext2D,
): Promise<{ name: string; buffer: Buffer }[]> {
  const fixtureFiles = readdirSync(fixturesDir).filter((f) => f.endsWith(".fixture.json"));
  const results: { name: string; buffer: Buffer }[] = [];

  for (const ff of fixtureFiles) {
    const fixture: Fixture = JSON.parse(readFileSync(join(fixturesDir, ff), "utf-8"));
    let imgPath = join(imagesDir, basename(fixture.image.file));
    if (!existsSync(imgPath)) {
      const candidates = readdirSync(imagesDir).filter((f) => /\.(png|jpe?g)$/i.test(f));
      const match = candidates.find((c) =>
        createHash("sha256").update(readFileSync(join(imagesDir, c))).digest("hex") === fixture.image.sha256,
      );
      if (match) imgPath = join(imagesDir, match);
      else continue;
    }

    const img = await loadImage(imgPath);
    const vizCanvas = createCanvas(img.width, img.height);
    const ctx = vizCanvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    for (const region of fixture.regions) {
      if (region.direction !== "v") continue;
      const gt: GroundTruthColumn[] = region.groundTruth.columns;
      const box = region.box;

      ctx.strokeStyle = "rgba(255, 255, 0, 0.6)";
      ctx.lineWidth = 3;
      ctx.strokeRect(box.x, box.y, box.width, box.height);

      const textRegion: TextRegion = {
        id: region.id,
        box: region.box,
        quad: region.quad,
        direction: region.direction,
        fontSize: region.fontSize,
        fgColor: region.fgColor,
        bgColor: region.bgColor,
        originalLineCount: region.originalLineCount,
        sourceText: region.sourceText,
        translatedText: region.sourceText,
        translatedColumns: region.translatedColumns,
      };

      const vResult = computeFullVerticalTypeset({
        region: textRegion,
        fontFamily,
        measureCtx,
      });

      const ox = vResult.expandedRegion.box.x + vResult.boxPadding - vResult.strokePadding;
      const oy = vResult.expandedRegion.box.y + vResult.boxPadding - vResult.strokePadding;

      for (const col of gt) {
        const left = col.centerX - col.width / 2;
        ctx.strokeStyle = "rgba(0, 255, 0, 0.8)";
        ctx.lineWidth = 3;
        ctx.strokeRect(left, col.topY, col.width, col.height);
        for (const cc of col.charCenters) {
          ctx.fillStyle = "rgba(0, 255, 0, 0.6)";
          ctx.beginPath();
          ctx.arc(col.centerX, cc.y, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      for (let i = 0; i < vResult.columns.length; i++) {
        const col = vResult.columns[i];
        const dbox = vResult.debugColumnBoxes[i];
        if (!dbox) continue;

        const px = dbox.x + ox;
        const py = dbox.y + oy;
        ctx.strokeStyle = "rgba(255, 50, 50, 0.8)";
        ctx.lineWidth = 3;
        ctx.setLineDash([8, 6]);
        ctx.strokeRect(px, py, dbox.width, dbox.height);
        ctx.setLineDash([]);

        let penY = dbox.y + oy;
        for (const glyph of col.glyphs) {
          ctx.fillStyle = "rgba(255, 50, 50, 0.6)";
          ctx.beginPath();
          ctx.arc(px + dbox.width / 2, penY + glyph.advanceY / 2, 5, 0, Math.PI * 2);
          ctx.fill();
          penY += glyph.advanceY;
        }
      }

      ctx.font = "bold 28px sans-serif";
      ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
      ctx.fillRect(box.x, box.y - 34, 240, 34);
      ctx.fillStyle = "#fff";
      ctx.fillText(`GT:${gt.length} Pred:${vResult.columns.length}`, box.x + 4, box.y - 8);
    }

    const stem = basename(imgPath).replace(/\.[^.]+$/, "");
    results.push({ name: `visualize-${stem}.png`, buffer: vizCanvas.toBuffer("image/png") });
  }

  return results;
}

async function main(): Promise<void> {
  registerFonts();
  const config = loadConfig();
  const fixturesDir = join(ROOT, config.fixturesDir);
  const imagesDir = join(ROOT, config.imagesDir);

  const fixtureFiles = readdirSync(fixturesDir).filter((f) =>
    f.endsWith(".fixture.json"),
  );
  if (fixtureFiles.length === 0) {
    console.error("No fixtures found. Run npm run bench:bake first.");
    process.exit(1);
  }

  const canvas = createCanvas(1, 1);
  const ctx = canvas.getContext("2d");
  const fontFamily = '"MTX-SourceHanSans-CN", "Noto Sans CJK SC", sans-serif';

  const imageMetrics: ImageMetrics[] = [];

  for (const file of fixtureFiles) {
    const fixture: Fixture = JSON.parse(
      readFileSync(join(fixturesDir, file), "utf-8"),
    );

    const imagePath = join(imagesDir, basename(fixture.image.file));
    if (existsSync(imagePath)) {
      const actual = sha256File(imagePath);
      if (actual !== fixture.image.sha256) {
        console.warn(
          `WARNING: sha256 mismatch for ${fixture.image.file}. Re-bake fixtures.`,
        );
      }
    }

    const regionResults: RegionMetrics[] = [];
    for (const region of fixture.regions) {
      if (region.direction !== "v") {
        regionResults.push({
          regionId: region.id,
          skipped: true,
          skipReason: "horizontal",
          columnCountMatch: 0, columnCountDiff: 0,
          columnIouMean: 0, columnIouMin: 0,
          fontSizeRatio: 0, fontSizeError: 0,
          columnDxNormMean: 0, columnDxNormMax: 0,
          dTopNormMean: 0, dBottomNormMean: 0, heightRatioMean: 0,
          charDyNormMean: 0, charDyNormMax: 0, charDyNormP95: 0,
          compositeScore: 0,
        });
        continue;
      }

      const textRegion: TextRegion = {
        id: region.id,
        box: region.box,
        quad: region.quad,
        direction: region.direction,
        fontSize: region.fontSize,
        fgColor: region.fgColor,
        bgColor: region.bgColor,
        originalLineCount: region.originalLineCount,
        sourceText: region.sourceText,
        translatedText: region.sourceText,
        translatedColumns: region.translatedColumns,
      };

      const vResult = computeFullVerticalTypeset({
        region: textRegion,
        fontFamily,
        measureCtx: ctx as unknown as CanvasRenderingContext2D,
      });

      const predColumns: GroundTruthColumn[] = vResult.columns.map((col, i) => {
        const box = vResult.debugColumnBoxes[i];
        const ox = vResult.expandedRegion.box.x + vResult.boxPadding - vResult.strokePadding;
        const oy = vResult.expandedRegion.box.y + vResult.boxPadding - vResult.strokePadding;
        const charCenters: { y: number }[] = [];
        let penY = box ? box.y + oy : 0;
        for (const glyph of col.glyphs) {
          charCenters.push({ y: penY + glyph.advanceY / 2 });
          penY += glyph.advanceY;
        }
        return {
          index: i,
          text: col.glyphs.map((g) => g.ch).join(""),
          charCount: col.glyphs.length,
          centerX: box ? box.x + box.width / 2 + ox : 0,
          topY: box ? box.y + oy : 0,
          bottomY: box ? box.y + box.height + oy : 0,
          width: box ? box.width : 0,
          height: box ? box.height : 0,
          estimatedFontSize: vResult.fittedFontSize,
          charCenters,
        };
      });
      const metrics = computeRegionMetrics(
        region.groundTruth.columns,
        predColumns,
        vResult.fittedFontSize,
        config.scoreWeights,
      );

      regionResults.push({
        regionId: region.id,
        skipped: false,
        ...metrics,
      });
    }

    const scored = regionResults.filter((r) => !r.skipped);
    imageMetrics.push({
      imageFile: fixture.image.file,
      regionCount: fixture.regions.length,
      skippedCount: regionResults.filter((r) => r.skipped).length,
      regions: regionResults,
      avgCompositeScore:
        scored.length > 0
          ? scored.reduce((a, b) => a + b.compositeScore, 0) / scored.length
          : 0,
    });
  }

  const allScored = imageMetrics.flatMap((im) =>
    im.regions.filter((r) => !r.skipped),
  );
  const summary: BenchmarkSummary = {
    generatedAt: new Date().toISOString(),
    imageCount: imageMetrics.length,
    totalRegionCount: imageMetrics.reduce((a, b) => a + b.regionCount, 0),
    skippedRegionCount: imageMetrics.reduce((a, b) => a + b.skippedCount, 0),
    avgCompositeScore:
      allScored.length > 0
        ? allScored.reduce((a, b) => a + b.compositeScore, 0) / allScored.length
        : 0,
    avgColumnIouMean:
      allScored.length > 0
        ? allScored.reduce((a, b) => a + b.columnIouMean, 0) / allScored.length
        : 0,
    avgFontSizeError:
      allScored.length > 0
        ? allScored.reduce((a, b) => a + b.fontSizeError, 0) / allScored.length
        : 0,
    avgColumnDxNorm:
      allScored.length > 0
        ? allScored.reduce((a, b) => a + b.columnDxNormMean, 0) / allScored.length
        : 0,
    avgCharDyNorm:
      allScored.length > 0
        ? allScored.reduce((a, b) => a + b.charDyNormMean, 0) / allScored.length
        : 0,
    columnCountMatchRate:
      allScored.length > 0
        ? allScored.filter((r) => r.columnCountMatch === 1).length / allScored.length
        : 0,
    images: imageMetrics,
  };

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = join(ROOT, config.reportsDir, ts);
  mkdirSync(reportDir, { recursive: true });

  writeFileSync(join(reportDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(reportDir, "summary.md"), formatSummaryMd(summary));
  writeFileSync(join(reportDir, "per-region.csv"), formatCsv(imageMetrics));

  const vizResults = await renderVisualization(
    fixturesDir, imagesDir, fontFamily, ctx as unknown as CanvasRenderingContext2D,
  );
  for (const { name, buffer } of vizResults) {
    writeFileSync(join(reportDir, name), buffer);
  }

  console.log(`Benchmark complete. Report: ${reportDir}`);
  console.log(`  Composite score: ${summary.avgCompositeScore.toFixed(4)}`);
  console.log(`  Column IoU: ${summary.avgColumnIouMean.toFixed(4)}`);
  console.log(`  Font size error: ${summary.avgFontSizeError.toFixed(4)}`);
  console.log(`  Column count match: ${(summary.columnCountMatchRate * 100).toFixed(1)}%`);
}

main();
