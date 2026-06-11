# 系统性修复排版间距与列对齐

## Goal

系统性修复竖排排版中的列间距、字间距、列对齐问题。优先调整排版规则与几何锚定逻辑，只有在规则正确后才做参数微调。

## Background

- 最新 benchmark 已在 `benchmark/reports/2026-06-11T05-38-14-582Z/` 生成。
- 当前数据集：8 张图片，45 个 region，0 个 skipped。
- 当前总体指标：
  - Composite Score: `0.7719`
  - Column IoU: `0.6172`
  - Column Count Match: `97.8%`
  - Signed Column Gap Norm: `+0.0585`
  - Column Pitch Ratio: `1.0436`
  - Signed Char Advance Norm: `+0.0279`
- 多列样本单独看，列间距偏松更明显：22 个可比多列样本中 17 个 `gap > +0.05`，`signedColumnGapNormMean` 均值约 `+0.1197`，中位数约 `+0.1333`。
- 字间距没有同等强度的全局单向偏移，但存在局部异常拉伸：可比样本均值约 `+0.0306`，少数 region 的 `charAdvanceRatioMean` 高于 `2.0`。
- 当前 benchmark 日志已包含 signed 指标，能够判断偏大或偏小；本任务不需要重新修复“只能看绝对值”的指标问题。

## Confirmed Code Facts

- 竖排核心排版入口是 `src/pipeline/typeset/index.ts` 的 `computeFullVerticalTypeset`。
- 列宽、列距、字距、换列、profile 估算集中在 `src/pipeline/typeset/fontFit.ts`。
- 实际竖排绘制在 `src/pipeline/typeset.ts` 的 `renderVertical`。
- benchmark 通过 `benchmark/typeset/src/run-bench.ts` 读取 browser render debug，并通过 `benchmark/typeset/src/metrics.ts` 计算 signed column gap、pitch ratio、signed char advance 等指标。
- 当前最可疑的规则问题：`estimateVerticalPreferredProfile` 会在多列时用内容宽度反推目标列距，等价于倾向把列铺满可用宽度；这与“保持原文列结构/列 pitch”目标可能冲突，并能解释多列样本的结构性偏松。
- `mergeTextLines` 在合并时拥有排序后的子 `InternalQuad`，但当前 `TextRegion` 只保存 `sourceText`、`originalLineCount` 和合并后的 `box/quad`，没有保留每个源列的几何。
- `cloneRegionForTypeset` 当前只深拷贝 `box/quad`，新增的源列几何字段也必须在这里深拷贝，否则排版路径会丢失该信息。

## Requirements

- 修复策略必须优先从排版规则入手：
  - 列锚定应优先复刻源检测列几何，尽量保留源列中心、源列 pitch、整体中心和列序。
  - 只有源列几何明显不可靠、列数不匹配、或译文长度导致必须换列时，才退回视觉自然的紧凑规则。
  - 多列布局不应默认把列铺满整个气泡/region 宽度。
  - 字距应由字体度量、源文字高度、目标列高度共同约束，避免少数字符或单列长句被异常拉伸。
  - 列对齐应区分整体偏移、列间距偏移和字符纵向 advance 偏移，避免用一个参数补偿多个问题。
- 参数调整只能作为第二阶段微调，不能替代规则修复。
- 修改必须保留现有竖排功能：CJK 标点替换、禁则处理、preferred columns、bubble mask per-column height extension、rotated quad 支持。
- benchmark 结果必须能用 signed 指标证明方向性改善。
- 实现过程需要多轮 benchmark 反馈：每次关键规则变更后都要检查是否影响字号、列数匹配和原本正常的单列/低偏差样本。

## Acceptance Criteria

- [ ] `npm run bench:bake-node`、`npm run bench:render`、`npm run bench` 能完整跑通。
- [ ] 多列样本的 `signedColumnGapNormMean` 明显向 0 收敛，不能继续呈现系统性偏松。
- [ ] 多列样本的 `columnPitchRatioMean` 明显向 1 收敛。
- [ ] `signedCharAdvanceNormMean` 不出现新的系统性偏松或偏紧；现有局部异常应减少或有明确解释。
- [ ] `Column Count Match Rate` 不下降，目标保持不低于当前 `97.8%`。
- [ ] `Composite Score` 与 `Column IoU` 不因列距修复产生明显回退。
- [ ] 字号指标不明显回退：`avgFontSizeError` 不应显著高于当前 `0.0978`，异常 region 需解释。
- [ ] 原本正常区域不应被牺牲：单列样本和 `|signedColumnGapNormMean| <= 0.05` 的多列样本不应出现明显新偏移。
- [ ] 新增或更新单元测试覆盖列距规则、字距规则、列对齐/debug 坐标一致性中的高风险路径。

## Out Of Scope

- 不把 horizontal typeset 作为本任务主要目标，除非修改共享规则时必须保证不回退。
- 不重做 OCR、检测、merge、bubble detection。
- 不把“signed 指标缺失/只能看绝对值”作为待修问题；当前日志已经能判断偏大偏小。
- 不以单纯调整 `verticalColumnSpacingRatio`、`minVerticalAdvanceScale` 等常量作为主要方案。

## Open Questions

- 暂无阻塞性产品问题。技术设计阶段需要确认运行时可用的源列几何数据范围。
