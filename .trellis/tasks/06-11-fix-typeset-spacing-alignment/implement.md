# 系统性修复排版间距与列对齐 Implement

## Checklist

- [x] 扩展类型契约
  - [x] 在 `src/types.ts` 新增 `SourceTextLineGeometry`。
  - [x] 给 `TextRegion` 增加可选 `sourceLineGeometries`。

- [x] 保留源列几何
  - [x] 在 `src/pipeline/textlineMerge/index.ts` 从排序后的 `InternalQuad` 生成 `sourceLineGeometries`。
  - [x] 更新/新增 textline merge 测试，验证竖排顺序为右到左，且 geometry 字段存在。
  - [x] 更新 `cloneRegionForTypeset` 深拷贝新增字段。
  - [x] 添加 clone 测试，验证修改 clone 不影响原 region。

- [x] 抽出共享列位置 helper
  - [x] 在 `src/pipeline/typeset/fontFit.ts` 增加列组 positioning helper，供 render/debug/per-column mask 共用。
  - [x] 替换 `renderVertical` 与 `buildVerticalDebugColumnBoxes` 中重复的列中心计算。
  - [x] 添加单元测试保证 render/debug 使用同一套 x 坐标规则。

- [x] 源几何优先的列距与 anchor 规则
  - [x] 实现源几何 profile 解析：列数匹配、pitch/gap/center 可信性检查。
  - [x] 修改 `estimateVerticalPreferredProfile` 或新增 wrapper，让源 pitch 推导 `colSpacingScale`。
  - [x] 给 `BuildVerticalLayoutOptions` 增加列组 anchor 信息。
  - [x] 修改 `computeFullVerticalTypeset` 在源几何可用时传入 anchor/profile。
  - [x] 保持 fallback 到现有规则，但避免高上限导致铺满式列距。

- [x] 字距规则收敛
  - [x] 利用源列高度/字符数生成 per-column advance 目标或上限。
  - [x] 避免通过全局常量直接压缩所有字距。
  - [x] 为单列长句/多列 source profile 添加测试。

- [ ] Debug 与 benchmark 验证
  - [ ] 可选增强 debug log：记录 source geometry profile、resolved col spacing、anchor。
  - [x] 每个关键规则变更后运行至少一轮目标单测；关键里程碑后运行完整 bench 链路。
  - [x] 每轮 bench 后检查字号、列数匹配、单列样本和原本低偏差样本，避免为了修复多列间距牺牲正常区域。
  - [x] 运行 `npm run test -- --runInBand` 不适用时改用目标 vitest 命令。
  - [x] 运行 `npx vitest run tests/pipeline/typeset/fontFit.test.ts tests/pipeline/typeset/geometry.test.ts tests/pipeline/textlineMerge/mergePredicates.test.ts`。
  - [x] 运行 `npm run build`。
  - [x] 运行 `npm run bench:bake-node`。
  - [x] 运行 `npm run bench:render`。
  - [x] 运行 `npm run bench`。
  - [x] 对比最新报告：
    - [x] 多列 `signedColumnGapNormMean` 向 0 收敛。
    - [x] 多列 `columnPitchRatioMean` 向 1 收敛。
    - [x] `Column Count Match Rate >= 97.8%`。
    - [x] `Composite Score`、`Column IoU` 无明显回退。

## Bench Results

最终采用报告：`benchmark/reports/2026-06-11T06-33-27-796Z`。

- 初始基线 `benchmark/reports/2026-06-11T05-38-14-582Z`：Composite `0.7719`，Column IoU `0.6172`，Font Size Error `0.0978`，Signed Column Gap Norm `+0.0585`，Column Pitch Ratio `1.0436`，Signed Char Advance Norm `+0.0279`，Column Count Match `97.8%`。
- 最终结果：Composite `0.7795`，Column IoU `0.6303`，Font Size Error `0.0971`，Signed Column Gap Norm `+0.0145`，Column Pitch Ratio `0.9943`，Signed Char Advance Norm `+0.0276`，Column Count Match `97.8%`。
- 多列可比区域：`signedColumnGapNormMean` 均值 `+0.0263`，中位数 `+0.0278`，`gap > +0.05` 为 `7` 个，`gap < -0.05` 为 `6` 个，未见单边结构性偏松。
- 原本 gap 正常的 `25` 个区域平均 score delta `+0.0001`，无 `abs(gap) > 0.1` 的新增异常。

## Risky Files

- `src/types.ts`: 数据契约变更，需保持字段可选。
- `src/pipeline/textlineMerge/index.ts`: merge 输出 contract。
- `src/pipeline/typeset/fontFit.ts`: 列距、字距、debug box 核心规则。
- `src/pipeline/typeset/index.ts`: vertical pipeline 总装配。
- `src/pipeline/typeset.ts`: 实际 render 与 debug log 生成。
- `benchmark/typeset/src/*`: 若 fixture/debug 字段扩展，需要保持旧 fixture 兼容。

## Rollback Points

- 如果新增源几何字段导致跨层回归，可先保留字段但禁用源 geometry profile，只使用 debug 输出观察。
- 如果 anchor 对 rotated quad 造成偏移，先限制 source anchor 只对非旋转/小角度 region 生效。
- 如果 char advance 规则引发列数回退，先交付列距/anchor 修复，字距异常作为第二子任务处理。

## Review Gate

实现前需确认：

- PRD 已接受“优先复刻源列几何”。
- 本设计允许扩展 `TextRegion` 携带源行/列几何。
- 用户同意进入 Phase 2 后再开始改代码。
