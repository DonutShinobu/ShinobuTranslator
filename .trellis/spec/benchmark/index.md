# Benchmark Development Guidelines

> 测试框架和基准测试的开发指南。

---

## Overview

项目在 `benchmark/` 下有两套基准测试基础设施：

1. **排版基准测试** — `benchmark/typeset/`，竖排排版几何精度回归测试（`run-bench.ts`, `bake-fixtures.ts` 等）
2. **颜色诊断与对比测试** — `benchmark/color/`，OCR 文字前景/背景色识别的诊断 + 量化对比框架（`color-diagnostic.ts`, `color-comparison.ts` 等）
3. **Node bake CLI** — `bake-node.ts`，纯 Node.js 端到端 pipeline（detect → OCR → merge → JSON 输出），使用 CUDA GPU 加速，替代 Chrome CDP 路径

1. **排版基准测试** — 竖排排版几何精度回归测试（`run-bench.ts`, `bake-fixtures.ts` 等）
2. **颜色诊断与对比测试** — OCR 文字前景/背景色识别的诊断 + 量化对比框架（`color-diagnostic.ts`, `color-comparison.ts` 等）

两者都运行在 Node.js 环境下，使用 `@napi-rs/canvas` 模拟 Canvas，`tsx` 作为运行器。

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Color Diagnostic Guide](./color-diagnostic-guide.md) | 颜色识别算法诊断与对比框架使用说明 | Filled |

---

## Key Architecture Facts

- **Benchmark 脚本运行在 Node.js** — 不依赖浏览器环境，使用 `@napi-rs/canvas` 替代 DOM Canvas
- **运行方式** — `tsx benchmark/typeset/src/*.ts` / `tsx benchmark/color/src/*.ts`，或通过 `package.json` 中的 npm scripts
- **bake-node** — `npx tsx benchmark/typeset/src/bake-node.ts [--out-dir path] [image1.png ...]` 或 `npm run bench:bake-node`，使用 `nodePlatform` + `onnxNodeBridge`（CUDA EP），输出 Fixture JSON
- **bake-node 字体限制** — node-canvas 的 `registerFont()` 只支持 `.ttf/.otf/.ttc`，不支持 `.woff2`。若项目字体只有 `.woff2` 格式，需安装系统 CJK 字体作为 fallback
- **Fixture 数据** — JSON 注解文件 git 追踪，实际图片文件 gitignore（用户手动添加）
- **报告输出** — `benchmark/reports/` 目录，gitignore，每次运行生成带时间戳的子目录
- **颜色工具函数** — `color-utils.ts` 从 `src/pipeline/typeset/color.ts` 重新导出 `rgbToLab`/`colorDistance`/`resolveColors`，不直接引用浏览器端代码（避免 ONNX Runtime 等浏览器依赖）

---

## Pre-Development Checklist

Before modifying benchmark scripts, verify:

- [ ] `tsx` 可用（`package.json` devDependencies）
- [ ] `@napi-rs/canvas` 已安装（Node.js Canvas 模拟）
- [ ] Fixture 注解格式与 `color-types.ts` 中的类型定义一致
- [ ] 新算法实现不修改浏览器端 `src/pipeline/` 代码（仅建立测试框架）
- [ ] 重复逻辑提取到 `color-utils.ts`（共享工具优于各脚本内复制）
- [ ] 颜色算法脚本放在 `benchmark/color/src/`，排版脚本放在 `benchmark/typeset/src/`

---

## 场景：Typeset Fixture 源列几何契约

### 1. Scope / Trigger

- 触发：修改 `benchmark/typeset/` 的 bake、render、metrics/report 脚本，或修改 `src/pipeline/bake.ts` 输出给 fixture 的字段。
- 目标：`sourceText`、`sourceLineGeometries`、`groundTruth.columns` 必须来自同一组 OCR/merge 源列，避免把旧 fixture 的列顺序错配误判成 typeset 字间距问题。

### 2. Signatures

