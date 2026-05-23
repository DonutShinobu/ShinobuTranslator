// ---------------------------------------------------------------------------
// Color algorithm comparison script.
// Phase 2: Run current algorithm, Algorithm A, Algorithm D on all fixtures.
// Output CSV metrics table + rendered comparison images.
// ---------------------------------------------------------------------------

import { createCanvas, loadImage } from "canvas";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { basename, join } from "path";
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
import { extractColorsFromOutputsAlgA } from "./alg-a-fix-hasbg";
import { histogramBimodal } from "./alg-d-histogram-bimodal";
import type {
  AlgorithmRegionResult,
  AlgorithmSummary,
  ColorFixtureRegion,
  ColorPath,
  ComparisonReport,
} from "./color-types";

/**
 * Run current algorithm (fixed hasBg + histogram fallback) on cropped region data.
 * When OCR fg/bg DeltaE < 30, falls back to histogramBimodal.
 */
function runCurrentAlgorithm(
  croppedData: Uint8ClampedArray,
  cropWidth: number,
  cropHeight: number,
  ocrFg: Float32Array,
  ocrBg: Float32Array,
  ocrFgInd: Float32Array,
  ocrBgInd: Float32Array,
  maxSteps: number,
): { fgRgb: [number, number, number]; bgRgb: [number, number, number] } {
  const ocrResult = extractColorsFromOutputsCurrent(
    ocrFg, ocrBg, ocrFgInd, ocrBgInd, maxSteps, 0, maxSteps,
  );

  let rawFg: [number, number, number] | undefined;
  let rawBg: [number, number, number] | undefined;

  if (ocrResult) {
    rawFg = ocrResult.fgColor;
    rawBg = ocrResult.bgColor;

    // When OCR colors are too similar, fall back to histogram bimodal
    if (rawFg && rawBg && colorDistance(rawFg, rawBg) < 30) {
      const histResult = histogramBimodal(croppedData, cropWidth, cropHeight);
      if (histResult) {
        rawFg = histResult.fgColor;
        rawBg = histResult.bgColor;
      }
    }
  } else {
    // Pixel sampling fallback
    const edgeFg = sampleEdgeColors(croppedData, cropWidth, cropHeight);
    const cornerBg = sampleCornerBgColor(croppedData, cropWidth, cropHeight);
    if (edgeFg) {
      rawFg = edgeFg;
      rawBg = cornerBg;
    }
  }

  const resolved = resolveColors(rawFg, rawBg);
  return { fgRgb: resolved.fgRgb, bgRgb: resolved.bgRgb };
}

/**
 * Run Algorithm A (fixed hasBg) on cropped region data.
 */
function runAlgorithmA(
  croppedData: Uint8ClampedArray,
  cropWidth: number,
  cropHeight: number,
  ocrFg: Float32Array,
  ocrBg: Float32Array,
  ocrFgInd: Float32Array,
  ocrBgInd: Float32Array,
  maxSteps: number,
): { fgRgb: [number, number, number]; bgRgb: [number, number, number] } {
  const ocrResult = extractColorsFromOutputsAlgA(
    ocrFg, ocrBg, ocrFgInd, ocrBgInd, maxSteps, 0, maxSteps,
  );

  let rawFg: [number, number, number] | undefined;
  let rawBg: [number, number, number] | undefined;

  if (ocrResult) {
    rawFg = ocrResult.fgColor;
    rawBg = ocrResult.bgColor;
  } else {
    // Pixel sampling fallback (same as current)
    const edgeFg = sampleEdgeColors(croppedData, cropWidth, cropHeight);
    const cornerBg = sampleCornerBgColor(croppedData, cropWidth, cropHeight);
    if (edgeFg) {
      rawFg = edgeFg;
      rawBg = cornerBg;
    }
  }

  const resolved = resolveColors(rawFg, rawBg);
  return { fgRgb: resolved.fgRgb, bgRgb: resolved.bgRgb };
}

/**
 * Run Algorithm D (histogram bimodal) on cropped region data.
 */
function runAlgorithmD(
  croppedData: Uint8ClampedArray,
  cropWidth: number,
  cropHeight: number,
): { fgRgb: [number, number, number]; bgRgb: [number, number, number] } {
  const result = histogramBimodal(croppedData, cropWidth, cropHeight);
  if (!result) {
    // Fall back to resolveColors defaults
    const resolved = resolveColors(undefined, undefined);
    return { fgRgb: resolved.fgRgb, bgRgb: resolved.bgRgb };
  }

  // Apply resolveColors safety net (same as all other algorithms)
  const resolved = resolveColors(result.fgColor, result.bgColor);
  return { fgRgb: resolved.fgRgb, bgRgb: resolved.bgRgb };
}

/**
 * Render a side-by-side comparison image for one fixture.
 * Each region shows 3 panels: current | Algorithm A | Algorithm D,
 * each with text rendered in the algorithm's fg/bg colors.
 */
