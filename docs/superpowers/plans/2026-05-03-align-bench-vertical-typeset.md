# 对齐 Benchmark 垂直排版预测框 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提取 `typeset.ts` 垂直路径的完整计算逻辑为共享函数 `computeFullVerticalTypeset`，让 `typeset.ts` 和 `run-bench.ts` 都调用它，确保排版修改后 benchmark 自动对齐。

**Architecture:** 从 `typeset.ts` 的垂直路径提取纯计算逻辑到 `typesetGeometry.ts` 的新函数 `computeFullVerticalTypeset`。该函数封装从 `resolveVerticalPreferredColumns` 到 `buildVerticalDebugColumnBoxes` 的完整流程。`typeset.ts` 调用它后仅负责渲染和 debug 日志组装；`run-bench.ts` 调用它后从结果构建 predColumns。旧的 `computeVerticalGeometry` 删除。

**Tech Stack:** TypeScript, node-canvas (benchmark 环境)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/pipeline/typesetGeometry.ts` | Modify (end of file, ~1442-1535) | 删除 `computeVerticalGeometry` 及其类型；新增 `FullVerticalTypesetInput`/`FullVerticalTypesetResult` 类型和 `computeFullVerticalTypeset` 函数 |
| `src/pipeline/typeset.ts` | Modify (imports + drawTypeset 垂直路径) | 垂直路径改为调用 `computeFullVerticalTypeset`；移除不再直接使用的导入 |
| `scripts/benchmark/run-bench.ts` | Modify (imports + prediction logic) | 替换 `computeVerticalGeometry` + `buildPredColumns` 为 `computeFullVerticalTypeset`；更新 predColumns 构建逻辑 |

---

### Task 1: 在 `typesetGeometry.ts` 中新增 `computeFullVerticalTypeset`

**Files:**
- Modify: `src/pipeline/typesetGeometry.ts:1442-1535`

- [ ] **Step 1: 替换 `computeVerticalGeometry` 区域**

将 `src/pipeline/typesetGeometry.ts` 从第 1442 行（`// ---------------------------------------------------------------------------` / `// computeVerticalGeometry wrapper`）到文件末尾（第 1535 行），替换为以下代码：