- `BakeResultRegion.detectedColumns?: DetectedColumn[]`
- `FixtureRegion.sourceText: string`
- `FixtureRegion.groundTruth.columns: GroundTruthColumn[]`
- `RenderFixtureRegion.sourceLineGeometries?: SourceTextLineGeometry[]`
- `BenchmarkSummary.sourceGeometryUsableRegionCount: number`
- `BenchmarkSummary.sourceGeometryRejectedRegionCount: number`
- `BenchmarkSummary.sourceGeometrySpatialOrderMismatchCount: number`
- `BenchmarkSummary.sourceGeometryRejectedReasons: Record<string, number>`
- `npm run bench:audit-fixtures -- [--fixtures-dir path] [--strict]`
- `npm run bench:bake-node -- --out-dir <report-fixtures-dir>`

### 3. Contracts

- 新 bake 优先从 `merged.sourceLineGeometries` 生成 `detectedColumns`；只有缺失时才回退到 pre-merge `centerInBox` 匹配。
- `detectedColumns.charCount` 和 fixture `charCenters` 必须按 `text.replace(/\s+/g, "")` 的字形数计算，不能把换行/空白当成竖排字符。
- `bake-node.ts` 和 `bake-fixtures.ts` 必须支持 `--out-dir`，用于先把重 bake 产物写到 `benchmark/reports/` 下的临时目录；不要把未经审计的新 fixture 直接覆盖正式 `benchmark/typeset/fixtures/`。
- 替换正式 fixture 前，必须对临时输出执行 `npm run bench:audit-fixtures -- --fixtures-dir <dir> --strict`；替换后必须再对正式目录执行 `npm run bench:audit-fixtures -- --strict`。
- benchmark render 只能复现 fixture 输入：`sourceText` 保持不变，`sourceLineGeometries` 可由旧 fixture 的 GT 几何近似，但不得在 render adapter 中按诊断结果重写或重排。
- 旧 fixture 若文本能匹配但空间右到左顺序不同，允许继续用全局几何统计稳定视觉，但必须报告 `spatial_order_mismatch`；这类区域不能作为逐列字距拟合的真值。

### 4. Validation & Error Matrix

- `sourceText` 列数为 0 -> `empty_source_text`，不传 `sourceLineGeometries`。
- `sourceText` 列数 != `groundTruth.columns.length` -> `column_count_mismatch`，不传 `sourceLineGeometries`。
- 任一 `sourceText` 列文本无法在 GT 中找到未使用匹配 -> `text_mismatch`，不传 `sourceLineGeometries`。
- 文本集合可匹配但 `sourceText` 顺序 != GT 空间右到左顺序 -> `spatial_order_mismatch`，可传几何但报告计数。

### 5. Good/Base/Bad Cases

- Good：新 bake 的 `sourceText`、`sourceLineGeometries`、`groundTruth.columns` 都来自 `merged.sourceLineGeometries`，列顺序一致。
- Base：旧 fixture 文本可匹配但空间顺序不同，报告标出 `spatial_order_mismatch`，视觉仍可用几何锚点。
- Bad：直接把 `groundTruth.columns` 空间排序后重写 `sourceText`，会造成列文本错位。

### 6. Tests Required

- 单测 `benchmark/typeset/src/source-geometry.ts`：覆盖文本匹配、文本失败、列数失败、空间顺序不一致。
- 单测/回归 `fontFit`：源几何 profile 的 pitch/anchor 按空间右到左统计；`medianAdvance` 保留全局 fallback；per-column advance 必须按源文本列匹配，且匹配后的几何顺序不单调时返回空数组。
- Fixture 变更流程：先 `bench:bake-node -- --out-dir <report-fixtures-dir>`，再 `bench:audit-fixtures -- --fixtures-dir <report-fixtures-dir> --strict`；审计通过后才能备份并复制到正式目录。
- 端到端验证：`npm run bench:render` 后执行 `npm run bench`，确认 summary 输出 source geometry 诊断字段。

### 7. Wrong vs Correct

#### Wrong

```typescript
// Diagnostic/GT order must not rewrite benchmark render input.
sourceText: resolveFixtureRenderSourceText(region) ?? region.sourceText
```

```typescript
// Do not feed source-order diagnostics back into renderer geometry.
sourceLineGeometries: resolveFixtureSourceLineGeometries(region)
```

#### Correct

```typescript
// Render should reproduce the fixture input; diagnostics are reported separately.
sourceText: region.sourceText
sourceLineGeometries: region.groundTruth.columns.map(groundTruthColumnToSourceGeometry)
```

