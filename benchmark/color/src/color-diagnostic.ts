// ---------------------------------------------------------------------------
// Color algorithm diagnostic script.
// Phase 1: Trace color extraction pipeline for each fixture region.
// Output JSON diagnostic report + summary table.
// ---------------------------------------------------------------------------

import { createCanvas, loadImage } from "canvas";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  colorDistance,
  createSyntheticOcrData,
  cropRegion,
  deltaE,
  extractColorsFromOutputsCurrent,
  FIXTURES_DIR,
  histogramBimodal,
  isGrayFailure,
  loadFixtures,
  REPORTS_DIR,
  resolveColors,
  sampleEdgeColors,
  sampleCornerBgColor,
} from "./color-utils";
import type {
  ColorFixtureRegion,
  ColorPath,
  DiagnosticReport,
  PathSummary,
  RegionDiagnosticTrace,
} from "./color-types";

/**
 * Run current color extraction pipeline on one region's crop.
 * Returns the trace information.
 */
function traceRegionColors(
  fixtureImage: string,
  regionIndex: number,
  region: ColorFixtureRegion,
  croppedData: Uint8ClampedArray,
  cropWidth: number,
  cropHeight: number,
  ocrResult: { fgColor: [number, number, number]; bgColor: [number, number, number]; cntFg: number; cntBg: number; totalSteps: number } | null,
): RegionDiagnosticTrace {
  let colorPath: ColorPath = "default";
  let hasFgRatio: number | null = null;
  let hasBgRatio: number | null = null;
  let rawFgRgb: [number, number, number] | null = null;
  let rawBgRgb: [number, number, number] | null = null;

  // Determine which color path is taken
  if (ocrResult) {
    // Check if OCR colors are unreliable (fg/bg too similar)
    if (colorDistance(ocrResult.fgColor, ocrResult.bgColor) < 30) {
      // Fall back to histogram bimodal when OCR colors are unreliable
      const histResult = histogramBimodal(croppedData, cropWidth, cropHeight);
      if (histResult) {
        colorPath = "pixel_sampling";
        rawFgRgb = histResult.fgColor;
        rawBgRgb = histResult.bgColor;
      } else {
        colorPath = "ocr_model";
        hasFgRatio = ocrResult.cntFg / ocrResult.totalSteps;
        hasBgRatio = ocrResult.cntBg / ocrResult.totalSteps;
        rawFgRgb = ocrResult.fgColor;
        rawBgRgb = ocrResult.bgColor;
      }
    } else {
      colorPath = "ocr_model";
      hasFgRatio = ocrResult.cntFg / ocrResult.totalSteps;
      hasBgRatio = ocrResult.cntBg / ocrResult.totalSteps;
      rawFgRgb = ocrResult.fgColor;
      rawBgRgb = ocrResult.bgColor;
    }
  } else {
    // Try pixel sampling fallback
    const edgeFg = sampleEdgeColors(croppedData, cropWidth, cropHeight);
    const cornerBg = sampleCornerBgColor(croppedData, cropWidth, cropHeight);

    if (edgeFg) {
      colorPath = "pixel_sampling";
      rawFgRgb = edgeFg;
      rawBgRgb = cornerBg;
    } else {
      colorPath = "default";
      // resolveColors defaults: fg=[17,17,17], bg=[255,255,255]
    }
  }

  // Apply resolveColors safety net
  const resolved = resolveColors(rawFgRgb ?? undefined, rawBgRgb ?? undefined);

  // Compute DeltaE between raw fg/bg
  const rawDeltaE =
    rawFgRgb && rawBgRgb ? deltaE(rawFgRgb, rawBgRgb) : null;

  // Determine if safety net triggered
  const safetyNetTriggered = rawDeltaE !== null && rawDeltaE < 30;

  // Compute DeltaE against expected values
  const fgDeltaE = deltaE(resolved.fgRgb, region.expectedFg);
  const bgDeltaE = deltaE(resolved.bgRgb, region.expectedBg);

  // Check gray failure on resolved colors
  const grayFailure = isGrayFailure(resolved.fgRgb, resolved.bgRgb);

  return {
    fixtureImage,
    regionIndex,
    bbox: region.bbox,
    colorPath,
    hasFgRatio,
    hasBgRatio,
    rawFgRgb,
    rawBgRgb,
    resolvedFgRgb: resolved.fgRgb,
    resolvedBgRgb: resolved.bgRgb,
    safetyNetTriggered,
    rawDeltaE,
    expectedFgRgb: region.expectedFg,
    expectedBgRgb: region.expectedBg,
    fgDeltaE,
    bgDeltaE,
    isGrayFailure: grayFailure,
  };
}

