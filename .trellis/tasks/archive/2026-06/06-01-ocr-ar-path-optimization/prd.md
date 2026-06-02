# 内置 OCR AR 路径优化

## Goal

降低内置 OCR 自回归（AR）路径的端到端耗时，优先减少重复 `session.run()` 和大 logits CPU 回传带来的延迟，同时保留当前浏览器扩展的识别质量、fallback 行为和 Node benchmark 路径。

## Confirmed Facts

- 现有 `benchmark/perf` 的 14 张图 baseline 中，OCR 加权约占总耗时 87.3%，是最大瓶颈。
- 当前内置 `ocr.onnx` 使用 AR 解码，输入包含 `image`、`char_idx`、`decoder_mask`、`encoder_mask`。
- `ocr.onnx` logits 输出形状为 `[batch, 64, 46272]`，单步 batch 输出很大。
- OCR 预处理在采样图上约 56ms，不是主要瓶颈。
- AR decode 在采样图上约 6.9s，颜色 decode 额外约 0.88s。
- 现有 Worker/Node bridge 没把 decode 内部 `chunkDebug` 计数回填到 OCR debug。

## Child Tasks

- `06-01-ocr-substage-benchmark`: 补齐 OCR 子阶段观测，作为所有优化的判断标准。
- `06-01-ocr-ar-structure-reuse`: 优先实验 AR 路径结构复用，先尝试复用 decode 已有输出减少额外 color pass。
- `06-01-ocr-webgpu-ar-optimize`: 备选实验 WebGPU 专项优化，包括 graph capture、固定 batch/shape、GPU dataflow。

## Requirements

- 优先优化内置 AR 路径，不把 PaddleOCR CTC 切成默认方案。
- 每个实验都必须有可量化 before/after 数据。
- 任一实验效果不好时必须能小范围回退，不牵连模型清单、fallback 和非 OCR 阶段。
- 保持用户可见文本为中文。
- 保持 pipeline 通过 `onnxBridge` 间接调用 Worker/Node ONNX bridge。

## Acceptance Criteria

- [x] 三个子任务都有明确 PRD；复杂子任务有 design/implement。
- [x] 优先子任务能产出一组 OCR 子阶段耗时对比。
- [x] 若选择保留优化，`npm run build` 或 `npx tsc --noEmit` 通过。
- [x] 若优化无效，变更可被撤回并记录原因，转入 WebGPU AR 子任务。

## Outcome

本轮采用“先补观测，再保守落地一项，最后验证备选”的路线：

1. `06-01-ocr-substage-benchmark`：补齐 OCR 子阶段 telemetry 和独立 debug benchmark，能看到 preprocess、AR decode、color decode、session.run 次数和耗时。
2. `06-01-ocr-ar-structure-reuse`：保留并落地。AR decode 每步已经产出 `fg/bg/fg_ind/bg_ind`，现在直接复用最终 token prefix 对应的颜色输出，成功时跳过额外 color pass。
3. `06-01-ocr-webgpu-ar-optimize`：已测试但不落地。浏览器 WebGPU 可用，普通 WebGPU warm run 可执行；但 ORT graph capture 因 OCR 图未完全 partition 到 WebGPU EP 被拒绝，不适合默认启用。

当前推荐优化方案：

- 短期保留 AR 颜色复用：收益稳定，改动范围小，不影响 fallback。
- 继续用新增 telemetry 观察真实样本，优先关注 `decodeSessionRunCount`、`decodeSessionRunTotalMs`、`colorDecodeMode`。
- 下一阶段若继续压 AR，优先做 GPU/worker 侧 argmax/top-k，只返回 token id 和必要颜色结果，减少大 logits CPU 回传。
- 中期考虑非 AR/CTC 或并行 decoder OCR 模型，根本减少 `session.run()` 次数。

## Out of Scope

- 默认切换到 PaddleOCR CTC。
- 新增或提交大型 ONNX 模型文件。
- 重新训练 OCR 模型。
