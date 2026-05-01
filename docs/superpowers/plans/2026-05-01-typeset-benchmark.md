# Typeset Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an offline benchmark that measures how well the vertical typesetting engine reproduces original-image column geometry, using original text (not translations) to isolate typeset quality.

**Architecture:** Fixture-based. A one-time Playwright bake step runs detect+OCR on test images and dumps ground-truth column geometry + current typeset output into JSON fixtures. A Node CLI script (using `node-canvas` for `measureText`) re-runs only the typeset geometry functions against fixture inputs and compares against ground truth. Metrics: column count match, column bbox IoU, font size error, column X offset, per-char Y offset.

**Tech Stack:** TypeScript, Playwright (bake), `canvas` npm package (node-canvas, for Node-side `measureText`), Node built-in `crypto` (sha256)

**Spec:** `docs/superpowers/specs/2026-05-01-typeset-benchmark-design.md`

---

### Task 1: Extract vertical geometry into `typesetGeometry.ts`

**Files:**
- Create: `src/pipeline/typesetGeometry.ts`
- Modify: `src/pipeline/typeset.ts`

The goal is to extract all "pure geometry" functions from `typeset.ts` into a new file that depends only on `CanvasRenderingContext2D` for `measureText` — no `document`, no `HTMLCanvasElement` creation, no rendering. `typeset.ts` will import and call these.

**What moves to `typesetGeometry.ts`:**
- Constants: all vertical-related constants (`verticalAdvanceTightenRatio`, `verticalColumnSpacingRatio`, `minVerticalAdvanceScale`, `minVerticalColSpacingScale`, `verticalContentHeightExpandBaseRatio`, `verticalContentHeightExpandFontRatio`, `minVerticalContentHeightExpandPx`, `minFontSafetySize`, `minorOverflowMaxGlyphCount`, `minorOverflowShrinkMinScale`, `minOffscreenGuardPaddingPx`, `offscreenGuardPaddingByFontRatio`)
- Maps: `CJK_H2V`, `KINSOKU_NSTART`
- Types: `VerticalGlyph`, `VColumn`, `VerticalCellMetrics`, `BuildVerticalLayoutOptions`, `VerticalLayoutResult`, `ColumnBreakReason`, `ColumnSegmentSource`, `PreferredColumnSegment`, `DebugColumnBox`, `RegionTypesetDebug`, `VerticalFitOptions`
- Utility functions: `countTextLength`, `charLength`, `clampNumber`, `splitColumns`, `splitByTextLength`, `resolveSourceColumns`, `resolveTranslatedColumns`, `strokeWidth`, `metricAbs`, `measureGlyphBox`, `colorDistance`, `resolveColors`
- Core geometry functions: `resolveInitialFontSize`, `resolveFontVerticalAdvance`, `resolveGlyphVerticalAdvance`, `resolveVerticalCellMetrics`, `computeVerticalTotalWidth`, `calcVertical`, `calcVerticalFromColumns`, `buildVerticalLayout`, `hasMinorOverflowWrap`, `tryShrinkVerticalForMinorOverflow`, `estimateVerticalPreferredProfile`, `resolveVerticalPreferredColumns`, `buildVerticalDebugColumnBoxes`, `resolveVerticalStartY`, `resolveVerticalContentHeight`, `resolveBoxPadding`, `resolveAlignment`, `expandRegionBeforeRender`, `resolveVerticalRenderPadding`
- Quad helpers: `quadAngle`, `quadDimensions`, `mapOffscreenPointToCanvas`, `mapOffscreenRectToCanvasQuad`

**What stays in `typeset.ts`:**
- `fontFamily` module variable + `resolveFontFamily()`
- All horizontal layout functions (`calcHorizontal`, `measureHorizontalTextWidth`, `resolveHorizontalLetterSpacing`, `resolveHorizontalLineHeight`, `renderHorizontal`, `buildHorizontalDebugColumnBoxes`, `resolveHorizontalRenderPadding`, `drawHorizontalTextLine`, `computeAlignX`, `hasLatinWords`)
- All Canvas rendering functions (`renderVertical`, `renderHorizontal`, `compositeRegion`, `traceRegionPath`, `drawQuadPath`)
- Debug overlay drawing (`drawDebugOverlay` and related)
- `cloneRegionForTypeset`
- The main `drawTypeset` entry point
- `ResolvedColors` type