#### Cross-Layer Rule

- `groundTruth.columns` is the evaluation/annotation layer.
- `sourceText` and `translatedColumns` are render input layer.
- `sourceGeometryStatus` is diagnostic layer.
- Never let evaluation or diagnostic ordering rewrite render text order. Old fixtures may have `sourceText`, GT array order, and GT spatial order disagreeing; report that mismatch, but do not "fix" render input inside `render-result.ts`.

### Vertical Source Advance Contract

- Source geometry has two separate consumers:
  - spatial geometry (`medianPitch`, anchor, group center) is resolved from right-to-left column positions;
  - glyph advance targets must be aligned to source text/render column order.
- Keep a global `medianAdvance` fallback derived from spatial source columns. This preserves stable behavior when per-column mapping is unsafe.
- Enable per-column advance only when source geometry text can be matched to `sourceText` columns and the matched geometry is right-to-left monotonic.
- If source text, GT array order, and spatial order disagree, do not use per-column advance. Using a per-column advance from a mismatched column moves height/spacing from one visual column to another and creates the same class of position regressions as rewriting `sourceText`.
- Benchmark diagnostics may report `spatial_order_mismatch` or `text_mismatch`; those statuses are evidence to avoid per-column runtime feedback, not permission to reorder render input.

## 场景：浏览器 Paddle Profile Benchmark

### 1. Scope / Trigger

- 触发：修改 `benchmark/perf/src/run-browser-x-compare.ts`、新增浏览器 pipeline profile 命令，或需要在 Chromium/WebGPU 中分析 `paddleocr_v6_medium` 端到端耗时。
- 目标：用真实浏览器 provider、stage timings 和 Paddle OCR debug 判断 cold/warm 瓶颈，不用 Node CPU 结果替代 WebGPU 结论。

### 2. Signatures

```bash
npm run bench:browser-paddle-profile -- [--image=<local-image>] [--runs=3] [--process-mode=erase|original|translate] [--paddle-batch|--paddle-serial] [--paddle-provider=default|webgpu|webnn|wasm] [--paddle-cold-first-serial|--paddle-no-cold-first-serial] [--paddle-model=medium|small] [--paddle-runtime-probe=legacy|prepare|warmup] [--paddle-prepare|--paddle-warmup] [--paddle-probe-schedule=detect-start|after-detect|bubble-start|after-bubble|ocr-start] [--inpaint-probe-schedule=current|detect-start|after-detect|bubble-start|after-bubble|ocr-start] [--paddle-fixed-width=<px>] [--paddle-graph-capture]
npm run bench:browser-x-current -- --ocr-engine=paddleocr_v6_medium [--image=<local-image>] [--runs=3]
```

- `--ocr-engine=paddleocr_v6_medium` 仅支持 `--current-only`/`bench:browser-x-current` 语义；旧 AR 对比模式只用于 `48px`。
- `--image` 读取本地 fixture 并转为 data URL，避免 X 页面登录/网络状态影响性能判断。
- `--paddle-batch` 强制 width-bucket；`--paddle-serial` 强制逐 region；未传时使用 runtime 默认 provider-aware 策略。
- `--paddle-provider` 只用于 benchmark 内临时覆盖 Paddle recognition provider，用于回答 WebGPU/WebNN/WASM 对照问题；正式 pipeline 默认 fallback 不变。
- `--paddle-cold-first-serial`/`--paddle-no-cold-first-serial` 只用于 benchmark 对照 WebGPU cold session 的首个 inference 分组策略；默认策略由 Paddle provider 决定。
- `--paddle-model=small` 只注册并选择 `paddleocr_v6_small_rec` 作为 benchmark 候选；不得把 small 暴露为用户可见默认选项，除非另有产品任务。
- `--paddle-runtime-probe=prepare` 在用户触发 pipeline 后的 runtime probe 中准备 Paddle session/字典；`--paddle-warmup` 进一步执行固定 shape warmup inference。
- `--paddle-probe-schedule` 只用于 benchmark 调度实验，控制 Paddle OCR runtime probe 的启动点；默认 `detect-start` 保持既有行为。
- `--inpaint-probe-schedule` 只用于 benchmark 调度实验，控制 inpaint runtime probe 的启动点；默认 `current` 保持既有行为，即 OCR runtime probe 完成后、OCR inference 前启动。
- `--paddle-fixed-width=<px>` 把 Paddle 输入 padding 到固定宽度，用于静态 shape/warmup 对照；实际运行宽度不得小于本轮任一 OCR crop 的 `resizedWidth`，需要自动抬高并在报告中保留最终 `fixedInputWidth`，因为它会影响输出 time steps 和识别文本。
- `--paddle-graph-capture` 为 ORT WebGPU 实验开关，只能与固定 shape 一起验证；当前 Paddle CPU 输入和 CPU CTC decode 路径不满足外部 GPU buffer 合约。

