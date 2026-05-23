# 颜色识别算法诊断与对比框架使用指南

> 如何准备数据、运行测试、解读结果、迭代优化。

---

## 概述

本框架用于诊断 PaddleOCR 文字前景/背景色识别中"本体和描边都是灰色"的问题，并量化对比候选改进算法的效果。包含两个核心脚本：

- **诊断脚本** (`color-diagnostic.ts`) — 追踪颜色提取链路，定位问题路径
- **对比脚本** (`color-comparison.ts`) — 量化对比当前算法 vs 算法 A vs 算法 D

---

## 运行命令

```bash
# 诊断脚本（Phase 1）
npm run color:diagnostic

# 对比脚本（Phase 2）
npm run color:comparison

# 单元测试
npx vitest run tests/benchmark/color-alg-diagnostic.test.ts
```

---

## 准备测试数据

### 1. 收集失败案例图片

从真实漫画中截取颜色识别失败的图片（文字和底色看起来都是灰色的区域）。将 PNG 图片放到：

```
scripts/benchmark/fixtures/color/
  gray-text-01.png
  gray-text-02.png
  ...
```

### 2. 编写注解文件

每张图片配一个同名的 JSON 注解文件（已预置 5 个模板），格式：

```json
{
  "imageFile": "gray-text-01.png",
  "regions": [
    {
      "bbox": [x, y, width, height],
      "expectedFg": [R, G, B],
      "expectedBg": [R, G, B]
    }
  ]
}
```

**标注方法**：
- 用图片编辑器（如 Photoshop、GIMP）或浏览器取色器精确拾取颜色
- `bbox` 是文字区域的矩形坐标 `[左上角x, 左上角y, 宽, 高]`
- `expectedFg` 是文字主色的 RGB 值
- `expectedBg` 是文字周围底色的 RGB 值
- 一张图片可以有多个 region（多个文字区域）

### 3. 图片缺失时的行为

如果 fixture 图片不存在，脚本会生成合成 OCR 数据继续运行。这意味着算法 D（像素直方图）和像素采样路径无法产生有意义的结果，但不会 crash。

---

## 输出解读

### 诊断脚本输出

运行后在 `benchmark/reports/<timestamp>/` 生成：

| 文件 | 内容 |
|------|------|
| `color-diagnostic-report.json` | 每个区域完整追踪字段 |
| `color-diagnostic-summary.md` | 汇总表（按路径分组） |

**追踪字段含义**：

| 字段 | 含义 |
|------|------|
| `colorPath` | 走了哪条颜色路径（`ocr_model` / `pixel_sampling` / `default`） |
| `hasFgRatio` / `hasBgRatio` | OCR 输出中有有效 fg/bg 的步数占比 |
| `rawFgRgb` / `rawBgRgb` | resolveColors 之前的原始 RGB |
| `resolvedFgRgb` / `resolvedBgRgb` | resolveColors 之后的 RGB |
| `safetyNetTriggered` | 是否触发安全网（fg/bg DeltaE < 30） |
| `rawDeltaE` | rawFg 与 rawBg 之间的 DeltaE |
| `fgDeltaE` / `bgDeltaE` | 与标注期望值的 DeltaE 偏差 |
| `isGrayFailure` | fg/bg 之间 DeltaE < 30（灰色失败） |

**汇总表关键指标**：
- **灰色失败率** — fg/bg DeltaE < 30 的比例（越高说明当前算法越差）
- **平均 fg/bg DeltaE** — 与标注期望值的平均偏差

### 对比脚本输出

运行后在 `benchmark/reports/<timestamp>/` 生成：

| 文件 | 内容 |
|------|------|
| `color-comparison-report.json` | 每个算法每个区域的量化指标 |
| `color-comparison-metrics.csv` | CSV 格式指标表 |
| `color-comparison-*.png` | 并排渲染对比图 |

**CSV 指标列**：

| 列名 | 含义 |
|------|------|
| `fgDeltaE` | 前景色与期望值的 CIE76 距离 |
| `bgDeltaE` | 背景色与期望值的 CIE76 距离 |
| `hitRate` | DeltaE < 20 的命中率 |
| `grayFailureRate` | fg/bg DeltaE < 30 的比例 |
| `colorPath` | 算法使用的颜色路径 |

