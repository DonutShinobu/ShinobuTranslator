# 系统性修复排版间距与列对齐 Design

## Direction

本任务以“复刻源检测列几何”为第一原则。多列竖排不再默认把列铺满可用 region/bubble 宽度，而是优先以 merge 阶段保留下来的源列中心、pitch、列宽和整体中心作为排版锚点。只有源列几何不可用或不可信时，才退回现有的紧凑/内容宽度规则。

## Current Architecture

- OCR 输出单行/单列 `TextRegion`。
- `mergeTextLines` 把多个 OCR 行/列合并为一个 `TextRegion`，当前只保留合并后的 `box/quad`、`sourceText` 和 `originalLineCount`。
- `computeFullVerticalTypeset` 使用 `sourceText`/`translatedColumns` 解析目标列数，并调用 `estimateVerticalPreferredProfile` 得到 `advanceScale` 和 `colSpacingScale`。
- `estimateVerticalPreferredProfile` 当前多列逻辑会用可用宽度反推列距，倾向铺满区域宽度。
- `renderVertical` 和 `buildVerticalDebugColumnBoxes` 使用相同的居中公式放置列；debug 坐标通过 `mapOffscreenRectToCanvasQuad` 映射到画布。

## Proposed Data Contract

在 `TextRegion` 上新增可选字段，用于保存合并前的源文本行/列几何：

```ts
export type SourceTextLineGeometry = {
  text: string;
  direction: TextDirection;
  box: Rect;
  quad?: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  fontSize?: number;
};

export type TextRegion = {
  // existing fields...
  sourceLineGeometries?: SourceTextLineGeometry[];
};
```

字段命名用 `sourceLineGeometries` 而不是 `sourceColumnGeometries`，因为 merge 阶段同时服务横排和竖排；本任务只消费其中 `direction === "v"` 的数据。顺序沿用 merge 后阅读顺序：竖排从右到左，横排从上到下。

## Source Geometry Preservation

- 在 `textlineMerge/index.ts` 的 `buildMergedRegion` 中，从排序后的 `InternalQuad` 构建 `sourceLineGeometries`。
- 几何计算从 `InternalQuad.pts` 派生：
  - `quad`: `pts`
  - `box`: quad AABB
  - `centerX/centerY`: centroid
  - `width/height`: quad dimensions 或 AABB 尺寸，竖排 pitch 主要依赖 center。
- 在 `cloneRegionForTypeset` 中深拷贝 `sourceLineGeometries`，防止排版路径修改或丢失源几何。
- 翻译阶段使用对象展开保留未知字段，现有 `translate.ts` 已符合，但测试需要覆盖新增字段不会丢失。

## Vertical Layout Rule

新增一个源几何 profile 解析层，优先级高于当前“铺满宽度”规则：

1. 若 `region.sourceLineGeometries` 中有与目标列数相匹配的竖排源列，则计算源列 profile。
2. 源列 profile 包含：
   - `sourceCenterXMean` 或源列整体中心
   - adjacent pitch 中位数
   - adjacent gap 中位数
   - 源列宽度中位数
   - 每列 top/bottom/height，用于后续字距与 Y 对齐参考
3. `colSpacingScale` 不再由 `contentWidth` 反推铺满，而由目标 pitch/gap 推导：
   - `targetPitch = medianSourcePitch`
   - `targetSpacing = targetPitch - metrics.colWidth`
   - clamp 到合理范围，只作为防崩保护，不作为主要行为来源
4. 当源几何不可用、列数不匹配、pitch 不可信（非有限、过小、过大、排序异常）时，回退到现有 `contentWidth` 规则，但上限更保守，避免系统性铺太开。

## Column Anchor Rule

仅调整列距仍可能保留整体偏移，因此需要把“列距”和“列组锚点”分开：

- `buildVerticalDebugColumnBoxes` 和 `renderVertical` 当前把列组居中到内容宽度。
- 新增 layout anchor 选项：
  - 默认：`center`，保持现有行为。
  - 源几何可用：使用源列组中心相对 merged region 的位置作为 anchor。
- anchor 在 offscreen 坐标系中表达，避免 render/debug 两边各算一套。
- render 与 debug 必须共用同一个列位置计算 helper，避免 overlay 与实际贴字产生偏差。

## Char Advance Rule

字距问题不以全局调小 `verticalAdvanceTightenRatio` 解决。规则优先级：

1. 源列高度与源列字符数可用时，计算源列平均 advance。
2. 对应目标列使用源平均 advance 作为上限/目标参考，结合 font metrics 的最小可读 advance。
3. preferred columns 和 split columns 保持禁则处理；如果译文列字符数明显变多，允许缩小字号或换列，不优先拉大字距。
4. 单列长句异常拉伸应通过 per-column height / advance 约束收敛，而不是影响所有列。

## Benchmark And Debug

- 继续使用当前 browser render debug 作为指标来源。
- signed 指标已可判断方向，本任务不修改“绝对值指标”问题。
- 可考虑增强 debug log 输出源几何 profile / anchor / resolved spacing，便于解释后续结果。
- 验收重点看多列 subset：
  - `signedColumnGapNormMean` 向 0 收敛
  - `columnPitchRatioMean` 向 1 收敛
  - `signedCharAdvanceNormMean` 不出现新系统偏移

## Compatibility

- 新字段可选，旧 fixture、旧 pipeline 数据仍可运行。
- 没有源几何时走 fallback。
- 不改变 translator API；LLM 仍只接收 target column count。
- 不改变 bubble mask height extension，但计算 per-column mask 高度时需要使用相同列位置 helper。

## Risks

- 如果检测源列本身错位，复刻源几何会放大检测误差。以用户决策为准：benchmark 阶段优先复刻源检测列几何。
- Rotated quad 路径需要谨慎，anchor 只能在 offscreen/content 坐标里算，再通过现有 transform 映射。
- 新字段跨 `merge -> translate -> typeset -> debug`，需要测试 clone 和对象展开是否保留。
