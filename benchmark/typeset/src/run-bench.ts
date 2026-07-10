import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { debugRegionToColumns } from "./debug-columns";
import { computeRegionMetrics } from "./metrics";
import { computeVerticalGlyphQuality } from "./glyph-quality";
import { assessFixtureSourceGeometry } from "./source-geometry";
import type {
  BenchConfig,
  BenchmarkSummary,
  Fixture,
  ImageMetrics,
  RegionMetrics,
} from "./types";
import type { PipelineTypesetDebugLog } from "../../../src/types";

const ROOT = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), "../../..");

function loadConfig(): BenchConfig {
  const raw = readFileSync(join(ROOT, "benchmark/typeset/bench.config.json"), "utf-8");
  return JSON.parse(raw) as BenchConfig;
}

function sha256File(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

function imageStem(imageFile: string): string {
  return basename(imageFile).replace(/\.[^.]+$/, "");
}

function findLatestRenderReportDir(reportsDir: string): string | null {
  if (!existsSync(reportsDir)) return null;
  const dirs = readdirSync(reportsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(reportsDir, d.name))
    .filter((dir) => readdirSync(dir).some((f) => f.endsWith("_render-debug.json")))
    .sort()
    .reverse();
  return dirs[0] ?? null;
}

function loadRenderDebug(reportDir: string, fixture: Fixture): PipelineTypesetDebugLog {
  const debugPath = join(reportDir, `${imageStem(fixture.image.file)}_render-debug.json`);
  if (!existsSync(debugPath)) {
    throw new Error(
      `Missing browser render debug for ${fixture.image.file}. Run npm run bench:render before npm run bench.`,
    );
  }
  const parsed = JSON.parse(readFileSync(debugPath, "utf-8")) as PipelineTypesetDebugLog | null;
  if (!parsed || !Array.isArray(parsed.regions)) {
    throw new Error(`Invalid browser render debug: ${debugPath}`);
  }
  return parsed;
}

function emptySkippedRegion(regionId: string, reason: string): RegionMetrics {
  return {
    regionId,
    skipped: true,
    skipReason: reason,
    sourceGeometryStatus: "skipped",
    columnCountMatch: 0,
    columnCountDiff: 0,
    columnIouMean: 0,
    columnIouMin: 0,
    fontSizeRatio: 0,
    fontSizeError: 0,
    signedColumnDxNormMean: 0,
    columnDxNormMean: 0,
    columnDxNormMax: 0,
    signedColumnGapNormMean: 0,
    columnPitchRatioMean: 1,
    dTopNormMean: 0,
    dBottomNormMean: 0,
    heightRatioMean: 0,
    signedCharDyNormMean: 0,
    charDyNormMean: 0,
    charDyNormMax: 0,
    charDyNormP95: 0,
    signedCharAdvanceNormMean: 0,
    charAdvanceRatioMean: 1,
    compositeScore: 0,
  };
}

function meanMetric(regions: RegionMetrics[], getter: (region: RegionMetrics) => number): number {
  return regions.length > 0
    ? regions.reduce((sum, region) => sum + getter(region), 0) / regions.length
    : 0;
}

function formatCsv(images: ImageMetrics[]): string {
  const header = [
    "image", "regionId", "skipped", "skipReason", "sourceGeometryStatus",
    "columnCountMatch", "columnCountDiff",
    "columnIouMean", "columnIouMin",
    "fontSizeRatio", "fontSizeError",
    "signedColumnDxNormMean", "columnDxNormMean", "columnDxNormMax",
    "signedColumnGapNormMean", "columnPitchRatioMean",
    "dTopNormMean", "dBottomNormMean", "heightRatioMean",
    "signedCharDyNormMean", "charDyNormMean", "charDyNormMax", "charDyNormP95",
    "signedCharAdvanceNormMean", "charAdvanceRatioMean",
    "compositeScore", "glyphQualityCoverage", "glyphOrientationAccuracy",
    "runContinuityRate", "verticalItemCenterAlignment", "glyphQualityScore",
  ].join(",");
  const rows: string[] = [header];
  for (const img of images) {
    for (const r of img.regions) {
      rows.push([
        img.imageFile, r.regionId, r.skipped, r.skipReason ?? "",
        r.sourceGeometryStatus ?? "",
        r.columnCountMatch, r.columnCountDiff,
        r.columnIouMean.toFixed(4), r.columnIouMin.toFixed(4),
        r.fontSizeRatio.toFixed(4), r.fontSizeError.toFixed(4),
        r.signedColumnDxNormMean.toFixed(4),
        r.columnDxNormMean.toFixed(4), r.columnDxNormMax.toFixed(4),
        r.signedColumnGapNormMean.toFixed(4), r.columnPitchRatioMean.toFixed(4),
        r.dTopNormMean.toFixed(4), r.dBottomNormMean.toFixed(4),
        r.heightRatioMean.toFixed(4),
        r.signedCharDyNormMean.toFixed(4),
        r.charDyNormMean.toFixed(4), r.charDyNormMax.toFixed(4),
        r.charDyNormP95.toFixed(4),
        r.signedCharAdvanceNormMean.toFixed(4), r.charAdvanceRatioMean.toFixed(4),
        r.compositeScore.toFixed(4),
        (r.glyphQualityCoverage ?? 0).toFixed(4),
        (r.glyphOrientationAccuracy ?? 0).toFixed(4),
        (r.runContinuityRate ?? 0).toFixed(4),
        (r.verticalItemCenterAlignment ?? 0).toFixed(4),
        (r.glyphQualityScore ?? 0).toFixed(4),
      ].join(","));
    }
  }
  return rows.join("\n") + "\n";
}

function formatSummaryMd(summary: BenchmarkSummary, reportDir: string): string {
  const lines: string[] = [
    `# Typeset Benchmark Report`,
    ``,
    `Generated: ${summary.generatedAt}`,
    `Metric source: browser render debug (${reportDir})`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Images | ${summary.imageCount} |`,
    `| Regions (total) | ${summary.totalRegionCount} |`,
    `| Regions (skipped) | ${summary.skippedRegionCount} |`,
    `| Composite Score (avg) | ${summary.avgCompositeScore.toFixed(4)} |`,
    `| Glyph Quality Score (avg) | ${summary.avgGlyphQualityScore.toFixed(4)} |`,
    `| Glyph Quality Coverage (avg) | ${summary.avgGlyphQualityCoverage.toFixed(4)} |`,
    `| Glyph Orientation Accuracy (avg) | ${summary.avgGlyphOrientationAccuracy.toFixed(4)} |`,
    `| Run Continuity Rate (avg) | ${summary.avgRunContinuityRate.toFixed(4)} |`,
    `| Vertical Item Center Alignment (avg) | ${summary.avgVerticalItemCenterAlignment.toFixed(4)} |`,
    `| Column IoU (avg) | ${summary.avgColumnIouMean.toFixed(4)} |`,
    `| Font Size Error (avg) | ${summary.avgFontSizeError.toFixed(4)} |`,
    `| Signed Column Dx Norm (avg) | ${summary.avgSignedColumnDxNorm.toFixed(4)} |`,
    `| Column Dx Norm (avg) | ${summary.avgColumnDxNorm.toFixed(4)} |`,
    `| Signed Column Gap Norm (avg) | ${summary.avgSignedColumnGapNorm.toFixed(4)} |`,
    `| Column Pitch Ratio (avg) | ${summary.avgColumnPitchRatio.toFixed(4)} |`,
    `| Signed Char Dy Norm (avg) | ${summary.avgSignedCharDyNorm.toFixed(4)} |`,
    `| Char Dy Norm (avg) | ${summary.avgCharDyNorm.toFixed(4)} |`,
    `| Signed Char Advance Norm (avg) | ${summary.avgSignedCharAdvanceNorm.toFixed(4)} |`,
    `| Char Advance Ratio (avg) | ${summary.avgCharAdvanceRatio.toFixed(4)} |`,
    `| Column Count Match Rate | ${(summary.columnCountMatchRate * 100).toFixed(1)}% |`,
    `| Source Geometry Usable Regions | ${summary.sourceGeometryUsableRegionCount} |`,
    `| Source Geometry Rejected Regions | ${summary.sourceGeometryRejectedRegionCount} |`,
    `| Source Geometry Spatial Order Mismatches | ${summary.sourceGeometrySpatialOrderMismatchCount} |`,
    ``,
    `## Source Geometry Diagnostics`,
    ``,
  ];

  const rejectedReasons = Object.entries(summary.sourceGeometryRejectedReasons)
    .sort((a, b) => b[1] - a[1]);
  if (rejectedReasons.length > 0) {
    lines.push(`| Reason | Regions |`);
    lines.push(`|--------|---------|`);
    for (const [reason, count] of rejectedReasons) {
      lines.push(`| ${reason} | ${count} |`);
    }
  } else {
    lines.push(`No rejected vertical source geometry.`);
  }

  lines.push(
    ``,
    `## Worst Regions`,
    ``,
  );

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
    lines.push(`| Image | Region | Score | IoU | FontErr | DxNorm | GapSigned | PitchRatio | CharAdvSigned |`);
    lines.push(`|-------|--------|-------|-----|---------|--------|-----------|------------|---------------|`);
    for (const r of worst) {
      lines.push(
        `| ${r.imageFile} | ${r.regionId} | ${r.compositeScore.toFixed(3)} | ${r.columnIouMean.toFixed(3)} | ${r.fontSizeError.toFixed(3)} | ${r.columnDxNormMean.toFixed(3)} | ${r.signedColumnGapNormMean.toFixed(3)} | ${r.columnPitchRatioMean.toFixed(3)} | ${r.signedCharAdvanceNormMean.toFixed(3)} |`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const config = loadConfig();
  const fixturesDir = join(ROOT, config.fixturesDir);
  const imagesDir = join(ROOT, config.imagesDir);
  const reportsDir = join(ROOT, config.reportsDir);

  const fixtureFiles = readdirSync(fixturesDir)
    .filter((f) => f.endsWith(".fixture.json"))
    .sort();
  if (fixtureFiles.length === 0) {
    console.error("No fixtures found. Run npm run bench:bake first.");
    process.exit(1);
  }

  const reportDir = findLatestRenderReportDir(reportsDir);
  if (!reportDir) {
    console.error("No render debug report found. Run npm run bench:render first.");
    process.exit(1);
  }

  const imageMetrics: ImageMetrics[] = [];
  let sourceGeometryUsableRegionCount = 0;
  let sourceGeometryRejectedRegionCount = 0;
  let sourceGeometrySpatialOrderMismatchCount = 0;
  const sourceGeometryRejectedReasons = new Map<string, number>();

  for (const file of fixtureFiles) {
    const fixture = JSON.parse(readFileSync(join(fixturesDir, file), "utf-8")) as Fixture;
    const imagePath = join(imagesDir, basename(fixture.image.file));
    if (existsSync(imagePath)) {
      const actual = sha256File(imagePath);
      if (actual !== fixture.image.sha256) {
        console.warn(`WARNING: sha256 mismatch for ${fixture.image.file}. Re-bake fixtures.`);
      }
    }

    const renderDebug = loadRenderDebug(reportDir, fixture);
    const debugByRegionId = new Map(renderDebug.regions.map((region) => [region.regionId, region]));

    const regionResults: RegionMetrics[] = [];
    for (const region of fixture.regions) {
      if (region.direction !== "v") {
        regionResults.push(emptySkippedRegion(region.id, "horizontal"));
        continue;
      }

      const sourceGeometry = assessFixtureSourceGeometry(region);
      if (sourceGeometry.usable) {
        sourceGeometryUsableRegionCount += 1;
        if (sourceGeometry.status === "spatial_order_mismatch") {
          sourceGeometrySpatialOrderMismatchCount += 1;
        }
      } else {
        sourceGeometryRejectedRegionCount += 1;
        sourceGeometryRejectedReasons.set(
          sourceGeometry.status,
          (sourceGeometryRejectedReasons.get(sourceGeometry.status) ?? 0) + 1,
        );
      }

      const debugRegion = debugByRegionId.get(region.id);
      if (!debugRegion) {
        throw new Error(
          `Render debug for ${fixture.image.file} is missing fixture region ${region.id}. Re-run npm run bench:render.`,
        );
      }

      const metrics = computeRegionMetrics(
        region.groundTruth.columns,
        debugRegionToColumns(debugRegion),
        debugRegion.fittedFontSize,
        config.scoreWeights,
      );
      const glyphQuality = computeVerticalGlyphQuality(debugRegion);

      regionResults.push({
        regionId: region.id,
        skipped: false,
        sourceGeometryStatus: sourceGeometry.status,
        ...metrics,
        ...glyphQuality,
      });
    }

    const scored = regionResults.filter((r) => !r.skipped);
    imageMetrics.push({
      imageFile: fixture.image.file,
      regionCount: fixture.regions.length,
      skippedCount: regionResults.filter((r) => r.skipped).length,
      regions: regionResults,
      avgCompositeScore: meanMetric(scored, (r) => r.compositeScore),
      avgGlyphQualityCoverage: meanMetric(scored, (r) => r.glyphQualityCoverage ?? 0),
      avgGlyphOrientationAccuracy: meanMetric(scored, (r) => r.glyphOrientationAccuracy ?? 0),
      avgRunContinuityRate: meanMetric(scored, (r) => r.runContinuityRate ?? 0),
      avgVerticalItemCenterAlignment: meanMetric(scored, (r) => r.verticalItemCenterAlignment ?? 0),
      avgGlyphQualityScore: meanMetric(scored, (r) => r.glyphQualityScore ?? 0),
    });
  }

  const allScored = imageMetrics.flatMap((im) =>
    im.regions.filter((r) => !r.skipped),
  );
  const summary: BenchmarkSummary = {
    generatedAt: new Date().toISOString(),
    imageCount: imageMetrics.length,
    totalRegionCount: imageMetrics.reduce((sum, image) => sum + image.regionCount, 0),
    skippedRegionCount: imageMetrics.reduce((sum, image) => sum + image.skippedCount, 0),
    avgCompositeScore: meanMetric(allScored, (r) => r.compositeScore),
    avgGlyphQualityCoverage: meanMetric(allScored, (r) => r.glyphQualityCoverage ?? 0),
    avgGlyphOrientationAccuracy: meanMetric(allScored, (r) => r.glyphOrientationAccuracy ?? 0),
    avgRunContinuityRate: meanMetric(allScored, (r) => r.runContinuityRate ?? 0),
    avgVerticalItemCenterAlignment: meanMetric(allScored, (r) => r.verticalItemCenterAlignment ?? 0),
    avgGlyphQualityScore: meanMetric(allScored, (r) => r.glyphQualityScore ?? 0),
    avgColumnIouMean: meanMetric(allScored, (r) => r.columnIouMean),
    avgFontSizeError: meanMetric(allScored, (r) => r.fontSizeError),
    avgSignedColumnDxNorm: meanMetric(allScored, (r) => r.signedColumnDxNormMean),
    avgColumnDxNorm: meanMetric(allScored, (r) => r.columnDxNormMean),
    avgSignedColumnGapNorm: meanMetric(allScored, (r) => r.signedColumnGapNormMean),
    avgColumnPitchRatio: meanMetric(allScored, (r) => r.columnPitchRatioMean),
    avgSignedCharDyNorm: meanMetric(allScored, (r) => r.signedCharDyNormMean),
    avgCharDyNorm: meanMetric(allScored, (r) => r.charDyNormMean),
    avgSignedCharAdvanceNorm: meanMetric(allScored, (r) => r.signedCharAdvanceNormMean),
    avgCharAdvanceRatio: meanMetric(allScored, (r) => r.charAdvanceRatioMean),
    columnCountMatchRate:
      allScored.length > 0
        ? allScored.filter((r) => r.columnCountMatch === 1).length / allScored.length
        : 0,
    sourceGeometryUsableRegionCount,
    sourceGeometryRejectedRegionCount,
    sourceGeometrySpatialOrderMismatchCount,
    sourceGeometryRejectedReasons: Object.fromEntries(
      [...sourceGeometryRejectedReasons.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    ),
    images: imageMetrics,
  };

  writeFileSync(join(reportDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(reportDir, "summary.md"), formatSummaryMd(summary, reportDir));
  writeFileSync(join(reportDir, "per-region.csv"), formatCsv(imageMetrics));

  console.log(`Benchmark complete. Report: ${reportDir}`);
  console.log("  Metric source: browser render debug");
  console.log(`  Composite score: ${summary.avgCompositeScore.toFixed(4)}`);
  console.log(`  Glyph quality score: ${summary.avgGlyphQualityScore.toFixed(4)}`);
  console.log(`  Glyph orientation accuracy: ${summary.avgGlyphOrientationAccuracy.toFixed(4)}`);
  console.log(`  Run continuity rate: ${summary.avgRunContinuityRate.toFixed(4)}`);
  console.log(`  Column IoU: ${summary.avgColumnIouMean.toFixed(4)}`);
  console.log(`  Font size error: ${summary.avgFontSizeError.toFixed(4)}`);
  console.log(`  Signed column gap norm: ${summary.avgSignedColumnGapNorm.toFixed(4)}`);
  console.log(`  Signed char advance norm: ${summary.avgSignedCharAdvanceNorm.toFixed(4)}`);
  console.log(`  Column count match: ${(summary.columnCountMatchRate * 100).toFixed(1)}%`);
  console.log(`  Source geometry usable/rejected: ${sourceGeometryUsableRegionCount}/${sourceGeometryRejectedRegionCount}`);
  console.log(`  Source geometry spatial order mismatches: ${sourceGeometrySpatialOrderMismatchCount}`);
}

main();
