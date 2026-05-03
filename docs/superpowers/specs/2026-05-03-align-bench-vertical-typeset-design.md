# 对齐 Benchmark 垂直排版预测框与实际 Pipeline

## 目标

将 `run-bench.ts` 中垂直文本预测框的生成逻辑与浏览器扩展 `typeset.ts` 的实际 pipeline 完全对齐，使排版逻辑修改后 benchmark 指标自动反映变化。

## 当前问题

`run-bench.ts` 调用 `computeVerticalGeometry()`，该函数缺少实际 pipeline 中的以下步骤：

1. **`resolveVerticalPreferredColumns`** — 解析模型返回的 translatedColumns，计算 preferred columns 和 source 信息
2. **`expandRegionBeforeRender`** — 根据文本量扩展区域边界
3. **preferred column sources 解析** — `computeVerticalGeometry` 将所有 source 标记为 `'model'`，实际 pipeline 区分 `'model'` / `'split'`

## 方案

### 新增函数：`computeFullVerticalTypeset`

在 `typesetGeometry.ts` 中新增，封装 `typeset.ts` 垂直路径的完整计算逻辑（不含渲染）。`typeset.ts` 和 `run-bench.ts` 都调用它。

#### 输入

```ts
export type FullVerticalTypesetInput = {
  region: TextRegion;
  fontFamily: string;
  measureCtx: CanvasRenderingContext2D;
};
```

#### 输出

```ts
export type FullVerticalTypesetResult = {
  expandedRegion: TextRegion;
  text: string;
  preferredColumnSources?: ColumnSegmentSource[];
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
  initialFontSize: number;
};
```

#### 内部逻辑（按 `typeset.ts` 实际顺序）

1. `resolveVerticalPreferredColumns(region, translated)` → preferred columns + sources
2. 更新 region.translatedColumns
3. 解析 sourceColumns / sourceColumnLengths / singleColumnMaxLength
4. `expandRegionBeforeRender(region, text, measureCtx, fontFamily, noopHLineCount)`
   - 垂直 region 不会触发水平回调，传 no-op
5. `resolveBoxPadding` → contentWidth / contentHeight
6. `resolveVerticalContentHeight`
7. `estimateVerticalPreferredProfile`
8. `buildVerticalLayout` + `tryShrinkVerticalForMinorOverflow`
9. `resolveVerticalRenderPadding` / `resolveAlignment` / `buildVerticalDebugColumnBoxes`

### 文件变更

| 文件 | 变更 |
|------|------|
| `src/pipeline/typesetGeometry.ts` | 新增 `computeFullVerticalTypeset`；保留 `computeVerticalGeometry` 但标注仅供向后兼容（或直接删除，因为唯一调用者是 benchmark） |
| `src/pipeline/typeset.ts` | 垂直路径（第 728-849 行）改为调用 `computeFullVerticalTypeset`，保留渲染和 debug overlay 逻辑 |
| `scripts/benchmark/run-bench.ts` | 替换 `computeVerticalGeometry` + `buildPredColumns` 为 `computeFullVerticalTypeset`，从结果中构建 predColumns |

### `computeVerticalGeometry` 处理

唯一调用者是 `run-bench.ts`，迁移后直接删除。

### `buildPredColumns` 处理

迁移后 `run-bench.ts` 直接从 `FullVerticalTypesetResult` 的 `debugColumnBoxes` + `expandedRegion` 构建 predColumns，`buildPredColumns` 函数删除。

## 范围

- 仅垂直文本，水平文本不在本次范围内
- 不改变 ground truth 的生成方式
- 不改变 metrics 计算逻辑