```ts
// ---------------------------------------------------------------------------
// computeFullVerticalTypeset — shared by typeset.ts and benchmark
// ---------------------------------------------------------------------------

export type FullVerticalTypesetInput = {
  region: TextRegion;
  fontFamily: string;
  measureCtx: CanvasRenderingContext2D;
};

export type FullVerticalTypesetResult = {
  expandedRegion: TextRegion;
  text: string;
  preferredColumns?: string[];
  preferredColumnSources?: ColumnSegmentSource[];
  sourceColumns: string[];
  sourceColumnLengths: number[];
  singleColumnMaxLength: number | null;
  initialFontSize: number;
  fittedFontSize: number;
  columns: VColumn[];
  columnBreakReasons: ColumnBreakReason[];
  columnSegmentIds: number[];
  columnSegmentSources: ColumnSegmentSource[];
  metrics: VerticalCellMetrics;
  debugColumnBoxes: DebugColumnBox[];
  offscreenWidth: number;
  offscreenHeight: number;
  boxPadding: number;
  strokePadding: number;
  contentWidth: number;
  verticalContentHeight: number;
  alignment: "left" | "center" | "right";
};

export function computeFullVerticalTypeset(
  input: FullVerticalTypesetInput,
): FullVerticalTypesetResult {
  const { region: inputRegion, fontFamily: ff, measureCtx } = input;

  const translatedRaw = inputRegion.translatedText;
  const translated = translatedRaw || inputRegion.sourceText;

  const verticalPreferred = resolveVerticalPreferredColumns(inputRegion, translated);
  const preferredColumnSegments = verticalPreferred?.columns;
  const preferredColumns = preferredColumnSegments?.map((segment) => segment.text);
  const preferredColumnSources = preferredColumnSegments?.map((segment) => segment.source);

  const cloned = cloneRegionForTypeset(inputRegion);
  if (preferredColumns && preferredColumns.length > 0) {
    cloned.translatedColumns = preferredColumns;
  }

  const text = (preferredColumns && preferredColumns.length > 0)
    ? preferredColumns.join("")
    : translated;

  const sourceColumns = verticalPreferred?.sourceColumns ?? resolveSourceColumns(inputRegion);
  const sourceColumnLengths = verticalPreferred?.sourceColumnLengths ?? sourceColumns.map((column) => countTextLength(column));
  const singleColumnMaxLength = verticalPreferred?.singleColumnMaxLength
    ?? (sourceColumnLengths.length > 0 ? Math.max(...sourceColumnLengths) : null);

  const estimatedInitialFontSize = Math.max(8, Math.round(resolveInitialFontSize(cloned)));

  const noopHLineCount = () => 1;
  const region = expandRegionBeforeRender(cloned, text, measureCtx, ff, noopHLineCount);

  const boxPadding = resolveBoxPadding(region);
  const contentWidth = Math.max(20, region.box.width - boxPadding * 2);
  const contentHeight = Math.max(20, region.box.height - boxPadding * 2);
  const verticalContentHeight = resolveVerticalContentHeight(contentHeight, estimatedInitialFontSize);

  const preferredProfile = estimateVerticalPreferredProfile(
    measureCtx,
    region,
    text,
    contentWidth,
    verticalContentHeight,
    estimatedInitialFontSize,
    ff,
    region.translatedColumns,
  );

  const verticalLayoutOptions: BuildVerticalLayoutOptions = {
    colSpacingScale: preferredProfile.colSpacingScale,
    advanceScale: preferredProfile.advanceScale,
    preferredColumns: region.translatedColumns,
    preferredColumnSources,
  };

  const baseLayout = buildVerticalLayout(measureCtx, text, verticalContentHeight, estimatedInitialFontSize, ff, verticalLayoutOptions);
  const { fontSize, layout } = tryShrinkVerticalForMinorOverflow(
    measureCtx,
    text,
    verticalContentHeight,
    estimatedInitialFontSize,
    verticalLayoutOptions,
    baseLayout,
    ff,
  );

  const { columns, columnBreakReasons, columnSegmentIds, columnSegmentSources, metrics } = layout;
  const strokePadding = resolveVerticalRenderPadding(measureCtx, columns, fontSize, metrics, ff);
  const alignment = resolveAlignment(region, columns.length);

  const debugColumnBoxes = buildVerticalDebugColumnBoxes(
    columns,
    contentWidth,
    verticalContentHeight,
    metrics,
    alignment,
    strokePadding,
  );

  return {
    expandedRegion: region,
    text,
    preferredColumns: preferredColumns && preferredColumns.length > 0 ? preferredColumns : undefined,
    preferredColumnSources,
    sourceColumns,
    sourceColumnLengths,
    singleColumnMaxLength,
    initialFontSize: estimatedInitialFontSize,
    fittedFontSize: fontSize,
    columns,
    columnBreakReasons,
    columnSegmentIds,
    columnSegmentSources,
    metrics,
    debugColumnBoxes,
    offscreenWidth: Math.ceil(contentWidth + strokePadding * 2),
    offscreenHeight: Math.ceil(verticalContentHeight + strokePadding * 2),
    boxPadding,
    strokePadding,
    contentWidth,
    verticalContentHeight,
    alignment,
  };
}
```

- [ ] **Step 2: 验证编译**

