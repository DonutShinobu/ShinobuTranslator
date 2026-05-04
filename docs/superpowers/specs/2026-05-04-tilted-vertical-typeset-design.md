# 倾斜竖排文字排版设计

## 问题

当前排版管线在 `textlineMerge.ts` 的 `buildMergedRegion` 中，将合并后的文字区域输出为轴对齐矩形（AABB），导致检测阶段获得的旋转角度信息丢失。漫画中常见倾斜竖排文字，当前无法还原这种倾斜效果。

## 目标

- 合并后的文字区域保留倾斜角度
- 倾斜角度 ≥ 3° 时，排版应用旋转，贴近原图观感
- 倾斜角度 < 3° 时，当作正竖排处理，避免检测噪声干扰

## 方案

利用现有检测管线已有的 `minAreaRect` 算法，在合并阶段对凸包求最小面积旋转矩形，替代当前的 AABB。

## 改动点

### 1. 提取共享几何函数

**新文件**：`src/pipeline/geometry.ts`

从 `detect.ts` 提取以下函数：
- `convexHull`
- `sortMiniBoxPoints`
- `minAreaRect`

`detect.ts` 和 `textlineMerge.ts` 改为从此文件导入。

### 2. 修复 textlineMerge.ts 合并逻辑

**文件**：`src/pipeline/textlineMerge.ts`

`buildMergedRegion` 中第 842-853 行：
- 当前：用凸包的 min/max 坐标构建 AABB 作为 quad
- 改为：对凸包调用 `minAreaRect(hull)`，得到保留旋转的四边形
- `box` 字段仍用 AABB（通过 `quadToRect` 转换），因为其他逻辑依赖它做快速碰撞检测

### 3. 调整旋转阈值

**文件**：`src/pipeline/typeset.ts`

`compositeRegion` 第 631 行：
- 当前：`Math.abs(angle) > 0.01`（≈ 0.57°）
- 改为：`Math.abs(angle) > 0.052`（≈ 3°）

### 不需要改动的部分

- `typesetGeometry.ts` 的 `quadAngle`、`expandRegionBeforeRender`、`mapOffscreenPointToCanvas` — 已支持旋转 quad
- `compositeRegion` 的旋转合成逻辑 — 已正确工作
- OCR 的透视变换 — 已使用 quad 做 deskew

## 阈值行为

| 检测角度 | 行为 |
|---------|------|
| < 3° | 正竖排处理 |
| ≥ 3° | 保留倾斜角度，排版时应用旋转 |

## 数据流

```
detect.ts: minAreaRect → rotated quad (不变)
    ↓
textlineMerge.ts: buildMergedRegion → minAreaRect(hull) → rotated quad (修复)
    ↓
typesetGeometry.ts: quadAngle() → expandRegionBeforeRender() (不变)
    ↓
typeset.ts: compositeRegion() → 3° 阈值判断 → canvas rotate() (调阈值)
```
