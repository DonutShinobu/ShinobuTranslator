# Pipeline性能Benchmark

## Goal

建立可重复的 Node.js 端性能基准测试，量化当前翻译 pipeline 各阶段耗时，为后续 CPU/GPU 数据流转优化提供对比基线。

## 已确认事实

- Pipeline 入口: `src/pipeline/orchestrator.ts` 的 `runPipeline()` 函数
- 已有 `StageTiming` 类型 (`src/types.ts`)，orchestrator 用 `performance.now()` 收集各阶段耗时
- 已有 OCR 子阶段详细计时 (`OcrRunDebugInfo`)：preprocess、decode、color 各有独立计时
- 已有格式化工具 (`formatDuration`, `formatElapsedText`) 用于展示计时
- 现有 benchmark 只测精度（typeset 几何、颜色识别），无速度/延迟测试
- Node 端运行路径: `bake-node.ts` 使用 `nodePlatform` + `onnxNodeBridge` (CUDA EP)
- Pipeline 主要阶段: load → preload → detect → bubble → ocr → merge → order → parallel(translate + erase) → typeset
- parallel 阶段内: translate / mask_refine / inpaint 并行执行
- `src/runtime/onnxNodeBridge.ts` 有 `probeRuntime()` 可探测 CUDA/CPU 可用性

## Requirements

1. 新建 `benchmark/perf/` 目录，实现 Node.js 端性能 benchmark 脚本
2. 使用指定图片作为唯一输入: `benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png`
3. 运行完整 pipeline (detect → OCR → merge → translate → inpaint → typeset)，记录各阶段耗时（大阶段级，复用 StageTiming）
4. 默认运行 3 次：第 1 次标注为冷启动（含模型加载），第 2、3 次为稳态，取中位数
5. 输出格式：控制台打印结构化耗时表格 + JSON 报告文件写入 `benchmark/perf/reports/`
6. JSON 报告包含：运行时间戳、运行环境（CUDA/CPU）、总耗时、各阶段耗时、每次原始数据、中位数
7. 通过 `tsx` 执行，添加 npm script 入口

## Acceptance Criteria

- [ ] `npm run bench:perf` 可成功运行，输出各阶段耗时表格到控制台
- [ ] JSON 报告文件生成在 `benchmark/perf/reports/` 下，结构正确
- [ ] 报告包含 3 次运行的原始数据及中位数
- [ ] 冷启动（第 1 次）与稳态（第 2、3 次）区分标注
- [ ] 报告记录运行环境（CUDA 或 CPU）

## Out of Scope

- 浏览器端性能测试
- CPU↔GPU 子操作级细粒度计时（张量上传/下载）
- Baseline 对比 / 回归检测（后续优化后按需添加）
- 多图片 / 多场景覆盖