Run: `npx tsc --noEmit --pretty 2>&1 | grep -c "typesetGeometry.ts"`
Expected: 0（typesetGeometry.ts 自身无错误；其他文件可能报错因为 import 了被删除的 `computeVerticalGeometry`）

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/typesetGeometry.ts
git commit -m "feat(typeset): add computeFullVerticalTypeset, remove computeVerticalGeometry"
```

---

### Task 2: 修改 `typeset.ts` 使用 `computeFullVerticalTypeset`

**Files:**
- Modify: `src/pipeline/typeset.ts:1-35` (imports)
- Modify: `src/pipeline/typeset.ts:723-945` (drawTypeset loop body)

- [ ] **Step 1: 更新 imports**

替换 `src/pipeline/typeset.ts` 开头的两个 import 块（第 2-35 行）为：

```ts
import {
  resolveColors,
  resolveInitialFontSize,
  resolveBoxPadding,
  mapOffscreenRectToCanvasQuad,
  cloneQuad,
  cloneRegionForTypeset,
  strokeWidth,
  metricAbs,
  quadAngle,
  quadDimensions,
  resolveOffscreenGuardPadding,
  resolveAlignment,
  computeFullVerticalTypeset,
  KINSOKU_NSTART,
  KINSOKU_NEND,
} from "./typesetGeometry";
import type {
  VColumn,
  VerticalCellMetrics,
  DebugColumnBox,
  RegionTypesetDebug,
  ResolvedColors,
} from "./typesetGeometry";
```

移除的导入（现在由 `computeFullVerticalTypeset` 内部调用）：`resolveVerticalPreferredColumns`, `resolveSourceColumns`, `countTextLength`, `expandRegionBeforeRender`, `resolveVerticalContentHeight`, `estimateVerticalPreferredProfile`, `buildVerticalLayout`, `tryShrinkVerticalForMinorOverflow`, `resolveVerticalRenderPadding`, `buildVerticalDebugColumnBoxes`, `BuildVerticalLayoutOptions`, `FullVerticalTypesetResult`。

- [ ] **Step 2: 替换 drawTypeset 循环体**

替换 `drawTypeset` 中 `for (let regionIndex = 0; ...)` 循环体（从第 723 行到第 944 行的 `}` ），替换为：

```ts
  for (let regionIndex = 0; regionIndex < renderRegions.length; regionIndex += 1) {
    const inputRegion = renderRegions[regionIndex];
    const translatedRaw = inputRegion.translatedText;
    const translated = translatedRaw || inputRegion.sourceText;
    const isVerticalInput = inputRegion.direction === "v";

    let offCanvas: HTMLCanvasElement | null = null;
    let debug: RegionTypesetDebug;
    let region: TextRegion;
    let estimatedInitialFontSize: number;
    let text: string;
    let preferredColumns: string[] | undefined;
    let sourceColumns: string[];
    let sourceColumnLengths: number[];
    let singleColumnMaxLength: number | null;

    if (isVerticalInput) {
      const vResult = computeFullVerticalTypeset({
        region: inputRegion,
        fontFamily,
        measureCtx,
      });

      region = vResult.expandedRegion;
      estimatedInitialFontSize = vResult.initialFontSize;
      text = vResult.text;
      preferredColumns = vResult.preferredColumns;
      sourceColumns = vResult.sourceColumns;
      sourceColumnLengths = vResult.sourceColumnLengths;
      singleColumnMaxLength = vResult.singleColumnMaxLength;

      if (!text.trim()) continue;

      const colors = resolveColors(region.fgColor, region.bgColor);
      if (renderText) {
        offCanvas = renderVertical(
          vResult.columns,
          vResult.fittedFontSize,
          vResult.contentWidth,
          vResult.verticalContentHeight,
          colors,
          vResult.alignment,
          vResult.metrics,
          vResult.strokePadding,
        );
      }
      debug = {
        fittedFontSize: vResult.fittedFontSize,
        columnBoxes: vResult.debugColumnBoxes,
        columnBreakReasons: vResult.columnBreakReasons,
        columnSegmentIds: vResult.columnSegmentIds,
        columnSegmentSources: vResult.columnSegmentSources,
        offscreenWidth: vResult.offscreenWidth,
        offscreenHeight: vResult.offscreenHeight,
        boxPadding: vResult.boxPadding,
        strokePadding: vResult.strokePadding,
      };
    } else {
      // Horizontal path — unchanged
      const verticalPreferred = undefined;
      sourceColumns = resolveSourceColumns(inputRegion);
      sourceColumnLengths = sourceColumns.map((column) => countTextLength(column));
      singleColumnMaxLength = sourceColumnLengths.length > 0 ? Math.max(...sourceColumnLengths) : null;
      preferredColumns = undefined;

      text = translated;
      if (!text.trim()) continue;

      estimatedInitialFontSize = Math.max(8, Math.round(resolveInitialFontSize(inputRegion)));
      const calcHorizontalLineCountFn = (mCtx: CanvasRenderingContext2D, t: string, maxWidth: number, fontSize: number): number => {
        const lines = calcHorizontal(mCtx, t, maxWidth, fontSize);
        return lines.length;
      };
      region = expandRegionBeforeRender(inputRegion, text, measureCtx, fontFamily, calcHorizontalLineCountFn);
      const boxPadding = resolveBoxPadding(region);
      const contentWidth = Math.max(20, region.box.width - boxPadding * 2);
      const contentHeight = Math.max(20, region.box.height - boxPadding * 2);
      const colors = resolveColors(region.fgColor, region.bgColor);
      const initialFontSize = estimatedInitialFontSize;

      measureCtx.font = `${initialFontSize}px ${fontFamily}`;
      const lines = calcHorizontal(measureCtx, text, contentWidth, initialFontSize);
      const fontSize = initialFontSize;
      const strokePadding = resolveHorizontalRenderPadding(measureCtx, lines, fontSize);
      const alignment = resolveAlignment(region, lines.length);
      if (renderText) {
        offCanvas = renderHorizontal(
          lines,
          fontSize,
          contentWidth,
          contentHeight,
          colors,
          alignment,
          strokePadding,
        );
      }
      debug = {
        fittedFontSize: fontSize,
        columnBoxes: buildHorizontalDebugColumnBoxes(
          lines,
          contentWidth,
          contentHeight,
          fontSize,
          alignment,
          strokePadding,
        ),
        columnBreakReasons: lines.map((_, index) => (index === 0 ? 'start' : 'wrap')),
        columnSegmentIds: lines.map(() => 1),
        columnSegmentSources: lines.map(() => 'model'),
        offscreenWidth: Math.ceil(contentWidth + strokePadding * 2),
        offscreenHeight: Math.ceil(contentHeight + strokePadding * 2),
        boxPadding,
        strokePadding,
      };
    }

    if (offCanvas) {
      compositeRegion(
        ctx,
        offCanvas,
        region,
        debug.boxPadding,
        debug.strokePadding,
      );
    }

    if (debugMode) {
      drawTypesetDebugOverlay(ctx, inputRegion, region, regionIndex, estimatedInitialFontSize, debug);
    }

    if (collectDebugLog) {
      const columnCanvasQuads = debug.columnBoxes.map((box) =>
        mapOffscreenRectToCanvasQuad(
          region,
          box,
          debug.offscreenWidth,
          debug.offscreenHeight,
          debug.boxPadding,
          debug.strokePadding,
        )
      );
      const direction: TextDirection = region.direction === "h" ? "h" : "v";
      debugRegions.push({
        regionId: inputRegion.id,
        regionIndex,
        direction,
        sourceText: inputRegion.sourceText,
        translatedTextRaw: translatedRaw,
        translatedTextUsed: text,
        translatedColumnsRaw: inputRegion.translatedColumns ? [...inputRegion.translatedColumns] : [],
        preferredColumns: preferredColumns ? [...preferredColumns] : [],
        sourceColumns,
        sourceColumnLengths,
        singleColumnMaxLength,
        initialFontSize: estimatedInitialFontSize,
        fittedFontSize: debug.fittedFontSize,
        sourceBox: { ...inputRegion.box },
        expandedBox: { ...region.box },
        sourceQuad: inputRegion.quad ? cloneQuad(inputRegion.quad) : undefined,
        expandedQuad: region.quad ? cloneQuad(region.quad) : undefined,
        offscreenWidth: debug.offscreenWidth,
        offscreenHeight: debug.offscreenHeight,
        boxPadding: debug.boxPadding,
        strokePadding: debug.strokePadding,
        columnBreakReasons: [...debug.columnBreakReasons],
        columnSegmentIds: [...debug.columnSegmentIds],
        columnSegmentSources: [...debug.columnSegmentSources],
        columnBoxes: debug.columnBoxes.map((box) => ({ ...box })),
        columnCanvasQuads,
      });
    }
  }
