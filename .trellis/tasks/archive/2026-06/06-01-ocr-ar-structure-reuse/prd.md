# OCR AR 结构复用优化实验

## Goal

在不改 ONNX 模型文件的前提下，减少内置 OCR AR 路径的重复推理。第一轮实验复用 AR decode 过程中已经返回的颜色输出，避免成功识别后再额外跑一次 `decodeTokenColorsBatch()`。

## Confirmed Facts

- `ocr.onnx` 每次 `session.run()` 同时返回 `logits`、`fg`、`bg`、`fg_ind`、`bg_ind`。
- 当前 `decodeBatchAutoregressive()` 只读取 `logits`，忽略同次输出中的颜色张量。
- 成功 decode 后，`runOcrByOnnxWithSession()` 会再次调用 `runOcrColorBatch()`，用同一个模型跑一次颜色输出。
- 采样图中 color batch 约 0.88s，占内置 OCR 约 9%。

## Requirements

- 在 batch AR decode 内捕获每个样本完成时可用的颜色输出。
- 若所有成功样本都有颜色结果，跳过独立 color batch。
- 若任一成功样本缺少颜色结果，保持现有 `runOcrColorBatch()` fallback。
- 不改变文本 decode、置信度阈值、fallback 到 single decode 的行为。
- 变更必须同时兼容 Worker 和 Node bridge。

## Acceptance Criteria

- [ ] 采样图内置 OCR 总耗时下降，目标至少减少 5%。
- [ ] 采样图 OCR region 数与文本结果基本不变。
- [ ] 成功复用颜色时 `colorDecodeMode` 标记为复用路径，且不会再额外增加 color `session.run`。
- [ ] `npx tsc --noEmit` 通过。

## Out of Scope

- 真正拆分 encoder/decoder ONNX 子图。
- GPU 侧 argmax/topK。
- 默认切换 OCR provider。
