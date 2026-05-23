# 颜色识别算法诊断与优化测试框架

## Goal

为 PaddleOCR 文字前景/背景色识别算法建立诊断 + 量化对比测试框架，定位"本体和描边都是灰色"问题的根源，并验证候选改进算法的效果。

## Requirements

### 阶段 1：诊断框架

- 在 Node.js 环境下运行（复用现有 `scripts/benchmark/` 基础设施）
- 对每张测试图的每个文本区域，记录以下追踪字段：
  - 走了哪条颜色路径（OCR模型输出 / 像素采样fallback / 默认值）
  - OCR模型输出路径中 hasFg/hasBg 步数占比
  - 原始 fg/bg RGB 值（resolveColors 输入前）
  - resolveColors 后的 fg/bg RGB 值
  - 是否触发安全网（DeltaE < 30）
  - DeltaE 值
  - bounding box 坐标
  - 人工标注的期望 fg/bg RGB 值
- 输出 JSON 诊断报告 + 汇总表（按路径分组统计灰色失败率、平均 DeltaE）

### 阶段 2：候选算法对比框架

- 预置候选算法：
  - **算法 A**：修复 extractColorsFromOutputs 中 hasBg=false 时的累加逻辑（当前 hasBg=false 时直接把 fg 值累加到 bg，导致 bg 趋近 fg）
  - **算法 D**：像素直方图双峰法（在 region crop 像素直方图上找两个峰值作为 fg/bg，不依赖 OCR 模型也不依赖边缘检测）
- 各算法量化指标：
  - fg/bg DeltaE 偏差（与标注期望值的 CIE76 距离）
  - DeltaE < 20 命中率
  - 灰色失败率（fg/bg DeltaE < 30 的比例）
  - 颜色路径分布
- 渲染对比图：每张测试图的每个 region 并排渲染当前算法 vs 候选 A vs 候选 D 的文字效果
- 输出 CSV 指标表 + 渲染对比图

### 测试数据

- 手动收集真实漫画中的颜色识别失败案例（灰色字图片）
- 人工标注每个文本区域的期望 fg/bg RGB 值（严格精确标注主色）
- 测试 fixtures 存放在 `scripts/benchmark/fixtures/color/` 目录下
- 每张图配一个 JSON 标注文件，格式：
  ```json
  {
    "regions": [
      {
        "bbox": [x, y, w, h],
        "expectedFg": [R, G, B],
        "expectedBg": [R, G, B]
      }
    ]
  }
  ```

## Acceptance Criteria

- [ ] 诊断脚本可在 Node.js 下运行，输出 JSON 诊断报告
- [ ] 诊断报告包含所有追踪字段，可定位问题路径
- [ ] 候选算法 A 和 D 可在对比框架中运行
- [ ] 对比框架输出渲染对比图（并排展示各算法的文字渲染效果）
- [ ] 对比框架输出 CSV 指标表，包含 DeltaE、命中率、灰色失败率
- [ ] 至少 5 张真实漫画失败案例可作为测试 fixtures

## Definition of Done

- 脚本 lint / typecheck 通过
- 诊断和对比脚本可在 Node.js 下端到端运行
- 渲染对比图生成可验证
- Docs/notes 更新（README 或 benchmark 脚本使用说明）

## Out of Scope

- 不修改浏览器端插件的颜色提取代码（仅建立测试框架）
- 不实现算法 B（像素采样路径改聚类）和 C（改 resolveColors 安全网）
- 不做程序化生成的合成测试图片
- 不做浏览器端 debug 模式
- 不涉及竖排/横排文字的差异化测试（当前只测通用场景）

## Technical Notes

### 颜色提取链路

```
图片 → detectTextRegions → per-region crop →
  ├─ runOcrColorSingle (OCR模型输出路径) → extractColorsFromOutputs → OcrColorResult
  ├─ sampleEdgeColors + sampleCornerBgColor (像素采样路径)
  └─ resolveColors (安全网：DeltaE < 30 时强制 bg 为白或黑)
→ 最终 ResolvedColors { fg, bg, fgRgb, bgRgb }
```

### 关键文件

- `src/pipeline/ocr/color.ts` — extractColorsFromOutputs, decodeTokenColors
- `src/pipeline/ocr/colorSampling.ts` — sampleEdgeColors, sampleCornerBgColor
- `src/pipeline/typeset/color.ts` — resolveColors, colorDistance, rgbToLab
- `scripts/benchmark/` — 现有 benchmark 基础设施

### hasBg=false 的问题（算法 A 的修复目标）

`extractColorsFromOutputs` 第 72-74 行：当 `hasBg` 为 false 时，直接将 fg 的 RGB 值累加到 bg 累加器中。这意味着当 OCR 模型没有有效 bg 预测时，bg 颜色会趋近于 fg 颜色，导致灰色结果。

### 算法 D（像素直方图双峰法）思路

在 region crop 的像素 RGB 直方图上找两个峰值（最高峰和次高峰），分别作为 fg 和 bg。不依赖 OCR 模型输出，也不依赖 Sobel 边缘检测。

### 现有 benchmark 基础设施

项目已有 `scripts/benchmark/run-bench.ts`，使用 `@napi-rs/canvas` 模拟 Canvas 环境，可复用其 ONNX Runtime 初始化和图片加载逻辑。