**New exported function** in `typesetGeometry.ts`:

```typescript
export type VerticalGeometryInput = {
  region: TextRegion;
  text: string;
  contentWidth: number;
  contentHeight: number;
  fontFamily: string;
};

export type VerticalGeometryColumn = {
  glyphs: VerticalGlyph[];
  height: number;
  box: DebugColumnBox;
};

export type VerticalGeometryResult = {
  fittedFontSize: number;
  columns: VerticalGeometryColumn[];
  columnBreakReasons: ColumnBreakReason[];
  columnSegmentIds: number[];
  columnSegmentSources: ColumnSegmentSource[];
  metrics: VerticalCellMetrics;
  offscreenWidth: number;
  offscreenHeight: number;
  boxPadding: number;
  strokePadding: number;
};

export function computeVerticalGeometry(
  ctx: CanvasRenderingContext2D,
  input: VerticalGeometryInput,
): VerticalGeometryResult;
```

`computeVerticalGeometry` encapsulates the logic currently in the `isVertical` branch of `drawTypeset` (lines 2159–2226): resolve preferred columns → estimate profile → build layout → try shrink → compute debug boxes → return geometry.

- [ ] **Step 1: Create `typesetGeometry.ts` with all moved functions, types, constants**

Create `src/pipeline/typesetGeometry.ts`. Move all listed functions/types/constants from `typeset.ts`. Add `computeVerticalGeometry` as a new exported function that wraps the vertical branch logic. Export everything that `typeset.ts` needs to import back.

The `fontFamily` parameter is passed in via `VerticalGeometryInput` instead of using the module variable. All moved functions that reference `fontFamily` must accept it as a parameter or get it from the input.

- [ ] **Step 2: Update `typeset.ts` to import from `typesetGeometry.ts`**

Replace all moved definitions with imports. The `drawTypeset` vertical branch should now call `computeVerticalGeometry(measureCtx, { region, text, contentWidth, contentHeight: verticalContentHeight, fontFamily })` and destructure the result.

Verify: no `document.createElement`, `HTMLCanvasElement`, or `Image` references in `typesetGeometry.ts`.

- [ ] **Step 3: Build check**

Run: `npx tsc --noEmit`
Expected: zero errors. If errors, fix type mismatches.

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/typesetGeometry.ts src/pipeline/typeset.ts
git commit -m "refactor: extract vertical typeset geometry into typesetGeometry.ts"
```

---

### Task 2: Set up benchmark directory structure and config

**Files:**
- Create: `benchmark/bench.config.json`
- Modify: `.gitignore`
- Create: `benchmark/fixtures/.gitkeep`
- Create: `benchmark/images/.gitkeep`

- [ ] **Step 1: Create directory structure and config**

```
benchmark/
  images/.gitkeep
  fixtures/.gitkeep
  bench.config.json