function renderComparisonImage(
  img: CanvasImageSource,
  results: { region: ColorFixtureRegion; current: AlgorithmRegionResult; algA: AlgorithmRegionResult; algD: AlgorithmRegionResult }[],
): Buffer {
  const imgCanvas = img as unknown as { width: number; height: number };
  // Each comparison row: original image + 3 text panels per region
  const panelWidth = 200;
  const panelHeight = 60;
  const padding = 10;

  const totalHeight = imgCanvas.height + padding + results.length * (panelHeight + padding) + 40;
  const totalWidth = Math.max(imgCanvas.width, panelWidth * 3 + padding * 4);

  const vizCanvas = createCanvas(totalWidth, totalHeight);
  const ctx = vizCanvas.getContext("2d");

  // Draw original image
  ctx.drawImage(img as unknown as CanvasImageSource, 0, 0);

  // Draw header for comparison section
  const headerY = imgCanvas.height + padding;
  ctx.font = "bold 18px sans-serif";
  ctx.fillStyle = "#333";
  ctx.fillText("颜色算法对比", 0, headerY + 18);

  // Draw each region's comparison panels
  let panelY = headerY + 40;
  for (const { region, current, algA, algD } of results) {
    // Draw region label
    ctx.font = "14px sans-serif";
    ctx.fillStyle = "#333";
    ctx.fillText(
      `Region [${region.bbox.join(",")}]`,
      0,
      panelY,
    );

    panelY += 20;

    // Draw three panels
    const algorithms = [
      { name: "当前 (修复+回退)", result: current },
      { name: "算法A (修复hasBg)", result: algA },
      { name: "算法D (直方图双峰)", result: algD },
    ];

    for (let i = 0; i < algorithms.length; i++) {
      const { name, result } = algorithms[i];
      const px = padding + i * (panelWidth + padding);

      // Background
      ctx.fillStyle = `rgb(${result.bgRgb.join(",")})`;
      ctx.fillRect(px, panelY, panelWidth, panelHeight);

      // Text with foreground color
      ctx.font = "bold 24px sans-serif";
      ctx.fillStyle = `rgb(${result.fgRgb.join(",")})`;
      ctx.fillText("测试文字", px + 10, panelY + 35);

      // Label below panel
      ctx.font = "12px sans-serif";
      ctx.fillStyle = "#333";
      ctx.fillText(name, px, panelY + panelHeight + 14);

      // DeltaE info
      ctx.fillText(
        `fgΔE=${result.fgDeltaE.toFixed(1)} bgΔE=${result.bgDeltaE.toFixed(1)}`,
        px,
        panelY + panelHeight + 28,
      );
    }

    panelY += panelHeight + 40;
  }

  return vizCanvas.toBuffer("image/png");
}

/**
 * Format comparison metrics as CSV.
 */
function formatCsv(results: AlgorithmRegionResult[]): string {
  const header = [
    "fixtureImage", "regionIndex",
    "algorithm", "fgRgb", "bgRgb",
    "expectedFgRgb", "expectedBgRgb",
    "fgDeltaE", "bgDeltaE",
    "isGrayFailure",
  ].join(",");
  const rows: string[] = [header];
  for (const r of results) {
    rows.push([
      r.fixtureImage,
      r.regionIndex,
      r.algorithm,
      `(${r.fgRgb.join(",")})`,
      `(${r.bgRgb.join(",")})`,
      `(${r.expectedFgRgb.join(",")})`,
      `(${r.expectedBgRgb.join(",")})`,
      r.fgDeltaE.toFixed(2),
      r.bgDeltaE.toFixed(2),
      r.isGrayFailure ? "1" : "0",
    ].join(","));
  }
  return rows.join("\n") + "\n";
}

/**
 * Compute per-algorithm summary metrics.
 */
function computeAlgorithmSummaries(
  results: AlgorithmRegionResult[],
): AlgorithmSummary[] {
  const algGroups = new Map<string, AlgorithmRegionResult[]>();
  for (const r of results) {
    const group = algGroups.get(r.algorithm) ?? [];
    group.push(r);
    algGroups.set(r.algorithm, group);
  }

  const summaries: AlgorithmSummary[] = [];
  for (const [algorithm, group] of algGroups) {
    const grayFailures = group.filter((t) => t.isGrayFailure).length;
    const avgDeltaE = group.reduce((s, t) => s + (t.fgDeltaE + t.bgDeltaE) / 2, 0) / group.length;
    const avgFgDeltaE = group.reduce((s, t) => s + t.fgDeltaE, 0) / group.length;
    const avgBgDeltaE = group.reduce((s, t) => s + t.bgDeltaE, 0) / group.length;
    const hitRate20 = group.filter((t) => t.fgDeltaE < 20 && t.bgDeltaE < 20).length / group.length;

    // Color path distribution — for current/A, use ocr_model; for D, use histogram
    const pathDist: Record<ColorPath, number> = {
      ocr_model: 0,
      pixel_sampling: 0,
      default: 0,
    };
    if (algorithm === "current" || algorithm === "alg-a") {
      pathDist.ocr_model = group.length; // simplified
    } else if (algorithm === "alg-d") {
      // Algorithm D doesn't use color paths; mark as default
      pathDist.default = group.length;
    }

    summaries.push({
      algorithm,
      regionCount: group.length,
      grayFailureRate: grayFailures / group.length,
      avgDeltaE,
      avgFgDeltaE,
      avgBgDeltaE,
      hitRateDeltaE20: hitRate20,
      colorPathDistribution: pathDist,
    });
  }

  return summaries;
}