```

**注意：** 水平路径需要保留对以下函数的导入（它们在水平路径中仍被直接使用）：`resolveSourceColumns`, `countTextLength`, `expandRegionBeforeRender`, `resolveBoxPadding`, `resolveInitialFontSize`。回到 Step 1 的 import 列表中补充这些。

更新后的完整 import 块：

```ts
import {
  resolveSourceColumns,
  countTextLength,
  resolveInitialFontSize,
  expandRegionBeforeRender,
  resolveBoxPadding,
  resolveColors,
  resolveAlignment,
  mapOffscreenRectToCanvasQuad,
  cloneQuad,
  cloneRegionForTypeset,
  strokeWidth,
  metricAbs,
  quadAngle,
  quadDimensions,
  resolveOffscreenGuardPadding,
  computeFullVerticalTypeset,
  KINSOKU_NSTART,
  KINSOKU_NEND,
} from "./typesetGeometry";
import type {
  VColumn,
  VerticalCellMetrics,
  DebugColumnBox,
  RegionTypesetDebug,
  ResolvedColors,
} from "./typesetGeometry";
```

- [ ] **Step 3: 删除 `calcHorizontalLineCount` 回调变量**

`drawTypeset` 函数中原有的 `calcHorizontalLineCount` 回调定义（约第 715-718 行）可以删除，因为水平路径中已经内联了。确认删除：

```ts
  // DELETE THIS BLOCK (was around line 715-718):
  // const calcHorizontalLineCount = (mCtx: CanvasRenderingContext2D, text: string, maxWidth: number, fontSize: number): number => {
  //   const lines = calcHorizontal(mCtx, text, maxWidth, fontSize);
  //   return lines.length;
  // };
