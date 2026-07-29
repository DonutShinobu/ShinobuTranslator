# 竖排排版 Benchmark 设计

- 日期：2026-05-01
- 范围：为 ShinobuTranslator 的竖排（vertical）排版引擎建立可量化的回归基准，用于发现"列位置偏移"和"字号差距过大"等迭代过程中的退化与改进。
- 不在范围：检测精度、OCR 正确性、翻译质量、inpaint 效果、绘制像素差异、横排排版。

## 1. 目标与背景

当前竖排排版有时出现位置偏移、字号与原图差距较大等问题。需要一个可重复的离线基准：

- 输入：用户准备的若干张原图。
- 基准（ground truth）：原图本身。**不引入译文**——避免译文字数变化带来变量过多的问题。
- 度量对象：把原文（OCR 结果）回灌给 typeset，用 typeset 输出的列几何与原图列几何对比。

核心约束：**只测排版**。检测/OCR 的随机性必须不污染指标，迭代时数字波动应只来自 typeset 改动。

## 2. 总体架构

```
benchmark/
  images/                      # 用户放进的测试图（.png/.jpg），默认 .gitignore
  fixtures/                    # 每张图一份 JSON，git 追踪
    <name>.fixture.json
  reports/                     # 跑完的指标输出，默认 .gitignore
    <timestamp>/
      summary.json
      summary.md
      per-region.csv
  baseline.json                # 当前认定的基线分数，回归对比用，git 追踪

scripts/
  benchmark/
    bake-fixtures.ts           # 一次性：浏览器跑 detect+OCR → fixture
    run-bench.ts               # 日常：Node 读 fixture → 调 typeset 几何 → 算指标
    diff-baseline.ts           # 与 baseline.json 比，输出 regression / improvement

src/pipeline/
  typeset.ts                   # 改造为先调 computeVerticalGeometry，再绘制
  typesetGeometry.ts           # 新文件，承载抽出的纯几何函数（无 DOM/Canvas 依赖）
```

两个独立步骤：

- **烘焙（低频）**：用 Playwright 加载扩展，对 `images/` 中每张图跑 detect+OCR，回灌原文跳翻译，把"原图列几何 + 逐字中心 + 排版后列几何 + fontSize + 排版逐字中心"全部写进 fixture。
- **回归（高频）**：Node 脚本读 fixture，**只重跑 typeset 几何函数**（用 fixture 里的 region+原文），与 fixture 里的 ground truth 比对算指标。

不引入 `onnxruntime-node`：typeset 几何是纯计算，不需要模型推理；fixture 已把模型输出冻结。

## 3. Fixture 数据结构

每张图对应 `<name>.fixture.json`：

```jsonc
{
  "schemaVersion": 1,
  "image": {
    "file": "images/sample01.png",
    "width": 800,
    "height": 1200,
    "sha256": "..."                     // 图改了能检出 fixture 过期
  },
  "bakedAt": "2026-05-01T...",
  "bakedWith": {
    "gitCommit": "3c0fe19",
    "detectorModel": "detector.onnx",
    "ocrModel": "ocr.onnx"
  },
  "regions": [
    {
      "id": "r0",
      "direction": "v",
      "box": { "x": 120, "y": 80, "width": 60, "height": 320 },
      "quad": [{ "x": 0, "y": 0 }, { "x": 0, "y": 0 }, { "x": 0, "y": 0 }, { "x": 0, "y": 0 }],
      "sourceText": "こんにちは元気ですか",

      // 原图实际的列几何（来自 detect+OCR）
      "groundTruth": {
        "columns": [
          {
            "index": 0,                 // 0 = 最右列（垂排阅读起点）
            "text": "こんにちは",
            "charCount": 5,
            "quad": [{ "x": 0, "y": 0 }, { "x": 0, "y": 0 }, { "x": 0, "y": 0 }, { "x": 0, "y": 0 }],
            "centerX": 165,
            "topY": 85,
            "bottomY": 245,
            "width": 28,
            "estimatedFontSize": 32,
            "charCenters": [
              { "y": 101 }, { "y": 133 }, { "y": 165 }, { "y": 197 }, { "y": 229 }
            ]
          }
        ]
      },

      // 当前实现 typeset 输出的快照，仅供人工比对；回归脚本始终重算
      "currentTypeset": {
        "fittedFontSize": 28,
        "columns": [ /* 同上结构 */ ]
      }
    }
  ]
}
```

要点：

- `image.sha256` 防止图替换后 fixture 失效；脚本检测到不一致直接报错并提示重烘。
- `charCenters` 用列 quad 高度均分原文字数得到。**原图字距通常近似均匀**，本指标关注"排版是否也均匀、是否在列内合理分布"，该近似可接受。
- `groundTruth` 一旦烘焙基本稳定；只有换图、换检测/OCR 模型才需要重烘。可以人工编辑修正 OCR 错字。
- `currentTypeset` 是辅助快照，**回归脚本不信任它**，始终重新调用 `computeVerticalGeometry` 计算。

## 4. 指标

每个 region 算一组指标，再聚合到全图、全数据集。

**列配对策略**：GT 与预测列按"从右到左"顺序一一配对（垂排阅读序）。列数不等时，多余/缺失列按 IoU=0、其它指标置空记录。

### 4.1 列数一致性

```
columnCountMatch = (gtCols === predCols) ? 1 : 0
columnCountDiff  = predCols - gtCols
```

聚合：列数完全一致的 region 占比。

### 4.2 列 bbox IoU

```
iou_i = area(gtCol_i ∩ predCol_i) / area(gtCol_i ∪ predCol_i)
```

聚合：`columnIouMean`、`columnIouMin`。