/**
 * Compute per-path summary statistics from traces.
 */
function computePathSummaries(traces: RegionDiagnosticTrace[]): PathSummary[] {
  const pathGroups = new Map<ColorPath, RegionDiagnosticTrace[]>();
  for (const trace of traces) {
    const group = pathGroups.get(trace.colorPath) ?? [];
    group.push(trace);
    pathGroups.set(trace.colorPath, group);
  }

  const summaries: PathSummary[] = [];
  for (const [path, group] of pathGroups) {
    const grayFailures = group.filter((t) => t.isGrayFailure).length;
    const avgDeltaE = group.reduce((s, t) => s + (t.fgDeltaE + t.bgDeltaE) / 2, 0) / group.length;
    const avgFgDeltaE = group.reduce((s, t) => s + t.fgDeltaE, 0) / group.length;
    const avgBgDeltaE = group.reduce((s, t) => s + t.bgDeltaE, 0) / group.length;
    const hitRate20 = group.filter((t) => t.fgDeltaE < 20 && t.bgDeltaE < 20).length / group.length;

    summaries.push({
      path,
      regionCount: group.length,
      grayFailureRate: grayFailures / group.length,
      avgDeltaE,
      avgFgDeltaE,
      avgBgDeltaE,
      hitRateDeltaE20: hitRate20,
    });
  }

  return summaries;
}

/**
 * Format diagnostic report as a readable summary table.
 */