**并排渲染对比图**：每个区域 3 列并排展示：
- 当前算法（含 hasBg bug）的文字效果
- 算法 A（修复 hasBg=false 累加）的文字效果
- 算法 D（像素直方图双峰）的文字效果

---

## 候选算法说明

### 算法 A — 修复 hasBg=false 累加

**问题根源**：`extractColorsFromOutputs` 第 72-74 行，当 OCR 模型没有有效 bg 预测 (`hasBg=false`) 时，直接将 fg 的 RGB 值累加到 bg 累加器。导致 bg 颜色趋近于 fg，产生灰色结果。

**修复方案**：`hasBg=false` 时跳过 bg 累加（不累加 fg 到 bg），当没有任何有效的 bg 步时，bg 回退为白色 `[255, 255, 255]`。

### 算法 D — 像素直方图双峰法

**原理**：在 region crop 的像素灰度直方图上找两个峰值（全局最大峰 + 至少 30 bins 间距的次高峰），然后平均每个峰附近的 RGB 值作为 fg/bg。最大峰对应面积较大的颜色（通常是背景），次峰对应面积较小的颜色（通常是前景）。

**优势**：不依赖 OCR 模型输出，也不依赖 Sobel 边缘检测。纯像素统计方法。

**局限**：当文字和底色面积比例接近（如大字小背景），峰归属可能反转。需要足够大的区域才能产生有意义的直方图。

---

## 迭代优化流程

```
1. 收集失败案例 → 添加更多 fixture 图片+注解
2. npm run color:diagnostic → 查看路径分布和灰色失败率
3. npm run color:comparison → 对比算法 A/D 的指标改善
4. 调参 → 修改算法 D 的阈值 (平滑窗口、峰间距)
5. 加新算法 → 在 scripts/benchmark/ 加新文件，注册到 color-comparison.ts
6. 循环 2-5 直到命中率达标
7. 确认最优算法 → 回到 src/pipeline/ 修改浏览器端代码
```

### 调参位置

- **算法 D 直方图参数** — `scripts/benchmark/alg-d-histogram-bimodal.ts`
  - `SMOOTH_WINDOW` — 直方图平滑窗口大小（默认 3）
  - `MIN_PEAK_GAP` — 两峰之间的最小 bin 间距（默认 30）
  - `PEAK_SAMPLE_RADIUS` — 峰附近 RGB 平均的半径范围（默认 5）

### 添加新候选算法

1. 在 `scripts/benchmark/` 创建新文件（如 `alg-e-xxx.ts`）
2. 导出函数签名：`(croppedData, width, height) => { fgRgb, bgRgb }`
3. 在 `color-comparison.ts` 中导入并注册到 `algorithms` 数组
4. 在 `color-types.ts` 中更新 `AlgorithmName` 类型（如需）

---

## 关键文件索引

| 文件 | 作用 |
|------|------|
| `scripts/benchmark/color-types.ts` | 类型定义（ColorFixture, RegionDiagnosticTrace 等） |
| `scripts/benchmark/color-utils.ts` | 共享工具（rgbToLab, deltaE, resolveColors, cropRegion 等） |
| `scripts/benchmark/alg-a-fix-hasbg.ts` | 算法 A 实现 |
| `scripts/benchmark/alg-d-histogram-bimodal.ts` | 算法 D 实现 |
| `scripts/benchmark/color-diagnostic.ts` | Phase 1 诊断脚本 |
| `scripts/benchmark/color-comparison.ts` | Phase 2 对比脚本 |
| `scripts/benchmark/fixtures/color/` | Fixture 目录（JSON 注解 + PNG 图片） |
| `tests/benchmark/color-alg-diagnostic.test.ts` | Vitest 单元测试 |
| `src/pipeline/ocr/color.ts` | 浏览器端颜色提取（bug 所在） |
| `src/pipeline/ocr/colorSampling.ts` | 浏览器端像素采样 |
| `src/pipeline/typeset/color.ts` | 浏览器端 resolveColors 安全网 |