### 4.3 字号偏差

```
gtFont   = median(groundTruth.columns[*].estimatedFontSize)
predFont = typeset.fittedFontSize

fontSizeRatio = predFont / gtFont
fontSizeError = |predFont - gtFont| / gtFont
```

聚合：`fontSizeError` 的均值与 P95。

### 4.4 列水平位置偏移（归一化）

```
dxPx_i   = predCol_i.centerX - gtCol_i.centerX
dxNorm_i = dxPx_i / gtCol_i.width
```

聚合：`columnDxNormMean`、`columnDxNormMax`。`> 0.5` 通常意味着列已偏出原列范围。

### 4.5 列垂直范围偏移

```
dTopNorm_i    = (predCol_i.topY    - gtCol_i.topY)    / gtCol_i.height
dBottomNorm_i = (predCol_i.bottomY - gtCol_i.bottomY) / gtCol_i.height
heightRatio_i = predCol_i.height / gtCol_i.height
```

聚合：mean 与 max。

### 4.6 逐字中心偏移（列内）

字数相同时一一配对；不同时按比例对齐 `predIdx = round(gtIdx * predN / gtN)`。

```
dyPx_ij   = predCol_i.charCenters[j].y - gtCol_i.charCenters[j].y
dyNorm_ij = dyPx_ij / predFont
```

聚合：`charDyNormMean`、`charDyNormMax`、`charDyNormP95`。

### 4.7 综合分（汇总用，可选）

```
score = w1 * columnCountMatch
      + w2 * columnIouMean
      + w3 * (1 - clamp(fontSizeError, 0, 1))
      + w4 * (1 - clamp(columnDxNormMean, 0, 1))
      + w5 * (1 - clamp(charDyNormMean, 0, 1))
```

默认权重 `[0.2, 0.3, 0.2, 0.15, 0.15]`，权重写在配置文件 `benchmark/bench.config.json` 中可调。

### 4.8 报表产物

- `summary.json`：数据集级 + 每图汇总。
- `summary.md`：人读，含 top-N 最差 region 列表（含 region id、关键指标、对应图路径）。
- `per-region.csv`：每行一个 region 全部指标，便于排序筛选。
- 与 `baseline.json` 的 diff：变好/变差超过阈值（默认 5%）的项。

## 5. 实施切片（粗略）

1. **抽离 typeset 几何为纯函数**
   - 在 `src/pipeline/typeset.ts` 中识别"输入 region+原文+图像尺寸 → 输出 columns / fittedFontSize / charCenters"的子流程，迁出到新文件 `src/pipeline/typesetGeometry.ts`。
   - **该函数仍然接受一个 `CanvasRenderingContext2D` 参数**用于 `measureText` 字体度量；不接触 DOM、`Image`、绘制 API 之外的浏览器对象。
   - Node 侧使用 npm `canvas` 包（`node-canvas`，原生构建，调 Cairo）创建 ctx，把扩展打包用的字体（`public/fonts/`）通过 `registerFont` 注册进去后传给 `computeVerticalGeometry`。
   - node-canvas 的字体度量与浏览器存在毫秒级差异，但同一字体下的相对趋势一致，足以反映 typeset 几何决策的改动。指标的"字号偏差"等指标都用归一化/比例形式，对绝对度量误差不敏感。
   - 现有 `drawTypeset` 改为先调 `computeVerticalGeometry`，再绘制；行为不变。

2. **Fixture 烘焙脚本**：`scripts/benchmark/bake-fixtures.ts`
   - Playwright 启动扩展，加载 `benchmark/images/*` 中每张图。
   - content script 暴露 `window.__shinobu_bake__` debug 入口，跑 detect+OCR，跳翻译/绘制，dump JSON。
   - 写入 `benchmark/fixtures/<name>.fixture.json`，含 sha256。

3. **Benchmark 运行脚本**：`scripts/benchmark/run-bench.ts`（Node，纯计算）
   - 读 fixture，校验 sha256（不一致报错并提示重烘）。
   - 调 `computeVerticalGeometry` 重新排版，按 §4 算指标。
   - 输出 `summary.{json,md}` + `per-region.csv` 到 `benchmark/reports/<timestamp>/`。

4. **Baseline 对比**：`scripts/benchmark/diff-baseline.ts`
   - 与 `benchmark/baseline.json` 比，列出回归/改进。
   - 支持 `--update-baseline` 把当前 summary 固化为新基线。

5. **package.json 命令**

   ```
   npm run bench:bake      # 重烘 fixture（低频）
   npm run bench           # 跑指标 + 与 baseline 对比（日常）
   npm run bench:baseline  # 固化新 baseline
   ```

6. **入门数据集**：先放 5–10 张代表性图（短列、长列、单字列、多列对话、密集小字），覆盖目前观察到的偏移/字号问题场景。

## 6. 边界与默认决策

**不测**：检测精度、OCR 文本正确性、翻译质量、inpaint、像素级渲染、颜色/字体/描边、横排（h direction）。横排 region 在 fixture 中照常烘焙但指标阶段标记 `skipped: "horizontal"`。

**默认决策（可推翻）**：

- `estimatedFontSize` 估算：`min(列宽, 列高/字数)`，与现有 `fitVerticalLayout` 思路一致。若某图证明估得不准，可人工编辑 fixture。
- 测试图入不入 git：默认 `benchmark/images/` 加进 `.gitignore`，fixture 入库。版权图不暴露，指标仍可复现（前提是 fixture 已烘）。
- Baseline 管理：仅保留 `baseline.json` 一份在 git；`benchmark/reports/` 加进 `.gitignore`（不留趋势历史）。
- CI：第一版不挂 CI，纯本地工具。