function formatSummaryTable(report: DiagnosticReport): string {
  const lines: string[] = [
    `# 颜色诊断报告`,
    "",
    `生成时间: ${report.generatedAt}`,
    `Fixture 数量: ${report.fixtureCount}`,
    `Region 总数: ${report.totalRegionCount}`,
    "",
    `## 按颜色路径汇总`,
    "",
    `| 路径 | Region数 | 灰色失败率 | 平均DeltaE | 平均Fg DeltaE | 平均Bg DeltaE | DeltaE<20命中率 |`,
    `|------|----------|------------|------------|---------------|---------------|-----------------|`,
  ];

  for (const s of report.pathSummaries) {
    lines.push(
      `| ${s.path} | ${s.regionCount} | ${(s.grayFailureRate * 100).toFixed(1)}% | ${s.avgDeltaE.toFixed(2)} | ${s.avgFgDeltaE.toFixed(2)} | ${s.avgBgDeltaE.toFixed(2)} | ${(s.hitRateDeltaE20 * 100).toFixed(1)}% |`,
    );
  }

  lines.push("", "## 各Region详情", "");
  lines.push(
    `| 图片 | Region | 路径 | hasFg比 | hasBg比 | rawFg | rawBg | resolvedFg | resolvedBg | 安全网 | rawDeltaE | fgDeltaE | bgDeltaE | 灰色失败 |`,
    `|------|--------|------|---------|---------|-------|-------|------------|------------|--------|-----------|----------|----------|----------|`,
  );

  for (const t of report.traces) {
    const rawFg = t.rawFgRgb ? `(${t.rawFgRgb.join(",")})` : "N/A";
    const rawBg = t.rawBgRgb ? `(${t.rawBgRgb.join(",")})` : "N/A";
    const hasFg = t.hasFgRatio !== null ? t.hasFgRatio.toFixed(2) : "N/A";
    const hasBg = t.hasBgRatio !== null ? t.hasBgRatio.toFixed(2) : "N/A";
    lines.push(
      `| ${t.fixtureImage} | ${t.regionIndex} | ${t.colorPath} | ${hasFg} | ${hasBg} | ${rawFg} | ${rawBg} | (${t.resolvedFgRgb.join(",")}) | (${t.resolvedBgRgb.join(",")}) | ${t.safetyNetTriggered ? "触发" : "否"} | ${t.rawDeltaE !== null ? t.rawDeltaE.toFixed(2) : "N/A"} | ${t.fgDeltaE.toFixed(2)} | ${t.bgDeltaE.toFixed(2)} | ${t.isGrayFailure ? "是" : "否"} |`,
    );
  }

  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const fixtures = loadFixtures();
  console.log(`加载 ${fixtures.length} 个 fixture 标注文件。`);

  const traces: RegionDiagnosticTrace[] = [];
  let totalRegions = 0;

  for (const fixture of fixtures) {
    const imagePath = join(FIXTURES_DIR, fixture.imageFile);

    // Check if the image file exists
    if (!existsSync(imagePath)) {
      console.warn(`图片不存在: ${imagePath}，跳过 fixture。`);
      // Still trace with default path for missing images
      for (let ri = 0; ri < fixture.regions.length; ri++) {
        const region = fixture.regions[ri];
        // Use default colors since we can't load the image
        const resolved = resolveColors(undefined, undefined);
        const trace: RegionDiagnosticTrace = {
          fixtureImage: fixture.imageFile,
          regionIndex: ri,
          bbox: region.bbox,
          colorPath: "default",
          hasFgRatio: null,
          hasBgRatio: null,
          rawFgRgb: null,
          rawBgRgb: null,
          resolvedFgRgb: resolved.fgRgb,
          resolvedBgRgb: resolved.bgRgb,
          safetyNetTriggered: false,
          rawDeltaE: null,
          expectedFgRgb: region.expectedFg,
          expectedBgRgb: region.expectedBg,
          fgDeltaE: deltaE(resolved.fgRgb, region.expectedFg),
          bgDeltaE: deltaE(resolved.bgRgb, region.expectedBg),
          isGrayFailure: isGrayFailure(resolved.fgRgb, resolved.bgRgb),
        };
        traces.push(trace);
        totalRegions += 1;
      }
      continue;
    }

    const img = await loadImage(imagePath);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const fullImageData = ctx.getImageData(0, 0, img.width, img.height);

    for (let ri = 0; ri < fixture.regions.length; ri++) {
      const region = fixture.regions[ri];
      const cropped = cropRegion(
        fullImageData.data,
        img.width,
        img.height,
        region.bbox,
      );

      // Simulate OCR model path: since we can't run ONNX in Node easily,
      // we use extractColorsFromOutputs with synthetic data.
      // In a real run, this would come from the OCR model inference.
      // For diagnostic purposes, we create a synthetic hasBg=false case
      // to demonstrate the bug scenario.
      const maxSteps = 5;
      const ocrData = createSyntheticOcrData(maxSteps);

      const ocrResult = extractColorsFromOutputsCurrent(
        ocrData.fg, ocrData.bg, ocrData.fgInd, ocrData.bgInd, maxSteps, 0, maxSteps,
      );

      const trace = traceRegionColors(
        fixture.imageFile,
        ri,
        region,
        cropped.data,
        cropped.width,
        cropped.height,
        ocrResult,
      );
      traces.push(trace);
      totalRegions += 1;
    }
  }

  const pathSummaries = computePathSummaries(traces);
  const report: DiagnosticReport = {
    generatedAt: new Date().toISOString(),
    fixtureCount: fixtures.length,
    totalRegionCount: totalRegions,
    traces,
    pathSummaries,
  };

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = join(REPORTS_DIR, `color-diagnostic-${ts}`);
  mkdirSync(reportDir, { recursive: true });

  writeFileSync(join(reportDir, "diagnostic.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(reportDir, "diagnostic-summary.md"), formatSummaryTable(report));

  console.log(`诊断报告已生成: ${reportDir}`);
  console.log(`  Region 总数: ${report.totalRegionCount}`);
  for (const s of report.pathSummaries) {
    console.log(
      `  路径 ${s.path}: ${s.regionCount} regions, 灰色失败率 ${(s.grayFailureRate * 100).toFixed(1)}%, 平均DeltaE ${s.avgDeltaE.toFixed(2)}`,
    );
  }
}

main();