```

- [ ] **Step 4: 验证编译**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: `typeset.ts` 无错误（`run-bench.ts` 可能仍报错）

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/typeset.ts
git commit -m "refactor(typeset): use computeFullVerticalTypeset for vertical path"
```

---

### Task 3: 修改 `run-bench.ts` 使用 `computeFullVerticalTypeset`

**Files:**
- Modify: `scripts/benchmark/run-bench.ts`

- [ ] **Step 1: 更新 imports**

替换第 14-15 行：

```ts
// OLD:
import { computeVerticalGeometry } from "../../src/pipeline/typesetGeometry";
import type { TextRegion } from "../../src/types";

// NEW:
import { computeFullVerticalTypeset } from "../../src/pipeline/typesetGeometry";
import type { TextRegion } from "../../src/types";
```

- [ ] **Step 2: 删除 `buildPredColumns` 函数**

删除第 46-73 行的 `buildPredColumns` 函数（整个函数体）。

- [ ] **Step 3: 替换预测框生成逻辑**

在 `main()` 函数中，替换对 `computeVerticalGeometry` 和 `buildPredColumns` 的调用（原第 218-240 行区域）。

将：

```ts
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

      const geomResult = computeVerticalGeometry(ctx as unknown as CanvasRenderingContext2D, {
        region: textRegion,
        text: region.sourceText,
        contentWidth: region.box.width,
        contentHeight: region.box.height,
        fontFamily,
      });

      const predColumns = buildPredColumns(geomResult, region.box);
```

替换为：

```ts
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
```

**关键变化：** `ox`/`oy` 现在基于 `vResult.expandedRegion.box`（扩展后的区域）而非原始 `region.box`。这对齐了实际 pipeline 中排版坐标基于扩展后区域计算的行为。

- [ ] **Step 4: 验证编译**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: 全部通过，无错误

- [ ] **Step 5: 运行 benchmark**

Run: `npx tsx scripts/benchmark/run-bench.ts 2>&1 | tail -10`
Expected: benchmark 正常运行，输出 composite score 等指标。分数可能与之前不同（因为现在包含了 `expandRegionBeforeRender` 和 `resolveVerticalPreferredColumns` 的效果），这是预期行为。

- [ ] **Step 6: Commit**

```bash
git add scripts/benchmark/run-bench.ts
git commit -m "refactor(bench): use computeFullVerticalTypeset for prediction columns"
```
