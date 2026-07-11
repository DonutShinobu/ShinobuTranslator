import { createHash } from "crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { debugRegionToColumns } from "./debug-columns";
import { computeHorizontalRegionMetrics } from "./horizontal-metrics";
import {
  summarizeHorizontalMetrics,
  type ReportedHorizontalGlyphDiagnostic,
} from "./horizontal-summary";
import { computeRegionMetrics } from "./metrics";
import { computeVerticalGlyphQuality } from "./glyph-quality";
import { assessFixtureSourceGeometry } from "./source-geometry";
import { parseTypesetSuiteArgs } from "./suite-paths";
import type {
  BenchConfig,
  BenchmarkSummary,
  Fixture,
  HorizontalRegionMetrics,
  ImageMetrics,
  RegionMetrics,
  TypesetDirection,
  VerticalRegionMetrics,
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

function emptySkippedRegion(
  regionId: string,
  direction: TypesetDirection,
  reason: string,
  sourceGeometryStatus = "skipped",
): RegionMetrics {
  return {
    regionId,
    direction,
    skipped: true,
    skipReason: reason,
    sourceGeometryStatus,
  };
}

function meanMetric<T>(regions: T[], getter: (region: T) => number): number {
  return regions.length > 0
    ? regions.reduce((sum, region) => sum + getter(region), 0) / regions.length
    : 0;
}

function isVerticalRegion(region: RegionMetrics): region is VerticalRegionMetrics {
  return !region.skipped && region.direction === "v";
}

function isHorizontalRegion(region: RegionMetrics): region is HorizontalRegionMetrics {
  return !region.skipped && region.direction === "h";
}

function csvEscape(value: string | number | boolean | undefined): string {
  if (value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function fixed(value: number | undefined): string {
  return value === undefined ? "" : value.toFixed(4);
}

function formatCsv(images: ImageMetrics[]): string {
  const header = [
    "image", "regionId", "direction", "skipped", "skipReason", "sourceGeometryStatus",
    "fontSizeRatio", "fontSizeError", "compositeScore",
    "columnCountMatch", "columnCountDiff",
    "columnIouMean", "columnIouMin",
    "signedColumnDxNormMean", "columnDxNormMean", "columnDxNormMax",
    "signedColumnGapNormMean", "columnPitchRatioMean",
    "dTopNormMean", "dBottomNormMean", "heightRatioMean",
    "signedCharDyNormMean", "charDyNormMean", "charDyNormMax", "charDyNormP95",
    "signedCharAdvanceNormMean", "charAdvanceRatioMean",
    "glyphQualityCoverage", "glyphOrientationAccuracy",
    "runContinuityRate", "verticalItemCenterAlignment", "glyphQualityScore",
    "lineCountMatch", "lineCountDiff", "lineQuadIouMean", "lineQuadIouMin",
    "blockHullIou", "sourceQuadCoverage",
    "signedLineCenterDxNormMean", "signedLineCenterDyNormMean",
    "lineCenterDistanceNormMean", "lineCenterDistanceNormP95", "lineCenterDistanceNormMax",
    "lineWidthRatioMean", "lineWidthErrorMean", "lineHeightRatioMean", "lineHeightErrorMean",
    "signedLineGapNormMean", "linePitchRatioMean", "linePitchErrorMean",
    "lineAngleErrorDegMean", "lineAngleErrorDegMax",
    "lineBreakPrecision", "lineBreakRecall", "lineBreakF1",
    "gtGlyphCount", "predGlyphCount", "matchedGlyphCount", "positionedGlyphCount",
    "glyphTextMatchCoverage", "glyphPositionCoverage",
    "signedCharDxNormMean", "horizontalSignedCharDyNormMean",
    "charDxNormMean", "horizontalCharDyNormMean",
    "charDistanceNormMean", "charDistanceNormMedian", "charDistanceNormP95", "charDistanceNormMax",
    "charDistanceOverHalfEmRate", "charDistanceOverOneEmRate",
    "horizontalSignedCharAdvanceNormMean", "horizontalCharAdvanceRatioMean",
    "charAdvanceErrorMean", "charCenterQuality",
  ].join(",");
  const rows: string[] = [header];
  for (const img of images) {
    for (const r of img.regions) {
      const vertical = isVerticalRegion(r) ? r : undefined;
      const horizontal = isHorizontalRegion(r) ? r : undefined;
      const scored = vertical ?? horizontal;
      rows.push([
        img.imageFile, r.regionId, r.direction, r.skipped, r.skipReason ?? "",
        r.sourceGeometryStatus ?? "",
        fixed(scored?.fontSizeRatio), fixed(scored?.fontSizeError), fixed(scored?.compositeScore),
        vertical?.columnCountMatch, vertical?.columnCountDiff,
        fixed(vertical?.columnIouMean), fixed(vertical?.columnIouMin),
        fixed(vertical?.signedColumnDxNormMean), fixed(vertical?.columnDxNormMean), fixed(vertical?.columnDxNormMax),
        fixed(vertical?.signedColumnGapNormMean), fixed(vertical?.columnPitchRatioMean),
        fixed(vertical?.dTopNormMean), fixed(vertical?.dBottomNormMean), fixed(vertical?.heightRatioMean),
        fixed(vertical?.signedCharDyNormMean), fixed(vertical?.charDyNormMean),
        fixed(vertical?.charDyNormMax), fixed(vertical?.charDyNormP95),
        fixed(vertical?.signedCharAdvanceNormMean), fixed(vertical?.charAdvanceRatioMean),
        fixed(vertical?.glyphQualityCoverage), fixed(vertical?.glyphOrientationAccuracy),
        fixed(vertical?.runContinuityRate), fixed(vertical?.verticalItemCenterAlignment),
        fixed(vertical?.glyphQualityScore),
        horizontal?.lineCountMatch, horizontal?.lineCountDiff,
        fixed(horizontal?.lineQuadIouMean), fixed(horizontal?.lineQuadIouMin),
        fixed(horizontal?.blockHullIou), fixed(horizontal?.sourceQuadCoverage),
        fixed(horizontal?.signedLineCenterDxNormMean), fixed(horizontal?.signedLineCenterDyNormMean),
        fixed(horizontal?.lineCenterDistanceNormMean), fixed(horizontal?.lineCenterDistanceNormP95),
        fixed(horizontal?.lineCenterDistanceNormMax), fixed(horizontal?.lineWidthRatioMean),
        fixed(horizontal?.lineWidthErrorMean), fixed(horizontal?.lineHeightRatioMean),
        fixed(horizontal?.lineHeightErrorMean), fixed(horizontal?.signedLineGapNormMean),
        fixed(horizontal?.linePitchRatioMean), fixed(horizontal?.linePitchErrorMean),
        fixed(horizontal?.lineAngleErrorDegMean), fixed(horizontal?.lineAngleErrorDegMax),
        fixed(horizontal?.lineBreakPrecision), fixed(horizontal?.lineBreakRecall), fixed(horizontal?.lineBreakF1),
        horizontal?.gtGlyphCount, horizontal?.predGlyphCount, horizontal?.matchedGlyphCount,
        horizontal?.positionedGlyphCount, fixed(horizontal?.glyphTextMatchCoverage),
        fixed(horizontal?.glyphPositionCoverage), fixed(horizontal?.signedCharDxNormMean),
        fixed(horizontal?.signedCharDyNormMean), fixed(horizontal?.charDxNormMean),
        fixed(horizontal?.charDyNormMean), fixed(horizontal?.charDistanceNormMean),
        fixed(horizontal?.charDistanceNormMedian), fixed(horizontal?.charDistanceNormP95),
        fixed(horizontal?.charDistanceNormMax), fixed(horizontal?.charDistanceOverHalfEmRate),
        fixed(horizontal?.charDistanceOverOneEmRate), fixed(horizontal?.signedCharAdvanceNormMean),
        fixed(horizontal?.charAdvanceRatioMean), fixed(horizontal?.charAdvanceErrorMean),
        fixed(horizontal?.charCenterQuality),
      ].map(csvEscape).join(","));
    }
  }
  return rows.join("\n") + "\n";
}

function formatHorizontalGlyphCsv(rows: ReportedHorizontalGlyphDiagnostic[]): string {
  const header = [
    "image", "regionId", "matchStatus", "ch",
    "gtLineIndex", "gtCharIndex", "gtSequenceIndex",
    "predLineIndex", "predCharIndex", "predSequenceIndex",
    "gtX", "gtY", "predX", "predY", "dxNorm", "dyNorm", "distanceNorm",
  ];
  const output = [header.join(",")];
  for (const row of rows) {
    output.push([
      row.imageFile, row.regionId, row.matchStatus, row.ch,
      row.gtLineIndex, row.gtCharIndex, row.gtSequenceIndex,
      row.predLineIndex, row.predCharIndex, row.predSequenceIndex,
      row.gtX, row.gtY, row.predX, row.predY,
      row.dxNorm, row.dyNorm, row.distanceNorm,
    ].map(csvEscape).join(","));
  }
  return output.join("\n") + "\n";
}

function formatSummaryMd(summary: BenchmarkSummary, reportDir: string): string {
  const horizontal = summary.horizontal;
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
    `| Vertical regions (scored) | ${summary.images.reduce((sum, image) => sum + image.verticalScoredCount, 0)} |`,
    `| Horizontal regions (scored) | ${horizontal.scoredRegionCount} |`,
    ``,
    `## Vertical Metrics`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
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
    ``,
    `## Horizontal Metrics`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Regions (scored / skipped) | ${horizontal.scoredRegionCount} / ${horizontal.skippedRegionCount} |`,
    `| Composite Score (avg) | ${horizontal.avgCompositeScore.toFixed(4)} |`,
    `| Line Quad IoU (avg) | ${horizontal.avgLineQuadIouMean.toFixed(4)} |`,
    `| Block Hull IoU (avg) | ${horizontal.avgBlockHullIou.toFixed(4)} |`,
    `| Source Quad Coverage | ${(horizontal.avgSourceQuadCoverage * 100).toFixed(1)}% |`,
    `| Font Size Error (avg) | ${horizontal.avgFontSizeError.toFixed(4)} |`,
    `| Line Center Distance Norm (avg) | ${horizontal.avgLineCenterDistanceNorm.toFixed(4)} |`,
    `| Line Width / Height Error (avg) | ${horizontal.avgLineWidthError.toFixed(4)} / ${horizontal.avgLineHeightError.toFixed(4)} |`,
    `| Line Pitch Error (avg) | ${horizontal.avgLinePitchError.toFixed(4)} |`,
    `| Line Angle Error (avg deg) | ${horizontal.avgLineAngleErrorDeg.toFixed(3)} |`,
    `| Line Break F1 (avg) | ${horizontal.avgLineBreakF1.toFixed(4)} |`,
    `| Glyphs (GT / predicted / matched / positioned) | ${horizontal.gtGlyphCount} / ${horizontal.predGlyphCount} / ${horizontal.matchedGlyphCount} / ${horizontal.positionedGlyphCount} |`,
    `| Glyph Text / Position Coverage | ${(horizontal.glyphTextMatchCoverage * 100).toFixed(1)}% / ${(horizontal.glyphPositionCoverage * 100).toFixed(1)}% |`,
    `| Signed Char Dx / Dy Norm (avg) | ${horizontal.signedCharDxNormMean.toFixed(4)} / ${horizontal.signedCharDyNormMean.toFixed(4)} |`,
    `| Char Dx / Dy Norm (avg abs) | ${horizontal.charDxNormMean.toFixed(4)} / ${horizontal.charDyNormMean.toFixed(4)} |`,
    `| Char Distance Norm (mean / median / P95 / max) | ${horizontal.charDistanceNormMean.toFixed(4)} / ${horizontal.charDistanceNormMedian.toFixed(4)} / ${horizontal.charDistanceNormP95.toFixed(4)} / ${horizontal.charDistanceNormMax.toFixed(4)} |`,
    `| Char Distance > 0.5em / > 1em | ${(horizontal.charDistanceOverHalfEmRate * 100).toFixed(1)}% / ${(horizontal.charDistanceOverOneEmRate * 100).toFixed(1)}% |`,
    `| Char Advance Error (avg) | ${horizontal.avgCharAdvanceError.toFixed(4)} |`,
    `| Char Center Quality | ${horizontal.charCenterQuality.toFixed(4)} |`,
    ``,
    `## Source Geometry Diagnostics`,
    ``,
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Vertical usable regions | ${summary.sourceGeometryUsableRegionCount} |`,
    `| Vertical rejected regions | ${summary.sourceGeometryRejectedRegionCount} |`,
    `| Vertical spatial order mismatches | ${summary.sourceGeometrySpatialOrderMismatchCount} |`,
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
    `## Worst Vertical Regions`,
    ``,
  );

  const allRegions: (VerticalRegionMetrics & { imageFile: string })[] = [];
  for (const img of summary.images) {
    for (const r of img.regions) {
      if (isVerticalRegion(r)) {
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

  const horizontalRegions: (HorizontalRegionMetrics & { imageFile: string })[] = [];
  for (const image of summary.images) {
    for (const region of image.regions) {
      if (isHorizontalRegion(region)) horizontalRegions.push({ ...region, imageFile: image.imageFile });
    }
  }
  horizontalRegions.sort((a, b) => b.charDistanceNormP95 - a.charDistanceNormP95);
  const worstHorizontal = horizontalRegions.slice(0, 10);
  lines.push(``, `## Worst Horizontal Regions`, ``);
  if (worstHorizontal.length > 0) {
    lines.push(`| Image | Region | Score | CharMean | CharP95 | >0.5em | >1em | LineIoU | BreakF1 |`);
    lines.push(`|-------|--------|-------|----------|---------|--------|------|---------|---------|`);
    for (const region of worstHorizontal) {
      lines.push(
        `| ${region.imageFile} | ${region.regionId} | ${region.compositeScore.toFixed(3)} | ${region.charDistanceNormMean.toFixed(3)} | ${region.charDistanceNormP95.toFixed(3)} | ${(region.charDistanceOverHalfEmRate * 100).toFixed(1)}% | ${(region.charDistanceOverOneEmRate * 100).toFixed(1)}% | ${region.lineQuadIouMean.toFixed(3)} | ${region.lineBreakF1.toFixed(3)} |`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const config = loadConfig();
  const parsed = parseTypesetSuiteArgs(process.argv.slice(2));
  if (parsed.remainingArgs.length > 0) {
    console.error(`Unknown option: ${parsed.remainingArgs[0]}`);
    process.exit(1);
  }
  const { fixturesDir, imagesDir, reportsDir } = parsed.paths;

  if (!existsSync(fixturesDir)) {
    console.error(`Fixtures directory not found: ${fixturesDir}`);
    process.exit(1);
  }
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
  const horizontalGlyphDiagnostics: ReportedHorizontalGlyphDiagnostic[] = [];
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
      const sourceGeometry = assessFixtureSourceGeometry(region);
      if (region.direction === "v") {
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
      }

      const debugRegion = debugByRegionId.get(region.id);
      if (!debugRegion) {
        throw new Error(
          `Render debug for ${fixture.image.file} is missing fixture region ${region.id}. Re-run npm run bench:render.`,
        );
      }

      const predictedColumns = debugRegionToColumns(debugRegion);
      if (region.direction === "h") {
        const computation = computeHorizontalRegionMetrics(
          region.groundTruth.columns,
          predictedColumns,
          debugRegion.fittedFontSize,
          config.horizontalScoreWeights,
        );
        horizontalGlyphDiagnostics.push(...computation.glyphDiagnostics.map((diagnostic) => ({
          ...diagnostic,
          imageFile: fixture.image.file,
          regionId: region.id,
        })));
        if (!computation.metrics) {
          regionResults.push(emptySkippedRegion(
            region.id,
            "h",
            computation.skipReason ?? "horizontal_metrics_unavailable",
            sourceGeometry.status,
          ));
          continue;
        }
        regionResults.push({
          regionId: region.id,
          direction: "h",
          skipped: false,
          sourceGeometryStatus: sourceGeometry.status,
          ...computation.metrics,
        });
        continue;
      }

      const metrics = computeRegionMetrics(
        region.groundTruth.columns,
        predictedColumns,
        debugRegion.fittedFontSize,
        config.scoreWeights,
      );
      const glyphQuality = computeVerticalGlyphQuality(debugRegion);

      regionResults.push({
        regionId: region.id,
        direction: "v",
        skipped: false,
        sourceGeometryStatus: sourceGeometry.status,
        ...metrics,
        ...glyphQuality,
      });
    }

    const scoredVertical = regionResults.filter(isVerticalRegion);
    const scoredHorizontal = regionResults.filter(isHorizontalRegion);
    imageMetrics.push({
      imageFile: fixture.image.file,
      regionCount: fixture.regions.length,
      skippedCount: regionResults.filter((r) => r.skipped).length,
      regions: regionResults,
      verticalScoredCount: scoredVertical.length,
      horizontalScoredCount: scoredHorizontal.length,
      avgCompositeScore: meanMetric(scoredVertical, (r) => r.compositeScore),
      avgHorizontalCompositeScore: meanMetric(scoredHorizontal, (r) => r.compositeScore),
      avgGlyphQualityCoverage: meanMetric(scoredVertical, (r) => r.glyphQualityCoverage ?? 0),
      avgGlyphOrientationAccuracy: meanMetric(scoredVertical, (r) => r.glyphOrientationAccuracy ?? 0),
      avgRunContinuityRate: meanMetric(scoredVertical, (r) => r.runContinuityRate ?? 0),
      avgVerticalItemCenterAlignment: meanMetric(scoredVertical, (r) => r.verticalItemCenterAlignment ?? 0),
      avgGlyphQualityScore: meanMetric(scoredVertical, (r) => r.glyphQualityScore ?? 0),
    });
  }

  const allVertical = imageMetrics.flatMap((image) => image.regions.filter(isVerticalRegion));
  const allHorizontal = imageMetrics.flatMap((image) => image.regions.filter(isHorizontalRegion));
  const horizontalSkippedCount = imageMetrics.reduce(
    (sum, image) => sum + image.regions.filter((region) => (
      region.direction === "h" && region.skipped
    )).length,
    0,
  );
  const horizontalSummary = summarizeHorizontalMetrics(
    allHorizontal,
    horizontalSkippedCount,
    horizontalGlyphDiagnostics,
  );
  const summary: BenchmarkSummary = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    imageCount: imageMetrics.length,
    totalRegionCount: imageMetrics.reduce((sum, image) => sum + image.regionCount, 0),
    skippedRegionCount: imageMetrics.reduce((sum, image) => sum + image.skippedCount, 0),
    avgCompositeScore: meanMetric(allVertical, (r) => r.compositeScore),
    avgGlyphQualityCoverage: meanMetric(allVertical, (r) => r.glyphQualityCoverage ?? 0),
    avgGlyphOrientationAccuracy: meanMetric(allVertical, (r) => r.glyphOrientationAccuracy ?? 0),
    avgRunContinuityRate: meanMetric(allVertical, (r) => r.runContinuityRate ?? 0),
    avgVerticalItemCenterAlignment: meanMetric(allVertical, (r) => r.verticalItemCenterAlignment ?? 0),
    avgGlyphQualityScore: meanMetric(allVertical, (r) => r.glyphQualityScore ?? 0),
    avgColumnIouMean: meanMetric(allVertical, (r) => r.columnIouMean),
    avgFontSizeError: meanMetric(allVertical, (r) => r.fontSizeError),
    avgSignedColumnDxNorm: meanMetric(allVertical, (r) => r.signedColumnDxNormMean),
    avgColumnDxNorm: meanMetric(allVertical, (r) => r.columnDxNormMean),
    avgSignedColumnGapNorm: meanMetric(allVertical, (r) => r.signedColumnGapNormMean),
    avgColumnPitchRatio: meanMetric(allVertical, (r) => r.columnPitchRatioMean),
    avgSignedCharDyNorm: meanMetric(allVertical, (r) => r.signedCharDyNormMean),
    avgCharDyNorm: meanMetric(allVertical, (r) => r.charDyNormMean),
    avgSignedCharAdvanceNorm: meanMetric(allVertical, (r) => r.signedCharAdvanceNormMean),
    avgCharAdvanceRatio: meanMetric(allVertical, (r) => r.charAdvanceRatioMean),
    columnCountMatchRate:
      allVertical.length > 0
        ? allVertical.filter((r) => r.columnCountMatch === 1).length / allVertical.length
        : 0,
    sourceGeometryUsableRegionCount,
    sourceGeometryRejectedRegionCount,
    sourceGeometrySpatialOrderMismatchCount,
    sourceGeometryRejectedReasons: Object.fromEntries(
      [...sourceGeometryRejectedReasons.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    ),
    horizontal: horizontalSummary,
    images: imageMetrics,
  };

  writeFileSync(join(reportDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(reportDir, "summary.md"), formatSummaryMd(summary, reportDir));
  writeFileSync(join(reportDir, "per-region.csv"), formatCsv(imageMetrics));
  writeFileSync(
    join(reportDir, "horizontal-glyphs.csv"),
    formatHorizontalGlyphCsv(horizontalGlyphDiagnostics),
  );

  console.log(`Benchmark complete. Report: ${reportDir}`);
  console.log("  Metric source: browser render debug");
  console.log(`  Vertical composite score: ${summary.avgCompositeScore.toFixed(4)}`);
  console.log(`  Glyph quality score: ${summary.avgGlyphQualityScore.toFixed(4)}`);
  console.log(`  Glyph orientation accuracy: ${summary.avgGlyphOrientationAccuracy.toFixed(4)}`);
  console.log(`  Run continuity rate: ${summary.avgRunContinuityRate.toFixed(4)}`);
  console.log(`  Column IoU: ${summary.avgColumnIouMean.toFixed(4)}`);
  console.log(`  Font size error: ${summary.avgFontSizeError.toFixed(4)}`);
  console.log(`  Signed column gap norm: ${summary.avgSignedColumnGapNorm.toFixed(4)}`);
  console.log(`  Signed char advance norm: ${summary.avgSignedCharAdvanceNorm.toFixed(4)}`);
  console.log(`  Column count match: ${(summary.columnCountMatchRate * 100).toFixed(1)}%`);
  console.log(`  Horizontal regions scored/skipped: ${horizontalSummary.scoredRegionCount}/${horizontalSummary.skippedRegionCount}`);
  console.log(`  Horizontal composite score: ${horizontalSummary.avgCompositeScore.toFixed(4)}`);
  console.log(`  Horizontal char distance mean/P95: ${horizontalSummary.charDistanceNormMean.toFixed(4)}/${horizontalSummary.charDistanceNormP95.toFixed(4)}`);
  console.log(`  Horizontal char distance >0.5em/>1em: ${(horizontalSummary.charDistanceOverHalfEmRate * 100).toFixed(1)}%/${(horizontalSummary.charDistanceOverOneEmRate * 100).toFixed(1)}%`);
  console.log(`  Source geometry usable/rejected: ${sourceGeometryUsableRegionCount}/${sourceGeometryRejectedRegionCount}`);
  console.log(`  Source geometry spatial order mismatches: ${sourceGeometrySpatialOrderMismatchCount}`);
}

main();