### 3. Contracts

- Paddle profile report 必须包含 `stageTimings`、`ocrSummary.paddle` 和完整 `ocrDebug.paddle`。
- `ocrSummary.paddle` 至少包含 modelName、provider、batchMode、sessionOptionsKey、fixedInputWidth（如有）、inferenceRunCount、accepted/rejected/missing 计数、preprocess/inference/CTC/color 耗时、input/output bytes 和 width 分布。
- `ocrDebug.paddle.inferenceRuns[0]` 必须保留首个 inference 的 `inputDims`、`durationMs`、`outputDims`、`timeSteps` 和文本，cold-start 结论不能只看 OCR stage 总数。
- Browser profile 必须区分 cold run（`runIndex=0`）和 warm runs；性能结论优先使用 warm median，cold 结论单独说明 session/shape 编译成本。
- `processMode=erase` 覆盖本地检测、气泡、Paddle OCR、mask refine、inpaint；`processMode=original` 额外覆盖 typeset，不包含网络翻译。
- `paddleRuntimeProbeMode`、`paddleModelMode`、`paddleFixedInputWidth`、`paddleGraphCapture` 必须写入 mode-level report，避免多个实验报告混淆。
- `paddleRuntimeProbeSchedule` 和 `inpaintRuntimeProbeSchedule` 必须写入 mode-level report。分析 prepare 净收益时必须同时看 cold total、cold OCR、detect/bubble/inpaint stage；不能只看 OCR stage 变短。
- Paddle prepare/warmup 只能在用户触发翻译后的 pipeline 内启动，不得改成页面加载时预加载。

### 4. Validation & Error Matrix

| Condition | Symptom | Fix |
| --- | --- | --- |
| `dist` 未 build 或 Paddle 模型缺失 | benchmark 启动时报 missing dist asset | 先运行 `npm run build`，确认 `PP-OCRv6_medium_rec.onnx` 和 `paddleocr_v6_dict.txt` 存在 |
| 在非 current-only 模式传 Paddle engine | 旧 AR 对比语义混乱 | 抛错，要求使用 `bench:browser-paddle-profile` 或 `--current-only` |
| 同名 CLI 参数由 npm script 默认值和用户 override 同时提供 | 用户 override 被忽略 | 参数解析取最后一个 `--name=value` |
| 只看 Node CPU profile | WebGPU shape/session 行为被误判 | 必须补浏览器 WebGPU profile，再决定默认策略 |
| `--paddle-graph-capture` 仍使用 CPU input/output | `External buffer must be provided for input/output index 0 when enableGraphCapture is true` | 记录为当前架构不支持；除非先实现 GPU external input/output 和 decode/readback 设计 |
| warmup 后 detect/bubble stage 异常变慢 | OCR stage 变快但 total 变差 | 以 cold total/warm median 作为净收益判断，不把 OCR 局部收益直接产品化 |
| fixed width 改变样本文本 | 速度可比但质量不可比 | 报告样本文本并标注 `fixedInputWidth`；质量退化时不推荐默认启用 |
| Paddle prepare 放在 `bubble-start` 后 cold OCR 很短但 total 变差 | prepare 与 bubble/WebGPU 初始化抢资源 | 不把 OCR 局部收益当作端到端收益；改测 `detect-start` 或 `ocr-start` |
| inpaint probe 过早启动导致 cold total 变差 | inpaint session 与 detector/Paddle session 争用 Worker/WebGPU | 保持 `--inpaint-probe-schedule=current`，除非 report 证明端到端净收益 |