```

`bench.config.json`:
```json
{
  "fixturesDir": "benchmark/fixtures",
  "imagesDir": "benchmark/images",
  "reportsDir": "benchmark/reports",
  "scoreWeights": {
    "columnCountMatch": 0.2,
    "columnIouMean": 0.3,
    "fontSizeError": 0.2,
    "columnDxNorm": 0.15,
    "charDyNorm": 0.15
  },
  "regressionThreshold": 0.05
}
```

- [ ] **Step 2: Update `.gitignore`**

Add:
```
benchmark/images/*
!benchmark/images/.gitkeep
benchmark/reports/
```

`benchmark/fixtures/` should NOT be ignored (fixtures are tracked).

- [ ] **Step 3: Commit**

```bash
git add benchmark/ .gitignore
git commit -m "chore: add benchmark directory structure and config"
```

---

### Task 3: Implement fixture types and metric computation

**Files:**
- Create: `scripts/benchmark/types.ts`
- Create: `scripts/benchmark/metrics.ts`

- [ ] **Step 1: Create `scripts/benchmark/types.ts`**

```typescript
export type FixtureImage = {
  file: string;
  width: number;
  height: number;
  sha256: string;
};

export type BakeInfo = {
  gitCommit: string;
  detectorModel: string;
  ocrModel: string;
};

export type GroundTruthCharCenter = {
  y: number;
};

export type GroundTruthColumn = {
  index: number;
  text: string;
  charCount: number;
  centerX: number;
  topY: number;
  bottomY: number;
  width: number;
  height: number;
  estimatedFontSize: number;
  charCenters: GroundTruthCharCenter[];
};

export type GroundTruth = {
  columns: GroundTruthColumn[];
};

export type TypesetSnapshot = {
  fittedFontSize: number;
  columns: GroundTruthColumn[];
};

export type FixtureRegion = {
  id: string;
  direction: "v" | "h";
  box: { x: number; y: number; width: number; height: number };
  quad?: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ];
  sourceText: string;
  fontSize?: number;
  fgColor?: [number, number, number];
  bgColor?: [number, number, number];
  originalLineCount?: number;
  translatedColumns?: string[];
  groundTruth: GroundTruth;
  currentTypeset: TypesetSnapshot;
};

export type Fixture = {
  schemaVersion: number;
  image: FixtureImage;
  bakedAt: string;
  bakedWith: BakeInfo;
  regions: FixtureRegion[];
};

export type RegionMetrics = {
  regionId: string;
  skipped: boolean;
  skipReason?: string;
  columnCountMatch: number;
  columnCountDiff: number;
  columnIouMean: number;
  columnIouMin: number;
  fontSizeRatio: number;
  fontSizeError: number;
  columnDxNormMean: number;
  columnDxNormMax: number;
  dTopNormMean: number;
  dBottomNormMean: number;
  heightRatioMean: number;
  charDyNormMean: number;
  charDyNormMax: number;
  charDyNormP95: number;
  compositeScore: number;
};

export type ImageMetrics = {
  imageFile: string;
  regionCount: number;
  skippedCount: number;
  regions: RegionMetrics[];
  avgCompositeScore: number;
};

export type BenchmarkSummary = {
  generatedAt: string;
  imageCount: number;
  totalRegionCount: number;
  skippedRegionCount: number;
  avgCompositeScore: number;
  avgColumnIouMean: number;
  avgFontSizeError: number;
  avgColumnDxNorm: number;
  avgCharDyNorm: number;
  columnCountMatchRate: number;
  images: ImageMetrics[];
};

export type ScoreWeights = {
  columnCountMatch: number;
  columnIouMean: number;
  fontSizeError: number;
  columnDxNorm: number;
  charDyNorm: number;
};

export type BenchConfig = {
  fixturesDir: string;
  imagesDir: string;
  reportsDir: string;
  scoreWeights: ScoreWeights;
  regressionThreshold: number;
};
```

- [ ] **Step 2: Create `scripts/benchmark/metrics.ts`**

```typescript
import type {
  GroundTruthColumn,
  RegionMetrics,
  ScoreWeights,
} from "./types";

function rectArea(
  x: number, y: number, w: number, h: number,
): number {
  return Math.max(0, w) * Math.max(0, h);
}

function rectIntersectionArea(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): number {
  const left = Math.max(ax, bx);
  const top = Math.max(ay, by);
  const right = Math.min(ax + aw, bx + bw);
  const bottom = Math.min(ay + ah, by + bh);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

function columnIoU(
  gt: GroundTruthColumn,
  pred: GroundTruthColumn,
): number {
  const inter = rectIntersectionArea(
    gt.centerX - gt.width / 2, gt.topY, gt.width, gt.height,
    pred.centerX - pred.width / 2, pred.topY, pred.width, pred.height,
  );
  const gtArea = rectArea(0, 0, gt.width, gt.height);
  const predArea = rectArea(0, 0, pred.width, pred.height);
  const union = gtArea + predArea - inter;
  if (union <= 0) return 0;
  return inter / union;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function median(values: number[]): number {
  return percentile(values, 50);
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function computeRegionMetrics(
  gtColumns: GroundTruthColumn[],
  predColumns: GroundTruthColumn[],
  predFontSize: number,
  weights: ScoreWeights,
): Omit<RegionMetrics, "regionId" | "skipped" | "skipReason"> {
  const gtN = gtColumns.length;
  const predN = predColumns.length;
  const columnCountMatch = gtN === predN ? 1 : 0;
  const columnCountDiff = predN - gtN;
  const pairCount = Math.max(gtN, predN);

  // Column IoU
  const ious: number[] = [];
  for (let i = 0; i < pairCount; i++) {
    if (i < gtN && i < predN) {
      ious.push(columnIoU(gtColumns[i], predColumns[i]));
    } else {
      ious.push(0);
    }
  }
  const columnIouMean = ious.length > 0
    ? ious.reduce((a, b) => a + b, 0) / ious.length
    : 0;
  const columnIouMin = ious.length > 0 ? Math.min(...ious) : 0;

  // Font size
  const gtFontSizes = gtColumns.map((c) => c.estimatedFontSize);
  const gtFont = gtFontSizes.length > 0 ? median(gtFontSizes) : predFontSize;
  const fontSizeRatio = gtFont > 0 ? predFontSize / gtFont : 1;
  const fontSizeError = gtFont > 0
    ? Math.abs(predFontSize - gtFont) / gtFont
    : 0;

  // Column horizontal offset
  const dxNorms: number[] = [];
  for (let i = 0; i < Math.min(gtN, predN); i++) {
    const dx = predColumns[i].centerX - gtColumns[i].centerX;
    const norm = gtColumns[i].width > 0 ? dx / gtColumns[i].width : 0;
    dxNorms.push(Math.abs(norm));
  }
  const columnDxNormMean = dxNorms.length > 0
    ? dxNorms.reduce((a, b) => a + b, 0) / dxNorms.length
    : 0;
  const columnDxNormMax = dxNorms.length > 0 ? Math.max(...dxNorms) : 0;

  // Column vertical range
  const dTops: number[] = [];
  const dBottoms: number[] = [];
  const heightRatios: number[] = [];
  for (let i = 0; i < Math.min(gtN, predN); i++) {
    const gtH = gtColumns[i].height;
    if (gtH > 0) {
      dTops.push((predColumns[i].topY - gtColumns[i].topY) / gtH);
      dBottoms.push((predColumns[i].bottomY - gtColumns[i].bottomY) / gtH);
      heightRatios.push(predColumns[i].height / gtH);
    }
  }
  const dTopNormMean = dTops.length > 0
    ? dTops.reduce((a, b) => a + Math.abs(b), 0) / dTops.length
    : 0;
  const dBottomNormMean = dBottoms.length > 0
    ? dBottoms.reduce((a, b) => a + Math.abs(b), 0) / dBottoms.length
    : 0;
  const heightRatioMean = heightRatios.length > 0
    ? heightRatios.reduce((a, b) => a + b, 0) / heightRatios.length
    : 0;

  // Per-char Y offset
  const allDyNorms: number[] = [];
  for (let i = 0; i < Math.min(gtN, predN); i++) {
    const gtCenters = gtColumns[i].charCenters;
    const predCenters = predColumns[i].charCenters;
    const gtLen = gtCenters.length;
    const predLen = predCenters.length;
    if (gtLen === 0 || predLen === 0) continue;
    for (let j = 0; j < gtLen; j++) {
      const predIdx = gtLen === predLen
        ? j
        : Math.round(j * predLen / gtLen);
      if (predIdx >= predLen) continue;
      const dy = predCenters[predIdx].y - gtCenters[j].y;
      const norm = predFontSize > 0 ? dy / predFontSize : 0;
      allDyNorms.push(Math.abs(norm));
    }
  }
  const charDyNormMean = allDyNorms.length > 0
    ? allDyNorms.reduce((a, b) => a + b, 0) / allDyNorms.length
    : 0;
  const charDyNormMax = allDyNorms.length > 0 ? Math.max(...allDyNorms) : 0;
  const charDyNormP95 = percentile(allDyNorms, 95);

  // Composite score
  const compositeScore =
    weights.columnCountMatch * columnCountMatch +
    weights.columnIouMean * columnIouMean +
    weights.fontSizeError * (1 - clamp01(fontSizeError)) +
    weights.columnDxNorm * (1 - clamp01(columnDxNormMean)) +
    weights.charDyNorm * (1 - clamp01(charDyNormMean));

  return {
    columnCountMatch,
    columnCountDiff,
    columnIouMean,
    columnIouMin,
    fontSizeRatio,
    fontSizeError,
    columnDxNormMean,
    columnDxNormMax,
    dTopNormMean,
    dBottomNormMean,
    heightRatioMean,
    charDyNormMean,
    charDyNormMax,
    charDyNormP95,
    compositeScore,
  };
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit --strict scripts/benchmark/types.ts scripts/benchmark/metrics.ts` (or use a minimal tsconfig check)

- [ ] **Step 4: Commit**

```bash
git add scripts/benchmark/types.ts scripts/benchmark/metrics.ts
git commit -m "feat(bench): add fixture types and metric computation"
```

---

### Task 4: Implement `run-bench.ts` (Node CLI, metric runner)

**Files:**
- Create: `scripts/benchmark/run-bench.ts`

This script:
1. Reads `bench.config.json`.
2. Scans `benchmark/fixtures/*.fixture.json`.
3. Validates each fixture's `image.sha256` against the actual image file (warns if image missing, errors if sha256 mismatch).
4. For each vertical region: imports `computeVerticalGeometry` from `typesetGeometry.ts`, creates a `node-canvas` ctx with the registered font, runs geometry, extracts pred columns (centerX, topY, bottomY, width, height, charCenters from glyph positions), compares against `groundTruth`.
5. Outputs `benchmark/reports/<timestamp>/summary.json`, `summary.md`, `per-region.csv`.

- [ ] **Step 1: Install `canvas` package**

Run: `npm install --save-dev canvas`

- [ ] **Step 2: Create `scripts/benchmark/run-bench.ts`**

```typescript
import { createCanvas, registerFont } from "canvas";
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
import { computeVerticalGeometry } from "../../src/pipeline/typesetGeometry";
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
  const fontsDir = join(ROOT, "public/fonts");
  // node-canvas needs .ttf/.otf, woff2 won't work — must convert or provide .ttf
  // For now, try to register what's available; if woff2 only, warn.
  const files = readdirSync(fontsDir);
  for (const f of files) {
    if (f.endsWith(".ttf") || f.endsWith(".otf")) {
      const family = f.includes("TW") ? "MTX-SourceHanSans-TW" : "MTX-SourceHanSans-CN";
      registerFont(join(fontsDir, f), { family });
    }
  }
}

function buildPredColumns(
  geomResult: ReturnType<typeof computeVerticalGeometry>,
): GroundTruthColumn[] {
  return geomResult.columns.map((col, i) => {
    const box = col.box;
    const charCenters: { y: number }[] = [];
    let penY = box.y;
    for (const glyph of col.glyphs) {
      charCenters.push({ y: penY + glyph.advanceY / 2 });
      penY += glyph.advanceY;
    }
    return {
      index: i,
      text: col.glyphs.map((g) => g.ch).join(""),
      charCount: col.glyphs.length,
      centerX: box.x + box.width / 2,
      topY: box.y,
      bottomY: box.y + box.height,
      width: box.width,
      height: box.height,
      estimatedFontSize: geomResult.fittedFontSize,
      charCenters,
    };
  });
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

function main(): void {
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
  const fontFamily =
    '"MTX-SourceHanSans-CN", "Noto Sans CJK SC", sans-serif';

  const imageMetrics: ImageMetrics[] = [];

  for (const file of fixtureFiles) {
    const fixture: Fixture = JSON.parse(
      readFileSync(join(fixturesDir, file), "utf-8"),
    );

    // Validate sha256
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

      const geomResult = computeVerticalGeometry(ctx as any, {
        region: textRegion,
        text: region.sourceText,
        contentWidth: region.box.width,
        contentHeight: region.box.height,
        fontFamily,
      });

      const predColumns = buildPredColumns(geomResult);
      const metrics = computeRegionMetrics(
        region.groundTruth.columns,
        predColumns,
        geomResult.fittedFontSize,
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

  // Write reports
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const reportDir = join(ROOT, config.reportsDir, ts);
  mkdirSync(reportDir, { recursive: true });

  writeFileSync(join(reportDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(reportDir, "summary.md"), formatSummaryMd(summary));
  writeFileSync(join(reportDir, "per-region.csv"), formatCsv(imageMetrics));

  console.log(`Benchmark complete. Report: ${reportDir}`);
  console.log(`  Composite score: ${summary.avgCompositeScore.toFixed(4)}`);
  console.log(`  Column IoU: ${summary.avgColumnIouMean.toFixed(4)}`);
  console.log(`  Font size error: ${summary.avgFontSizeError.toFixed(4)}`);
  console.log(`  Column count match: ${(summary.columnCountMatchRate * 100).toFixed(1)}%`);
}

main();
```

- [ ] **Step 3: Verify it compiles** (it won't run yet without fixtures, but should type-check)

Run: `npx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add scripts/benchmark/run-bench.ts
git commit -m "feat(bench): add run-bench metric runner"
```

---

### Task 5: Implement `bake-fixtures.ts` (Playwright bake step)

**Files:**
- Create: `scripts/benchmark/bake-fixtures.ts`
- Modify: `src/content/App.tsx` (add debug bake entry point)

The bake script:
1. Builds the extension with `npm run build`.
2. Launches Playwright Chromium with the extension loaded.
3. For each image in `benchmark/images/`:
   - Opens a page, loads the image.
   - Calls `window.__shinobu_bake__(imageDataUrl)` — a debug entry point injected into the content script that runs detect+OCR, skips translation, runs typeset with source text, and returns all geometry data.
   - Writes the fixture JSON.

- [ ] **Step 1: Add `__shinobu_bake__` debug entry point to content script**

In `src/content/App.tsx` (or a new file `src/content/bakeEntry.ts` imported by `App.tsx`), expose a global function that:
- Takes an image as base64 data URL
- Runs `runPipeline` with a config that skips translation (sets `translatedText = sourceText` for each region)
- Returns the full `typesetDebugLog` + `detectedRegions`

The exact implementation depends on how `runPipeline` is structured — the key interface is:

```typescript
declare global {
  interface Window {
    __shinobu_bake__?: (imageDataUrl: string) => Promise<BakeResult>;
  }
}

type BakeResult = {
  regions: Array<{
    id: string;
    direction: string;
    box: { x: number; y: number; width: number; height: number };
    quad?: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
    sourceText: string;
    fontSize?: number;
    fgColor?: [number, number, number];
    bgColor?: [number, number, number];
    originalLineCount?: number;
    translatedColumns?: string[];
    typesetDebug: {
      fittedFontSize: number;
      columnBoxes: Array<{ x: number; y: number; width: number; height: number }>;
    };
  }>;
  imageWidth: number;
  imageHeight: number;
};
```

This is the most implementation-specific task — review `runPipeline` / `orchestrator.ts` to determine the minimal path to run detect+OCR+typeset while skipping translation and inpainting.

- [ ] **Step 2: Create `scripts/benchmark/bake-fixtures.ts`**

```typescript
import { chromium } from "playwright";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, extname, join, resolve } from "path";
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
  regionData: any,
): GroundTruthColumn[] {
  // Extract column geometry from typesetDebug.columnBoxes
  // Each columnBox = { x, y, width, height }
  // Ground truth columns come from the original text run through typeset
  const boxes: Array<{ x: number; y: number; width: number; height: number }> =
    regionData.typesetDebug?.columnBoxes ?? [];
  const sourceText = regionData.sourceText ?? "";
  const chars = [...sourceText.replace(/\s+/g, "")];
  const fontSize = regionData.typesetDebug?.fittedFontSize ?? 24;

  if (boxes.length === 0) return [];

  // Distribute chars across columns proportionally by height
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
  // Build extension
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
    // Navigate to a blank page to trigger content script
    await page.goto("about:blank");
    // Wait for extension to inject __shinobu_bake__
    // May need to navigate to a page where the content script is active

    const result = await page.evaluate(async (dataUrl: string) => {
      if (typeof window.__shinobu_bake__ !== "function") {
        throw new Error("__shinobu_bake__ not available. Is the extension loaded?");
      }
      return window.__shinobu_bake__(dataUrl);
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
        columns: buildGroundTruthColumns(r),
      },
      currentTypeset: {
        fittedFontSize: r.typesetDebug?.fittedFontSize ?? 0,
        columns: buildGroundTruthColumns(r),
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
    console.log(`  → ${fixtureName} (${regions.length} regions)`);
    await page.close();
  }

  await browser.close();
  console.log("Bake complete.");
}

main();
```

**Note:** The `__shinobu_bake__` entry point and Playwright page navigation will need adaptation during implementation — the content script only activates on specific URL patterns (Twitter). The bake script may need to serve images via a local HTTP server or use `page.addScriptTag` to inject the pipeline directly. This is the main integration challenge.

- [ ] **Step 3: Commit**

```bash
git add scripts/benchmark/bake-fixtures.ts src/content/App.tsx
git commit -m "feat(bench): add fixture bake script and debug entry point"
```

---

### Task 6: Implement `diff-baseline.ts` and add npm scripts

**Files:**
- Create: `scripts/benchmark/diff-baseline.ts`
- Modify: `package.json`

- [ ] **Step 1: Create `scripts/benchmark/diff-baseline.ts`**

```typescript
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { BenchConfig, BenchmarkSummary } from "./types";

const ROOT = resolve(import.meta.dirname, "../..");

function main(): void {
  const configRaw = readFileSync(join(ROOT, "benchmark/bench.config.json"), "utf-8");
  const config: BenchConfig = JSON.parse(configRaw);

  const updateBaseline = process.argv.includes("--update-baseline");
  const baselinePath = join(ROOT, "benchmark/baseline.json");

  // Find latest report
  const reportsDir = join(ROOT, config.reportsDir);
  if (!existsSync(reportsDir)) {
    console.error("No reports directory. Run npm run bench first.");
    process.exit(1);
  }
  const { readdirSync } = require("fs");
  const dirs = readdirSync(reportsDir)
    .filter((d: string) => existsSync(join(reportsDir, d, "summary.json")))
    .sort()
    .reverse();
  if (dirs.length === 0) {
    console.error("No report found. Run npm run bench first.");
    process.exit(1);
  }
  const latestDir = join(reportsDir, dirs[0]);
  const current: BenchmarkSummary = JSON.parse(
    readFileSync(join(latestDir, "summary.json"), "utf-8"),
  );

  if (updateBaseline) {
    const baseline = {
      generatedAt: current.generatedAt,
      avgCompositeScore: current.avgCompositeScore,
      avgColumnIouMean: current.avgColumnIouMean,
      avgFontSizeError: current.avgFontSizeError,
      avgColumnDxNorm: current.avgColumnDxNorm,
      avgCharDyNorm: current.avgCharDyNorm,
      columnCountMatchRate: current.columnCountMatchRate,
    };
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
    console.log("Baseline updated.");
    return;
  }

  if (!existsSync(baselinePath)) {
    console.log("No baseline found. Run with --update-baseline to create one.");
    return;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf-8"));
  const threshold = config.regressionThreshold;

  const metrics: Array<{ name: string; baseline: number; current: number; higherIsBetter: boolean }> = [
    { name: "Composite Score", baseline: baseline.avgCompositeScore, current: current.avgCompositeScore, higherIsBetter: true },
    { name: "Column IoU", baseline: baseline.avgColumnIouMean, current: current.avgColumnIouMean, higherIsBetter: true },
    { name: "Font Size Error", baseline: baseline.avgFontSizeError, current: current.avgFontSizeError, higherIsBetter: false },
    { name: "Column Dx Norm", baseline: baseline.avgColumnDxNorm, current: current.avgColumnDxNorm, higherIsBetter: false },
    { name: "Char Dy Norm", baseline: baseline.avgCharDyNorm, current: current.avgCharDyNorm, higherIsBetter: false },
    { name: "Col Count Match", baseline: baseline.columnCountMatchRate, current: current.columnCountMatchRate, higherIsBetter: true },
  ];

  let hasRegression = false;
  for (const m of metrics) {
    const diff = m.current - m.baseline;
    const relDiff = m.baseline !== 0 ? Math.abs(diff / m.baseline) : Math.abs(diff);
    const improved = m.higherIsBetter ? diff > 0 : diff < 0;
    const regressed = m.higherIsBetter ? diff < 0 : diff > 0;
    const symbol = regressed && relDiff > threshold
      ? "❌"
      : improved && relDiff > threshold
        ? "✅"
        : "➖";
    if (regressed && relDiff > threshold) hasRegression = true;
    console.log(
      `${symbol} ${m.name}: ${m.baseline.toFixed(4)} → ${m.current.toFixed(4)} (${diff >= 0 ? "+" : ""}${diff.toFixed(4)})`,
    );
  }

  if (hasRegression) {
    console.log("\n⚠️  Regressions detected (> " + (threshold * 100) + "% threshold)");
    process.exit(1);
  } else {
    console.log("\n✓ No regressions.");
  }
}

main();
```

- [ ] **Step 2: Add npm scripts to `package.json`**

Add to `scripts`:
```json
{
  "bench:bake": "npx tsx scripts/benchmark/bake-fixtures.ts",
  "bench": "npx tsx scripts/benchmark/run-bench.ts",
  "bench:baseline": "npx tsx scripts/benchmark/diff-baseline.ts --update-baseline",
  "bench:diff": "npx tsx scripts/benchmark/diff-baseline.ts"
}
```

Also add `tsx` as a dev dependency:
Run: `npm install --save-dev tsx`

- [ ] **Step 3: Commit**

```bash
git add scripts/benchmark/diff-baseline.ts package.json package-lock.json
git commit -m "feat(bench): add baseline diff and npm scripts"
```

---

### Task 7: Font preparation for node-canvas

**Files:**
- May need: TTF versions of fonts in `public/fonts/`
- Create: `scripts/benchmark/fonts-readme.md` (short note)

`node-canvas` cannot load `.woff2` fonts — it needs `.ttf` or `.otf`. The current fonts are `SourceHanSansCN-VF.ttf.woff2` and `SourceHanSansTW-VF.ttf.woff2`.

- [ ] **Step 1: Convert or obtain TTF versions**

Options (pick one during implementation):
- a) Download the `.ttf` versions of Source Han Sans from Google Fonts / Adobe and place them in `benchmark/fonts/`.
- b) Use a woff2 → ttf converter (`woff2_decompress` CLI tool) on the existing woff2 files.
- c) If the woff2 files are actually renamed TTFs (the `.ttf.woff2` extension suggests this), try renaming and test with node-canvas.

Place resulting `.ttf` files in `benchmark/fonts/` (gitignored — large binary).

- [ ] **Step 2: Update `run-bench.ts` `registerFonts` to use `benchmark/fonts/`**

```typescript
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
```

- [ ] **Step 3: Add `benchmark/fonts/` to `.gitignore`**

- [ ] **Step 4: Commit**

```bash
git add scripts/benchmark/run-bench.ts .gitignore
git commit -m "feat(bench): support TTF font loading for node-canvas"
```

---

### Task 8: End-to-end smoke test

**Files:** No new files; uses the whole pipeline.

- [ ] **Step 1: Place 1–2 test images in `benchmark/images/`**

Use any available Japanese manga panel images with vertical text.

- [ ] **Step 2: Run the bake step**

Run: `npm run bench:bake`
Expected: Fixtures generated in `benchmark/fixtures/`, one per image, with regions containing `groundTruth.columns` data.

- [ ] **Step 3: Run the benchmark**

Run: `npm run bench`
Expected: Report generated in `benchmark/reports/<timestamp>/` with `summary.json`, `summary.md`, `per-region.csv`. Console shows composite score and sub-metrics.

- [ ] **Step 4: Set initial baseline**

Run: `npm run bench:baseline`
Expected: `benchmark/baseline.json` created.

- [ ] **Step 5: Run diff (should show no regressions)**

Run: `npm run bench:diff`
Expected: All metrics show `➖` (no change), exit code 0.

- [ ] **Step 6: Commit fixtures and baseline**

```bash
git add benchmark/fixtures/ benchmark/baseline.json
git commit -m "feat(bench): add initial fixtures and baseline"
```
