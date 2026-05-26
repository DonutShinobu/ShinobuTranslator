# 去字流程优化：白描边残留 — 实施计划

## Checklist

- [x] 1. 在 `algorithms.ts` 中实现 `detectOutlineWidth()` 函数
  - 背景亮度使用 Q1（第25百分位数），避免描边像素抬高估计
  - mask 边界像素检测（8邻域有 mask 外像素）
  - 向外扫描允许穿过抗锯齿过渡区（gray > bgMedian 即继续），只有到达亮像素（gray > bgMedian + 40）才算描边
  - 判定描边存在（> 50% 边界像素）并测量宽度（中位数）
  - maxScanDist 基于 textSize：`max(4, floor(textSize * 0.3))`

- [x] 2. 在 `index.ts` 的 per-region 循环中调用 `detectOutlineWidth()`
  - 无描边：baseRatio = 0.1（10%）
  - 有描边：baseRatio = 0.05（5%）+ outlineWidth × 2叠加
  - 插入位置：refineRegionMask 完成后、dilateSize 计算前

- [x] 3. 用黑字白描边 + 彩色背景的漫画图片测试
  - 效果OK

- [x] 4. 修复抗锯齿过渡区阻断扫描的问题
  - 原算法在第一个非亮像素处停止，永远无法穿过抗锯齿到达白描边
  - 修改为：允许 gray > bgMedian 的像素通过（过渡区），gray ≤ bgMedian 停止（背景）

- [x] 5. 修复 bgMedian 被描边像素抬高的问题
  - 从中位数改为 Q1（第25百分位数）

- [x] 6. 修复 maxScanDist 对小文字过短的问题
  - 从 `max(2, regionRect*0.2)` 改为 `max(4, textSize*0.3)`
  - 传入 textSize 参数

- [x] 7. 确认最终膨胀策略
  - 无描边：10% base
  - 有描边：5% base + outlineWidth叠加

## Validation Commands

```bash
npx tsc --noEmit
npm run build
```

## Risky Files / Rollback Points

- `src/pipeline/maskRefinement/algorithms.ts` — 新增函数，不修改现有函数 → 低风险
- `src/pipeline/maskRefinement/index.ts` — 修改 per-region 循环中的 dilateSize 计算 → 中风险
  - 回退：恢复原始 `dilateSize` 计算公式即可