# 去字流程优化：白描边残留 — 技术设计

## 核心思路

在 per-region mask refinement 循环中，Otsu 生成暗核心 mask 后，检测 mask 边界外是否存在亮色描边环。如果存在，测量描边宽度并增大该 region 的膨胀量；如果不存在，使用较低的基础膨胀量。

## 数据流

```
scaledGray (全图灰度, scaledWidth × scaledHeight)
    ↓
regionMask (per-region 二值 mask, 暗核心 after refineRegionMask)
    ↓
detectOutlineWidth(scaledGray, regionMask, scaledWidth, scaledHeight, baseRect, regionTextSize)
    ↓ 返回 outlineWidth (像素数) 或 0 (无描边)
    ↓
baseRatio = outlineWidth > 0 ? 0.05 : 0.1
dilateSize = baseDilateSize(baseRatio) + outlineWidth × 2
    ↓
dilate(regionMask子区域, dilateSize)
    ↓
finalMask (per-region 膨胀后的 mask)
```

## 描边检测算法

函数签名：`detectOutlineWidth(gray, mask, width, height, regionRect, textSize): number`

### 步骤

1. **计算背景亮度**：在 `regionRect` 范围内，收集所有 mask 外像素的灰度值，取 Q1（第25百分位数）→ `bgMedian`。使用 Q1 而非中位数避免描边像素和抗锯齿像素抬高背景估计。

2. **找 mask 边界像素**：遍历 `regionRect` 内 mask，找到所有 `(mask[i]=1 且 8邻域中至少一个 mask[j]=0)` 的像素 → `boundaryPixels[]`

3. **向外扫描描边宽度（允许穿过抗锯齿过渡区）**：对每个 boundary pixel `(bx, by)`：
   - 在 4 个方向（上下左右）扫描，最大距离 `max(4, floor(textSize * 0.3))`：
     - 从 `(bx, by)` 沿方向步进，每次检查 1 像素
     - `gray > bgMedian + 40` → 标记为亮像素（`reachedBright = true`），继续步进
     - `gray > bgMedian` 且 `gray ≤ bgMedian + 40` → 过渡像素，继续步进（穿过抗锯齿区）
     - `gray ≤ bgMedian` → 背景像素，停止
     - mask 内像素或出界 → 停止
   - 只有 `reachedBright = true` 的扫描方向才计入距离
   - 取 4 方向中最大距离 → `localOutlineDist`

4. **判定描边存在**：
   - 计算有描边距离 > 0 的 boundary pixels 占比 = `outlineRatio`
   - 如果 `outlineRatio > 0.5` → 存在描边

5. **测量描边宽度**：
   - 所有 `localOutlineDist > 0` 的 boundary pixels 的距离取中位数 → `outlineWidth`
   - 返回 `outlineWidth`（若无描边，返回 0）

### 参数

- `BRIGHT_THRESHOLD = 40`：描边像素亮度需高于背景 Q1 40 以上
- `OUTLINE_RATIO_THRESHOLD = 0.5`：超过 50% 的边界像素有描边才认为存在描边
- 扫描最大距离：`max(4, floor(textSize * 0.3))`（基于文字大小，而非区域矩形大小）
- 背景估计：Q1（第25百分位数）而非中位数

### 抗锯齿穿透机制

黑字与白描边之间存在抗锯齿渐变区（灰度 ≈ 80-150），原算法在此处停止。修复方式：允许过渡像素（gray > bgMedian）通过，只要最终到达亮像素（gray > bgMedian + 40）才算描边检测成功。抗锯齿像素被纳入描边宽度测量。

## 膨胀量调整

在 `refineTextMask()` 的 per-region 循环中：

```ts
const outlineWidth = detectOutlineWidth(scaledGray, regionMask, scaledWidth, scaledHeight, baseRect, regionTextSize);
const outlineDilateExtra = outlineWidth > 0 ? outlineWidth * 2 : 0;
const baseRatio = outlineWidth > 0 ? 0.05 : 0.1;
const baseDilateSize = Math.max(Math.floor(Math.floor(regionTextSize * baseRatio) / 2) * 2 + 1, 3);
const dilateSize = Math.max(baseDilateSize + outlineDilateExtra, 3);
```

- 无描边：baseRatio = 0.1（10%），有效半径 ≈ textSize × 5%
- 有描边：baseRatio = 0.05（5%），有效半径 ≈ textSize × 2.5% + outlineWidth
- `outlineWidth * 2` 保持核大小为奇数
- `outlineWidth = 0` 时 `dilateSize = baseDilateSize`，无额外膨胀
- `rect2` 的 `extendSize = ceil(dilateSize/2)` 自然增大以容纳更大的膨胀核

## 插入位置

在 `refineTextMask()` 中，`refineRegionMask` 完成后、计算 `dilateSize` 之前插入检测调用。

此时 `regionMask` 已包含 Otsu refined 的暗核心 mask，`scaledGray` 已可用。

## 边界情况

| 场景 | 检测结果 | 膨胀量 | 说明 |
|---|---|---|---|
| 黑字白描边 + 彩色背景 | outlineWidth > 0 | 5% base + outlineWidth叠加 | 目标场景 |
| 黑字白描边 + 白色背景 | bgMedian ≈ 250, 描边亮度 ≈ 250, 无显著差异 | outlineWidth = 0, 10% base | 描边本身不可见 |
| 无描边黑字 | 无亮环 | outlineWidth = 0, 10% base | 不受影响 |
| 白字暗描边 | Otsu polarity 选 inverse, mask 为亮像素 | 不涉及 | 当前流程已处理 |
| 渐变/阴影描边 | 亮度差可能不够 40 | outlineWidth = 0 或较小 | 安全回退 |

## 兼容性

- 仅修改 `maskRefinement/algorithms.ts`（新增函数）和 `maskRefinement/index.ts`（调用新函数 + 调整膨胀逻辑）
- 不修改 `refineRegionMask()` 本身
- 不修改检测、OCR、inpainting、排版等其他模块
- `MaskRefinementOptions` 无需新增字段

## 降级 / 回退

- 如果 `detectOutlineWidth` 返回 0（无描边），膨胀量回退到 10% base
- 如果检测函数遇到异常（如 region mask 为空），直接返回 0
- 无描边场景的膨胀从原始 30% 降为 10%，依赖描边检测补偿有描边场景