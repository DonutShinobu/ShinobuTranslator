# 解耦竖排字号与字距

## Goal

系统性修复竖排排版里字号、字距、气泡高度扩展互相牵连的问题，让贴图更接近源图：字号由源文字几何/检测字号决定，字距由源列字符中心间距或可靠 fallback 决定，气泡扩展只增加可用高度，不反向拉大字距。

## User Value

- 短竖排（如 `へぇ`、`あっ！`）不再因为浏览器 font box advance 被误判溢出而缩得过小。
- 气泡向下扩展生效后，字号可以恢复，但字符中心距不能被拉得过宽。
- 多列区域继续保持上一轮已修复的列间距/列 pitch 收敛，不因字距调整回退。
- benchmark 更贴近真实 pipeline，能观察 bubble mask 对排版的影响。

## Confirmed Facts

- 原 benchmark fixture render 没有调用 `detectBubbles + matchRegionsToBubbles`，因此 fixture region 没有 `bubbleMask`，无法覆盖真实流程里的气泡高度扩展。
- 修改 benchmark render 使 fixture 也带 `bubbleMask` 后，`4.jpg` 的 `へぇ` 从 `fittedFontSize=37` 提升到 `53`，font size ratio 从 `0.627` 提升到 `0.898`，说明气泡扩展对该问题有效。
- 直接把 vertical fitting 顺序改成“先 bubble 扩展再 shrink”后，全局字距/charDy/IoU 明显回退：`Signed Char Advance Norm 0.0427 -> 0.1378`，`CharDy 0.3340 -> 0.6366`，说明扩展高度被错误用于放大 advance。
- `へぇ` 的绿色源字符中心距约 `59`；带 bubble 后红色渲染字符中心距变成 `84`。根因是实际 glyph advance 与 fontSize/browser font box 耦合，而不是单纯字号估计错误。
- `countTextLength("へぇ")` 会将小假名按半宽长度计算，这适合列容量/翻译长度估计，但不适合实际 glyph center advance。
- 当前已验证过的列距修复让 `Signed Column Gap Norm` 从 `+0.0585` 收敛到约 `+0.0145`，这部分不应被本任务破坏。

## Requirements

- Benchmark fixture render 必须尽量贴近真实流程：加载图片、转换 fixture region、匹配 bubble mask 后再 typeset。
- 竖排 fitting 中必须明确区分：
  - `fontSize`: 字形大小；
  - `advance`: 字符中心距；
  - `contentHeight`: 文本框可用高度；
  - `bubble-extended height`: 只用于避免拆列/提供更多容器空间。
- Source geometry 可用时，advance 目标优先来自源列几何的真实 glyph 数量：`sourceLineHeight / [...textWithoutWhitespace].length`。
- `countTextLength` 仍可用于列容量、翻译长度、短/长文本估计，但不得作为实际 glyph center advance 的唯一口径。
- Bubble 扩展后不得因为 `contentHeight` 变大而自动拉大字距；字距需要由源 advance 或字体 fallback 控制。
- 保留现有列间距/source pitch 修复，避免重新引入结构性偏松。

## Acceptance Criteria

- [ ] `benchmark/typeset` fixture render 侧带 `bubbleMask`，报告能反映真实流程中的气泡高度扩展。
- [ ] 对 `4.jpg` / `へぇ`：字号比旧无 bubble benchmark 明显恢复，同时字符中心距接近源图（目标接近 `59`，不得维持 `84+` 的过宽状态）。
- [ ] 四项指标分别观察，不按 composite 权重做决策：
  - 列间距：`Signed Column Gap Norm` 不出现明显回退；
  - 字间距：`Signed Char Advance Norm` 不因 bubble 扩展显著变大；
  - 字大小：`Font Size Error` 不劣于 benchmark 带 bubble 后的基线；
  - 列对齐：`Column IoU` / `ColumnDx` 不出现大面积回退。
- [ ] 原本正常的单列区域不能因为 advance 改动出现大面积 charDy 回退。
- [ ] `npx tsc --noEmit` 通过。
- [ ] 目标单测通过：`npx vitest run tests/pipeline/typeset/fontFit.test.ts tests/pipeline/typeset/geometry.test.ts tests/pipeline/textlineMerge/mergePredicates.test.ts`。
- [ ] 至少跑两轮 benchmark：
  - benchmark 贴近真实流程后的基线；
  - advance/fitting contract 调整后的结果。

## Out Of Scope

- 本任务不处理 OCR/merge 把源文本和 ground truth 列文本错配的问题（如某些 fixture 中 `sourceText` 与 `groundTruth.columns.text` 不一致）。
- 本任务不引入逐列 source center 绑定来修复列顺序错配。
- 本任务不重新调整翻译列 rebalancing 策略。
- 本任务不以 composite score 权重作为唯一优化目标。

## Open Questions

- 无阻塞问题。用户已要求按“字号与字距解耦”的方案边应用边 benchmark 观察。
