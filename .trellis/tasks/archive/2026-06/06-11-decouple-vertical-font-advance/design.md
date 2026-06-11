# 解耦竖排字号与字距 Design

## Architecture Boundary

本任务只修改排版与 benchmark glue：

- `src/pipeline/bake.ts`: fixture render 贴近真实 pipeline，给 fixture region 匹配 bubble mask。
- `src/pipeline/typeset/index.ts`: 调整 vertical fitting 编排顺序，避免先 shrink 再 bubble。
- `src/pipeline/typeset/fontFit.ts`: 拆分竖排 advance 目标与 fontSize/glyph metrics 的职责。
- `benchmark/typeset/src/render-result.ts`: 继续从 ground truth columns 派生 source geometry，保证 benchmark 能覆盖 source geometry path。
- tests: 增加 source advance 口径和 fitting helper 的单元测试。

## Data Flow

### 当前问题流

```text
source geometry / OCR fontSize
-> resolveInitialFontSize
-> buildVerticalLayout
-> glyph advance 由 browser fontBoundingBox / actualBox 推导
-> 如果 advance box 溢出，tryShrinkVerticalForMinorOverflow 缩字号
-> bubbleMask 只在 shrink 后仍超列时才扩展
```

这个流程导致两个问题：

- 无 bubble benchmark 中，短文本因为 advance box 太高被误判溢出，字号被缩小。
- 有 bubble 后，容器高度变大，advanceScale 可能被放大，字距被拉宽。

### 目标问题流

```text
source geometry / OCR fontSize
-> resolve fontSize candidate
-> resolve advance target independently
   source geometry available: sourceHeight / realGlyphCount
   fallback: font metrics bounded by fontSize
-> build layout with stable advance
-> bubbleMask extends fit height only
-> if still exceeds target columns, shrink fontSize
```

## Contracts

### Font Size

- 代表字形大小，不等同于字距。
- 初始来源仍是 OCR/merge 的 `fontSize`、源列宽高、已有 max-by-height/max-by-width 保护。
- Bubble 扩展不应直接放大 fontSize；它只让原本过早 shrink 的字号有机会保留。

### Advance

- 代表竖排字符中心距。
- Source geometry 可用时，计算：

```ts
sourceAdvance = sourceLine.height / realGlyphCount(sourceLine.text)
```

- `realGlyphCount` 使用实际 Unicode code points 去空白后的数量，不使用 `countTextLength` 的半宽口径。
- `countTextLength` 继续用于列容量、翻译长度和 rebalancing。
- Bubble 扩展后的 content height 不能自动成为 advance target；advance target 要保持源几何优先。

### Bubble Height

- `bubbleMask` 查询得到的额外高度只参与“是否可以保持列数/避免拆列”。
- 若不扩展仍超列，应先尝试扩展高度重新 layout。
- 仍超列时才 shrink fontSize。
- 扩展后 layout 不应为了填满高度而拉开字符中心距。

## Compatibility

- `sourceLineGeometries` 是可选字段；不可用时 fallback 到现有字体 metrics。
- Fixture render 里新增 bubble detection 会增加 benchmark render 时间，并产生 ONNX runtime warning；这是贴近真实流程的代价。
- 现有列距修复依赖 `resolveVerticalColumnPositions` 和 source pitch profile，本任务不得移除。

## Trade-offs

- 保守地保持 source advance 可能让某些翻译更长的列看起来不够铺满气泡，但更接近源图。
- 对没有 source geometry 的区域，仍需要字体 metrics fallback，不能保证完全复刻源字距。
- 不修复 fixture 文本错配，避免把 OCR/merge ground truth 噪声误当排版问题。

## Rollback

- 如果 benchmark fixture render 带 bubble 造成不可接受的运行时间，可保留代码但给 benchmark 增加开关；默认仍建议贴近真实流程。
- 如果 advance 解耦导致多列大面积回退，先回退 advance target 应用范围，保留 benchmark bubble 修复。
- 如果 fitting 顺序调整引入全局 charDy 回退，回退顺序调整，改为只在 source advance 稳定后重新启用。
