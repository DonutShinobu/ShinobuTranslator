# 解耦竖排字号与字距 Implement

## Ordered Checklist

- [x] 创建 task 并记录 PRD/design/implement。
- [x] 盘点现有 benchmark 证据：
  - old stable report: `benchmark/reports/2026-06-11T06-53-18-282Z`
  - benchmark bubble report: `benchmark/reports/2026-06-11T07-15-31-389Z`
  - early fitting reorder report: `benchmark/reports/2026-06-11T07-18-15-345Z`
  - glyph-count advance experiment report: `benchmark/reports/2026-06-11T07-23-06-493Z`
- [ ] 确认当前工作区中实验性改动状态，撤掉不符合设计的 trick。
- [ ] Benchmark 贴近真实流程：
  - [ ] `shinobuRenderFixtureDebug` 中加载图片后调用 `detectBubbles + matchRegionsToBubbles`。
  - [ ] 跑 `bench:render + bench`，作为新 benchmark 基线。
- [ ] Advance contract：
  - [ ] 在 `fontFit.ts` 中拆出 source advance 计算，使用真实 glyph count。
  - [ ] 保证 `countTextLength` 不再直接决定实际 glyph center advance。
  - [ ] 增加 `へぇ`/小假名 source advance 单元测试。
- [ ] Fitting 顺序：
  - [ ] 调整为先用 base layout 判断是否超列；
  - [ ] 超列且有 bubbleMask 时先扩展 fit height；
  - [ ] 扩展只影响 fit height/列数判断，不拉大 advance；
  - [ ] 扩展后仍超列时再 shrink。
- [ ] Benchmark 观察：
  - [ ] 跑 `npx tsc --noEmit`。
  - [ ] 跑目标 vitest。
  - [ ] 跑 `npm run bench:render`。
  - [ ] 跑 `npm run bench`。
  - [ ] 分别输出四项指标：列间距、字间距、字大小、列对齐。
  - [ ] 专门检查 `4.jpg` / `へぇ`：fitted font size、glyph center advance、fontSizeRatio、charAdvance。
- [ ] 回归检查：
  - [ ] 原本正常单列区域没有大面积 charDy/advance 回退。
  - [ ] 多列 gap/pitch 不因 advance 解耦回退。
  - [ ] fixture 文本错配区域单独标记，不作为排版规则依据。

## Validation Commands

```bash
npx vitest run tests/pipeline/typeset/fontFit.test.ts tests/pipeline/typeset/geometry.test.ts tests/pipeline/textlineMerge/mergePredicates.test.ts
npx tsc --noEmit
npm run bench:render
npm run bench
```

必要时重新 bake：

```bash
npm run bench:bake-node
```

## Risky Files

- `src/pipeline/typeset/fontFit.ts`: 字距/advance 计算核心。
- `src/pipeline/typeset/index.ts`: vertical fitting 编排，容易影响字号与列数。
- `src/pipeline/bake.ts`: benchmark fixture render 与真实 pipeline 对齐。
- `benchmark/typeset/src/render-result.ts`: benchmark source geometry bridge。
- `tests/pipeline/typeset/fontFit.test.ts`: source advance 和 positioning 契约测试。

## Review Gate Before Start

- 用户已明确要求按“字号与字距解耦”方案边应用边 benchmark。
- 当前 plan 不再引入逐列 source center 绑定。
- 当前 plan 不按 composite 权重决策，而是分别观察四类指标和贴图观感。
## 2026-06-11 Update

- 已让 fixture render 跑真实 bubble matching，并把 benchmark source columns 转成 `sourceLineGeometries`。
- 已拆分竖排 `layoutContentHeight` 与 `renderContentHeight`：bubble 扩展只参与放得下/是否缩字的判断，有可靠 source geometry 时最终渲染高度仍复刻源列。
- 已拆分 `fontSize` 与竖排 glyph advance：source geometry 模式使用真实 glyph count、source advance floor、source actual-box scale、default advance base。
- 已修正 benchmark 几何指标的列配对：IoU/Dx/上下边/逐字 y 统一按右到左空间顺序匹配，避免标注数组顺序误判列对齐。
- 最新验证：`npx vitest run tests/benchmark/metrics.test.ts tests/pipeline/typeset/columns.test.ts tests/pipeline/typeset/fontFit.test.ts tests/pipeline/typeset/geometry.test.ts tests/pipeline/textlineMerge/mergePredicates.test.ts tests/pipeline/typeset/typesetGeometry.test.ts`、`npx tsc --noEmit`、`npm run bench:render`、`npm run bench`。
- 最新报告：`benchmark/reports/2026-06-11T07-58-54-834Z`。
- 关键指标：Column IoU `0.8216`、Column Dx Norm `0.0307`、Font Size Error `0.0533`、Signed Column Gap Norm `+0.0197`、Char Dy Norm `0.1613`、Signed Char Advance Norm `-0.0119`、Column Count Match `97.8%`。
- Overlay 拼图：`benchmark/reports/2026-06-11T07-58-54-834Z/overlay-contact-sheet.png`。

## 2026-06-11 Fixture Rebake / Audit Update

- 确认旧 fixtures 的根因不是 renderer 顺序，而是 bake 时 `groundTruth.columns` 来自 pre-merge center-in-box 匹配，未绑定 merge group 的 `sourceLineGeometries`。
- 新增 `bench:audit-fixtures`，默认报告 fixture 健康状况，`--strict` 将 `text_mismatch`、`column_count_mismatch`、`spatial_order_mismatch` 都视为失败。
- `bench:bake-node` / `bench:bake` 支持 `--out-dir`，用于先把新 fixture 写到报告目录，再审计、备份、复制到正式目录。
- 旧正式 fixtures 审计：`total=45 clean=26 nonClean=19 usable=42 rejected=3`，问题为 `column_count_mismatch=1 text_mismatch=5 spatial_order_mismatch=13`。
- 非破坏性 rebake 输出：`benchmark/reports/2026-06-11T21-55-36-330-fixtures-rebake`；严格审计 `total=45 clean=45 nonClean=0 usable=45 rejected=0`。
- 覆盖前备份：`benchmark/reports/2026-06-11T21-55-36-330-fixtures-backup`；正式目录覆盖后严格审计同样 `45/45 clean`。注意 `benchmark/typeset/fixtures/` 被 `.gitignore` 忽略，这是本地数据修复。
- 最新报告：`benchmark/reports/2026-06-11T13-57-06-879Z`；Composite `0.9257`、Column IoU `0.8507`、Font Size Error `0.0355`、Signed Column Gap Norm `+0.0083`、Signed Char Advance Norm `-0.0028`、Column Count Match `97.8%`、Source Geometry `45/0`、Spatial mismatches `0`。
- 裁剪检查表：`benchmark/reports/2026-06-11T13-57-06-879Z/region-crops.png`。
- 验证：`npm run bench:audit-fixtures -- --strict`、`npm run bench:render`、`npm run bench`、`npx tsc --noEmit`、目标 Vitest、`npm run test` 均通过。