### 5. Good/Base/Bad Cases

- Good：本地 fixture 用 `--runs=3` 跑默认 Paddle WebGPU，报告 cold OCR、warm median、Paddle inference/preprocess 和全流程 stage timings。
- Good：用 `--paddle-model=small` 与 medium baseline 同图同 runs 对照，报告 cold total、warm median 和样本文本差异，再决定是否进入产品验证。
- Good：用 `--paddle-prepare` 验证用户触发后的懒准备收益，同时检查 detect/bubble 是否被 worker/GPU 争用拖慢。
- Good：对 prepare 调度实验使用同一图片、同一 runs，对比 `detect-start` / `after-detect` / `bubble-start` / `after-bubble` / `ocr-start`，并记录 `inpaintRuntimeProbeSchedule` 是否为默认。
- Base：用 `--paddle-serial` 跑对照，只比较 OCR 内部 inference/run count，不把 inpaint/detect 抖动误读为 batch 策略收益。
- Bad：用旧 `run-browser-x-compare` 默认 `ocrEngine=builtin` 的结果回答 Paddle 瓶颈。
- Bad：把 cold run 的首次 WebGPU shape 编译成本混进 warm median，并据此判断热运行瓶颈。
- Bad：`--paddle-graph-capture` 报外部 buffer 错误后继续把它当作可上线优化；当前 Paddle logits 需要 CPU CTC decode，必须先补 GPU buffer/readback 设计。
- Bad：把 inpaint probe 提前到 detect-start 后只看 OCR 缩短；如果 cold total 或 detect/bubble 变差，应判定为调度争用。

### 6. Tests Required

- `npx tsc --noEmit --pretty false`
- `npm run test`
- `npm run build`
- `npm run bench:browser-paddle-profile -- --image=<fixture> --runs=3`
- `npm run bench:browser-paddle-profile -- --image=<fixture> --runs=3 --paddle-model=small`
- `npm run bench:browser-paddle-profile -- --image=<fixture> --runs=3 --paddle-prepare`
- 调度实验：`npm run bench:browser-paddle-profile -- --image=<fixture> --runs=3 --paddle-prepare --paddle-probe-schedule=<schedule> [--inpaint-probe-schedule=<schedule>]`
- 如新增 Paddle 模型候选，先运行 `npm run models:check-paddle-ocr -- public/models/<model>.onnx public/models/paddleocr_v6_dict.txt`。
- 如验证 graph capture，失败也要记录原始错误；只有实现 GPU external input/output 后才把它列为通过项。
- 如改动 content/worker bundle 边界，再运行 `node --check dist/content.js dist/background.js dist/chunks/orchestrator.js dist/chunks/onnxWorkerBridge.js dist/onnxWorker.js`。

### 7. Wrong vs Correct

#### Wrong

```bash
npm run bench:browser-x-current -- --runs=3
```

这会使用默认 `48px`，不能回答 Paddle OCR/WebGPU 瓶颈。

#### Correct

```bash
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3
```

报告中检查 `ocrSummary.paddle.provider === "webgpu"`、`batchMode`、`inferenceRunCount` 和各 stage median 后再下结论。

#### Correct: small 候选验证

```bash
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3 --paddle-model=small
```

报告中同时检查 `ocrSummary.paddle.modelName === "paddleocr_v6_small_rec"`、cold total、warm median 和 `sampleTexts`，不要只用模型体积推断收益。

#### Correct: prepare 调度验证

```bash
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3 --paddle-prepare --paddle-probe-schedule=detect-start
```

对比同图同 runs 的其他 `--paddle-probe-schedule` 报告；只有 cold total 和 warm median 都不退化时，才把 prepare 调度视为可产品化候选。

---

## Quality Check

After modifying benchmark scripts, verify:

- [ ] `tsc --noEmit` 通过（TypeScript 类型检查）
- [ ] `vitest run` 全部通过（包括 `tests/benchmark/color-alg-diagnostic.test.ts`）
- [ ] 脚本可端到端运行（即使 fixture 图片缺失，也应优雅处理而非 crash）
- [ ] `import type` 用于类型导入，`type` 用于数据类型定义
- [ ] 无 `any` 类型

---

**Language**: Documentation written in **Chinese** (matching user-facing tool output).