function makeRegionResult(
  fixtureImage: string,
  regionIndex: number,
  region: ColorFixtureRegion,
  algorithm: string,
  colorResult: { fgRgb: [number, number, number]; bgRgb: [number, number, number] },
): AlgorithmRegionResult {
  const fgDeltaE = deltaE(colorResult.fgRgb, region.expectedFg);
  const bgDeltaE = deltaE(colorResult.bgRgb, region.expectedBg);
  return {
    fixtureImage,
    regionIndex,
    bbox: region.bbox,
    algorithm,
    fgRgb: colorResult.fgRgb,
    bgRgb: colorResult.bgRgb,
    expectedFgRgb: region.expectedFg,
    expectedBgRgb: region.expectedBg,
    fgDeltaE,
    bgDeltaE,
    isGrayFailure: isGrayFailure(colorResult.fgRgb, colorResult.bgRgb),
  };
}

async function main(): Promise<void> {
  const fixtures = loadFixtures();
  console.log(`加载 ${fixtures.length} 个 fixture 标注文件。`);

  const allResults: AlgorithmRegionResult[] = [];
  let totalRegions = 0;

  for (const fixture of fixtures) {
    const imagePath = join(FIXTURES_DIR, fixture.imageFile);

    if (!existsSync(imagePath)) {
      console.warn(`图片不存在: ${imagePath}，跳过 fixture。`);
      continue;
    }

    const img = await loadImage(imagePath);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const fullImageData = ctx.getImageData(0, 0, img.width, img.height);

    const fixtureResults: {
      region: ColorFixtureRegion;
      current: AlgorithmRegionResult;
      algA: AlgorithmRegionResult;
      algD: AlgorithmRegionResult;
    }[] = [];

    for (let ri = 0; ri < fixture.regions.length; ri++) {
      const region = fixture.regions[ri];
      const cropped = cropRegion(
        fullImageData.data,
        img.width,
        img.height,
        region.bbox,
      );

      // Create synthetic OCR data (simulates hasBg=false bug scenario)
      const ocrData = createSyntheticOcrData(5);

      // Run all three algorithms
      const currentResult = runCurrentAlgorithm(
        cropped.data, cropped.width, cropped.height,
        ocrData.fg, ocrData.bg, ocrData.fgInd, ocrData.bgInd, 5,
      );
      const algAResult = runAlgorithmA(
        cropped.data, cropped.width, cropped.height,
        ocrData.fg, ocrData.bg, ocrData.fgInd, ocrData.bgInd, 5,
      );
      const algDResult = runAlgorithmD(
        cropped.data, cropped.width, cropped.height,
      );

      const current = makeRegionResult(fixture.imageFile, ri, region, "current", currentResult);
      const algA = makeRegionResult(fixture.imageFile, ri, region, "alg-a", algAResult);
      const algD = makeRegionResult(fixture.imageFile, ri, region, "alg-d", algDResult);

      allResults.push(current, algA, algD);
      fixtureResults.push({ region, current, algA, algD });
      totalRegions += 1;
    }

    // Render comparison image
    const comparisonBuffer = renderComparisonImage(img, fixtureResults);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const reportDir = join(REPORTS_DIR, `color-comparison-${ts}`);
    mkdirSync(reportDir, { recursive: true });
    const stem = basename(fixture.imageFile).replace(/\.[^.]+$/, "");
    writeFileSync(join(reportDir, `comparison-${stem}.png`), comparisonBuffer);
  }

  const algorithmSummaries = computeAlgorithmSummaries(allResults);
  const report: ComparisonReport = {
    generatedAt: new Date().toISOString(),
    fixtureCount: fixtures.length,
    totalRegionCount: totalRegions * 3, // 3 algorithms per region
    regionResults: allResults,
    algorithmSummaries,
  };

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = join(REPORTS_DIR, `color-comparison-${ts}`);
  mkdirSync(reportDir, { recursive: true });

  writeFileSync(join(reportDir, "comparison.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(reportDir, "comparison.csv"), formatCsv(allResults));

  console.log(`对比报告已生成: ${reportDir}`);
  console.log(`  Region 总数: ${totalRegions} (x3 算法 = ${allResults.length} 结果)`);
  for (const s of report.algorithmSummaries) {
    console.log(
      `  ${s.algorithm}: 灰色失败率 ${(s.grayFailureRate * 100).toFixed(1)}%, 平均DeltaE ${s.avgDeltaE.toFixed(2)}, DeltaE<20命中率 ${(s.hitRateDeltaE20 * 100).toFixed(1)}%`,
    );
  }
}

main();