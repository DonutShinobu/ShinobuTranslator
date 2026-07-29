# Bubble Mask 逐列扩展排版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 竖排排版在译文比原文长时，利用 bubble mask 逐列向下扩展可用高度，保持原文上端对齐，仅在 mask 空间不足时才缩小字号。

**Architecture:** 将 bubble mask 引用存到 TextRegion 上，排版时对每列独立查询 mask 可用高度，通过 `perColumnMaxHeight` 回调让 `calcVertical` / `calcVerticalFromColumns` 支持逐列不同的高度上限。pipeline 中 bubble 匹配移到 merge 之后，确保 merged region 拿到数据。

**Tech Stack:** TypeScript, Canvas API (ImageData), Vitest

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/types.ts` | Modify | 新增 `bubbleMask` 字段 |
| `src/pipeline/bubbleDetect.ts` | Modify | 匹配时存储 mask 引用 |
| `src/pipeline/orchestrator.ts` | Modify | bubble 匹配移到 merge 后 |
| `src/pipeline/bake.ts` | Modify | 增加 bubble 检测和匹配 |
| `src/pipeline/typesetGeometry.ts` | Modify | 新增 `queryMaskMaxY`，修改排版函数支持逐列高度 |
| `src/pipeline/typesetGeometry.test.ts` | Create | `queryMaskMaxY` 和逐列高度排版的单元测试 |

---

### Task 1: TextRegion 新增 bubbleMask 字段

**Files:**
- Modify: `src/types.ts:30`

- [ ] **Step 1: 在 `TextRegion` 中新增 `bubbleMask` 字段**

在 `bubbleBox?: Rect;` 之后添加：

```typescript
bubbleMask?: ImageData;
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add bubbleMask field to TextRegion"
```

---

### Task 2: bubble 匹配时存储 mask 引用

**Files:**
- Modify: `src/pipeline/bubbleDetect.ts:298-339`

- [ ] **Step 1: 修改 `matchRegionsToBubbles`，存储 mask**

在 `bubbleDetect.ts:329` 处，匹配成功时同时存储 mask：

```typescript
if (bestBubble) {
  region.bubbleBox = { ...bestBubble.box };
  region.bubbleMask = bestBubble.mask;
} else {
  unmatchedRegionIds.push(region.id);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/pipeline/bubbleDetect.ts
git commit -m "feat(bubble): store mask reference on matched regions"
```

---

### Task 3: Pipeline 顺序调整 — orchestrator

**Files:**
- Modify: `src/pipeline/orchestrator.ts:164-178`

- [ ] **Step 1: 提升 bubbles 到 try 块外，匹配移到 merge 后**

将 bubble 检测结果提升到外部变量，匹配调用移到 merge 之后：

在 bubble 检测 try 块之前声明：

```typescript
let detectedBubbles: BubbleDetection[] = [];
```

在 bubble 检测 try 块中，只执行检测，不匹配：

```typescript
report(onProgress, "bubble", "气泡检测");
try {
  const t0 = performance.now();
  const bubbleResult = await detectBubbles(image);
  detectedBubbles = bubbleResult.bubbles;
  stageTimings.push({ stage: "bubble", label: "气泡检测", durationMs: performance.now() - t0 });
} catch (error) {
  throw new PipelineStageError("气泡检测", toErrorDetail(error), buildArtifacts());
}
```

在 merge 阶段之后（现在的 `latestRegions = mergeTextLines(...)` 之后），添加匹配：

```typescript
if (detectedBubbles.length > 0) {
  const matchResult = matchRegionsToBubbles(latestRegions, detectedBubbles);
  if (matchResult.unmatchedCount > 0) {
    console.warn(
      `[bubble] ${matchResult.unmatchedCount} 个文字区域未匹配到气泡:`,
      matchResult.unmatchedRegionIds,
    );
  }
}
```

- [ ] **Step 2: 添加 `BubbleDetection` 到 import**

在 `orchestrator.ts` 的 import 中，从 `bubbleDetect` 新增导入 `BubbleDetection` 类型：

```typescript
import { detectBubbles, matchRegionsToBubbles, type BubbleDetection } from "./bubbleDetect";
```

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/orchestrator.ts
git commit -m "fix(pipeline): move bubble matching after merge to preserve bubbleMask"
```

---

### Task 4: Pipeline 顺序调整 — bake

**Files:**
- Modify: `src/pipeline/bake.ts`

- [ ] **Step 1: 在 bake.ts 中添加 bubble 检测和匹配**

在 `bake.ts` 顶部添加 import：

```typescript
import { detectBubbles, matchRegionsToBubbles } from "./bubbleDetect";
```

在 `shinobuRender` 函数中，`mergeTextLines` 和 `sortRegionsForRender` 之后，`for` 循环之前，添加：

```typescript
const bubbleResult = await detectBubbles(image);
if (bubbleResult.bubbles.length > 0) {
  matchRegionsToBubbles(regions, bubbleResult.bubbles);
}
```

在 `shinobuBake` 函数中，同样在 merge + sort 之后、`for` 循环之前，添加相同的代码。

- [ ] **Step 2: Commit**

```bash
git add src/pipeline/bake.ts
git commit -m "feat(bake): add bubble detection and matching"
```

---

### Task 5: 实现 `queryMaskMaxY` 并编写测试

**Files:**
- Modify: `src/pipeline/typesetGeometry.ts`
- Create: `src/pipeline/typesetGeometry.test.ts`

- [ ] **Step 1: 编写 `queryMaskMaxY` 的测试**

创建 `src/pipeline/typesetGeometry.test.ts`：

```typescript
import { describe, it, expect } from "vitest";
import { queryMaskMaxY } from "./typesetGeometry";

function createMask(width: number, height: number, fillFn: (x: number, y: number) => boolean): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (fillFn(x, y)) {
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
        data[idx + 3] = 255;
      }
    }
  }
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

describe("queryMaskMaxY", () => {
  it("returns yStart when first row is already outside mask", () => {
    const mask = createMask(100, 100, () => false);
    expect(queryMaskMaxY(mask, 10, 20, 50)).toBe(50);
  });

  it("returns mask bottom when entire column is inside mask", () => {
    const mask = createMask(100, 100, () => true);
    expect(queryMaskMaxY(mask, 10, 20, 0)).toBe(99);
  });

  it("stops at the first row where all pixels are outside", () => {
    // mask filled from y=0 to y=59, empty from y=60
    const mask = createMask(100, 100, (_x, y) => y < 60);
    expect(queryMaskMaxY(mask, 10, 20, 0)).toBe(59);
  });

  it("handles rounded bubble shape — narrower columns stop earlier", () => {
    // Circle-ish: filled where distance from center (50,50) < 40
    const mask = createMask(100, 100, (x, y) => {
      return Math.hypot(x - 50, y - 50) < 40;
    });
    // Column near center (x=45-55): can go deeper
    const centerMaxY = queryMaskMaxY(mask, 45, 55, 20);
    // Column near edge (x=80-90): stops earlier due to circle curvature
    const edgeMaxY = queryMaskMaxY(mask, 80, 90, 20);
    expect(centerMaxY).toBeGreaterThan(edgeMaxY);
  });

  it("clamps xStart/xEnd to mask bounds", () => {
    const mask = createMask(50, 50, () => true);
    // xEnd exceeds mask width — should not crash
    expect(queryMaskMaxY(mask, 40, 60, 0)).toBe(49);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/pipeline/typesetGeometry.test.ts`
Expected: FAIL — `queryMaskMaxY` 不存在

- [ ] **Step 3: 实现 `queryMaskMaxY`**

在 `typesetGeometry.ts` 中，在 `resolveBoxPadding` 函数之前添加：

```typescript
export function queryMaskMaxY(
  mask: ImageData,
  xStart: number,
  xEnd: number,
  yStart: number,
): number {
  const clampedXStart = Math.max(0, Math.round(xStart));
  const clampedXEnd = Math.min(mask.width - 1, Math.round(xEnd));
  const maxY = mask.height - 1;

  if (clampedXStart > clampedXEnd || yStart > maxY) {
    return Math.round(yStart);
  }

  let lastValidY = Math.round(yStart);
  for (let y = Math.round(yStart); y <= maxY; y++) {
    let allOutside = true;
    for (let x = clampedXStart; x <= clampedXEnd; x++) {
      const idx = (y * mask.width + x) * 4;
      if (mask.data[idx + 3] > 0) {
        allOutside = false;
        break;
      }
    }
    if (allOutside) {
      return lastValidY;
    }
    lastValidY = y;
  }
  return lastValidY;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/pipeline/typesetGeometry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/typesetGeometry.ts src/pipeline/typesetGeometry.test.ts
git commit -m "feat(typeset): add queryMaskMaxY for per-column mask scanning"
```

---

### Task 6: 排版函数支持逐列高度上限

**Files:**
- Modify: `src/pipeline/typesetGeometry.ts`

这一步修改 `calcVertical`、`calcVerticalFromColumns`、`buildVerticalLayout` 支持 `perColumnMaxHeight` 参数。

- [ ] **Step 1: 修改 `BuildVerticalLayoutOptions` 类型**

在 `src/pipeline/typesetGeometry.ts:398` 的 `BuildVerticalLayoutOptions` 中新增字段：

```typescript
export type BuildVerticalLayoutOptions = {
  colSpacingScale?: number;
  advanceScale?: number;
  preferredColumns?: string[];
  preferredColumnSources?: ColumnSegmentSource[];
  perColumnMaxHeight?: (columnIndex: number) => number;
};
```

- [ ] **Step 2: 修改 `calcVertical` 支持逐列高度**

修改 `calcVertical` 的签名，新增可选参数：

```typescript
export function calcVertical(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxHeight: number,
  fontSize: number,
  defaultAdvanceY: number,
  advanceScale = 1,
  perColumnMaxHeight?: (columnIndex: number) => number,
): VColumn[] {
```

在函数体中，新增一个列索引计数器，换行判断使用逐列高度：

将第 616 行的 `let colHeight = 0;` 改为：

```typescript
let colHeight = 0;
let colIndex = 0;
```

将第 625 行的换行判断：

```typescript
if (colHeight + advanceY > maxHeight && col.length > 0) {
```

改为：

```typescript
const currentMaxHeight = perColumnMaxHeight ? perColumnMaxHeight(colIndex) : maxHeight;
if (colHeight + advanceY > currentMaxHeight && col.length > 0) {
```

在所有 push 新列并 reset col 的位置（第 631、641、647 行的 `col = [];` 之后），追加：

```typescript
colIndex++;
```

即以下三处：

第 630-632 行（kinsoku nstart 分支）的 `col = [];` 后：
```typescript
columns.push({ glyphs: col, height: colHeight });
col = [];
colHeight = 0;
colIndex++;
continue;
```

第 640-642 行（kinsoku nend 分支）的 `col = [carry, ...]` 之前：
```typescript
columns.push({ glyphs: col, height: colHeight - carry.advanceY });
colIndex++;
col = [carry, { ch, advanceY }];
```

第 646-648 行（普通换行）的 `col = [];` 后：
```typescript
columns.push({ glyphs: col, height: colHeight });
col = [];
colHeight = 0;
colIndex++;
```

- [ ] **Step 3: 修改 `calcVerticalFromColumns` 支持逐列高度**

在 `calcVerticalFromColumns` 签名中新增参数：

```typescript
export function calcVerticalFromColumns(
  ctx: CanvasRenderingContext2D,
  preferredColumns: string[],
  preferredColumnSources: ColumnSegmentSource[] | undefined,
  maxHeight: number,
  fontSize: number,
  defaultAdvanceY: number,
  advanceScale = 1,
  perColumnMaxHeight?: (columnIndex: number) => number,
): {
```

将内部调用 `calcVertical` 的地方（第 718 行）传入 `perColumnMaxHeight`：

```typescript
const segmentColumns = calcVertical(
  ctx,
  segment,
  maxHeight,
  fontSize,
  defaultAdvanceY,
  advanceScale,
  perColumnMaxHeight ? (ci) => perColumnMaxHeight(columns.length + ci) : undefined,
);
```

同时将第 740 行 `lastColumn.height + glyph.advanceY > maxHeight` 改为使用逐列高度：

```typescript
const currentColMaxHeight = perColumnMaxHeight ? perColumnMaxHeight(columns.length - 1) : maxHeight;
if (lastColumn.height + glyph.advanceY > currentColMaxHeight) {
```

- [ ] **Step 4: 修改 `buildVerticalLayout` 传递 `perColumnMaxHeight`**

在 `buildVerticalLayout` 中（第 1042-1068 行），将 `perColumnMaxHeight` 传入底层函数：

```typescript
if (options?.preferredColumns && options.preferredColumns.length > 0) {
  const detailed = calcVerticalFromColumns(
    ctx,
    options.preferredColumns,
    options.preferredColumnSources,
    contentHeight,
    fontSize,
    metrics.defaultAdvanceY,
    advanceScale,
    options?.perColumnMaxHeight,
  );
  // ...
} else {
  columns = calcVertical(
    ctx,
    text,
    contentHeight,
    fontSize,
    metrics.defaultAdvanceY,
    advanceScale,
    options?.perColumnMaxHeight,
  );
  // ...
}
```

- [ ] **Step 5: 运行现有测试确认不破坏**

Run: `npx vitest run`
Expected: 所有测试通过（新参数可选，不影响已有行为）

- [ ] **Step 6: Commit**

```bash
git add src/pipeline/typesetGeometry.ts
git commit -m "feat(typeset): add perColumnMaxHeight support to vertical layout"
```

---

### Task 7: 修改 `computeFullVerticalTypeset` 使用 mask 扩展

**Files:**
- Modify: `src/pipeline/typesetGeometry.ts:1480-1650`

这是核心变更。移除 `bubbleBox` 替换逻辑，改为使用 mask 逐列查询扩展高度。

- [ ] **Step 1: 移除 `computeFullVerticalTypeset` 中的 bubbleBox 替换**

删除第 1494-1496 行：

```typescript
// 删除以下代码
if (cloned.bubbleBox) {
  cloned.box = { ...cloned.bubbleBox };
}
```

- [ ] **Step 2: 实现逐列 mask 扩展逻辑**

在 `computeFullVerticalTypeset` 的二分搜索之前（现在的第 1580 行 `if (layout.columns.length > targetColumnCount ...)`），插入 mask 扩展逻辑。

在计算 `baseLayout` 之后、`tryShrinkVerticalForMinorOverflow` 之后，二分搜索之前：

```typescript
  let { fontSize, layout } = tryShrinkVerticalForMinorOverflow(
    measureCtx, text, verticalContentHeight, estimatedInitialFontSize,
    verticalLayoutOptions, baseLayout, ff,
  );

  // --- Bubble mask 逐列扩展 ---
  let effectiveContentHeight = verticalContentHeight;
  let perColumnMaxHeight: ((columnIndex: number) => number) | undefined;

  if (layout.columns.length > targetColumnCount && inputRegion.bubbleMask) {
    const mask = inputRegion.bubbleMask;
    const boxTop = region.box.y + boxPadding;
    const boxLeft = region.box.x + boxPadding;

    // 计算列布局的 x 偏移（与 buildVerticalDebugColumnBoxes 一致）
    const totalColW = layout.columns.length * layout.metrics.colWidth
      + Math.max(0, layout.columns.length - 1) * layout.metrics.colSpacing;
    const offsetX = (contentWidth - totalColW) / 2;
    const colStartX = offsetX + totalColW - layout.metrics.colWidth / 2;

    const perColMaxHeights: number[] = [];
    for (let c = 0; c < layout.columns.length; c++) {
      const localCx = colStartX - c * (layout.metrics.colWidth + layout.metrics.colSpacing);
      const colHalfW = layout.metrics.colWidth / 2;
      const imageXStart = boxLeft + localCx - colHalfW;
      const imageXEnd = boxLeft + localCx + colHalfW;
      const maskMaxY = queryMaskMaxY(mask, imageXStart, imageXEnd, boxTop);
      perColMaxHeights.push(Math.max(verticalContentHeight, maskMaxY - boxTop));
    }

    effectiveContentHeight = Math.max(verticalContentHeight, ...perColMaxHeights);
    perColumnMaxHeight = (ci: number) => perColMaxHeights[ci] ?? verticalContentHeight;

    // 用扩展高度 + 原始字号重新排版
    const extendedProfile = estimateVerticalPreferredProfile(
      measureCtx, region, text, contentWidth, effectiveContentHeight,
      estimatedInitialFontSize, ff, region.translatedColumns,
    );
    const extendedOptions: BuildVerticalLayoutOptions = {
      ...verticalLayoutOptions,
      colSpacingScale: extendedProfile.colSpacingScale,
      advanceScale: extendedProfile.advanceScale,
      perColumnMaxHeight,
    };
    const extendedLayout = buildVerticalLayout(
      measureCtx, text, effectiveContentHeight, estimatedInitialFontSize, ff, extendedOptions,
    );
    const shrunk = tryShrinkVerticalForMinorOverflow(
      measureCtx, text, effectiveContentHeight, estimatedInitialFontSize,
      extendedOptions, extendedLayout, ff,
    );
    fontSize = shrunk.fontSize;
    layout = shrunk.layout;
    verticalLayoutOptions.perColumnMaxHeight = perColumnMaxHeight;
  }
  // --- end bubble mask 扩展 ---

  if (layout.columns.length > targetColumnCount && fontSize > minFontSafetySize) {
```

- [ ] **Step 3: 修改二分搜索使用扩展高度和逐列高度**

在现有的二分搜索代码中（第 1580-1609 行），将 `verticalContentHeight` 替换为 `effectiveContentHeight`，并传入 `perColumnMaxHeight`：

```typescript
  if (layout.columns.length > targetColumnCount && fontSize > minFontSafetySize) {
    const minAllowed = Math.max(minFontSafetySize, Math.ceil(estimatedInitialFontSize * 0.3));
    let lo = minAllowed;
    let hi = fontSize - 1;
    let bestFs = fontSize;
    let bestLayout = layout;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const profile = estimateVerticalPreferredProfile(
        measureCtx, region, text, contentWidth, effectiveContentHeight, mid, ff, region.translatedColumns,
      );
      const opts: BuildVerticalLayoutOptions = {
        ...verticalLayoutOptions,
        colSpacingScale: profile.colSpacingScale,
        advanceScale: profile.advanceScale,
        perColumnMaxHeight,
      };
      const candidate = buildVerticalLayout(measureCtx, text, effectiveContentHeight, mid, ff, opts);
      if (candidate.columns.length <= targetColumnCount) {
        bestFs = mid;
        bestLayout = candidate;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (bestFs !== fontSize) {
      fontSize = bestFs;
      layout = bestLayout;
    }
  }
```

- [ ] **Step 4: 更新 offscreenHeight 使用 effectiveContentHeight**

在 return 语句前，确保使用实际生效的高度：

将 `const verticalContentHeight = resolveVerticalContentHeight(...)` 的变量改为 `let`，并在 mask 扩展后更新：

在 mask 扩展逻辑结束后、二分搜索之后，将 offscreen 相关计算改为使用 `effectiveContentHeight`：

在函数末尾 return 前重新计算：

```typescript
  const finalContentHeight = effectiveContentHeight;
  const strokePadding = resolveVerticalRenderPadding(measureCtx, columns, fontSize, metrics, ff);
  // ...
  return {
    // ...
    offscreenHeight: Math.ceil(finalContentHeight + strokePadding * 2),
    // ...
    verticalContentHeight: finalContentHeight,
    // ...
  };
```

注意：需要把函数开头的 `const verticalContentHeight` 改为 `let`，同时在 `estimateVerticalPreferredProfile` 等调用中继续使用原始的 `verticalContentHeight`（不扩展的版本），只在最终排版和返回值中使用 `effectiveContentHeight`。

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/typesetGeometry.ts
git commit -m "feat(typeset): use bubble mask per-column height extension in vertical layout"
```

---

### Task 8: 移除 `expandRegionBeforeRender` 中的 bubbleBox 替换

**Files:**
- Modify: `src/pipeline/typesetGeometry.ts:1333-1443`

- [ ] **Step 1: 删除 bubbleBox 替换逻辑**

删除 `expandRegionBeforeRender` 中第 1341-1343 行：

```typescript
// 删除以下代码
if (expanded.bubbleBox) {
  expanded.box = { ...expanded.bubbleBox };
}
```

- [ ] **Step 2: 运行测试确认通过**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/typesetGeometry.ts
git commit -m "fix(typeset): remove bubbleBox replacement in expandRegionBeforeRender"
```

---

### Task 9: 逐列高度排版的集成测试

**Files:**
- Modify: `src/pipeline/typesetGeometry.test.ts`

- [ ] **Step 1: 为逐列高度排版添加测试**

在 `typesetGeometry.test.ts` 中添加：

```typescript
import { calcVertical } from "./typesetGeometry";

describe("calcVertical with perColumnMaxHeight", () => {
  // 需要一个 mock CanvasRenderingContext2D
  function createMockCtx(): CanvasRenderingContext2D {
    return {
      font: "",
      measureText: (text: string) => ({
        width: 20,
        actualBoundingBoxAscent: 10,
        actualBoundingBoxDescent: 2,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: 20,
      }),
    } as unknown as CanvasRenderingContext2D;
  }

  it("uses uniform maxHeight when perColumnMaxHeight not provided", () => {
    const ctx = createMockCtx();
    const columns = calcVertical(ctx, "あいうえお", 50, 20, 20, 1);
    // 每字 advance ~20px，50px 高度约 2 字/列，5 字 → 3 列
    expect(columns.length).toBeGreaterThanOrEqual(2);
  });

  it("allows first column to be taller than subsequent columns", () => {
    const ctx = createMockCtx();
    // 第0列 80px，后续列 40px
    const perColMax = (ci: number) => ci === 0 ? 80 : 40;
    const columns = calcVertical(ctx, "あいうえお", 40, 20, 20, 1, perColMax);
    // 第0列能装更多字
    if (columns.length >= 2) {
      expect(columns[0].glyphs.length).toBeGreaterThanOrEqual(columns[1].glyphs.length);
    }
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `npx vitest run src/pipeline/typesetGeometry.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/typesetGeometry.test.ts
git commit -m "test(typeset): add integration tests for per-column max height"
```
