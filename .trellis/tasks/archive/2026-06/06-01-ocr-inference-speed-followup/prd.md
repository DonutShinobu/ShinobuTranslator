# OCR 推理速度后续优化

## Goal

把 active batch 压缩和 encoder/decoder split+cache 做成子任务，按顺序先验证 active batch 压缩，效果好则保留，再尝试 encoder/decoder split+cache。

## Requirements

- 先创建两个子任务：
  - `06-01-ocr-active-batch-compression`
  - `06-01-ocr-encoder-decoder-cache`
- 执行顺序固定：先做 active batch 压缩，测试效果；效果好则保留。
- active batch 压缩保留后，再尝试 encoder/decoder split+cache。
- encoder/decoder split+cache 若可成功并通过验证则保留；若不可行或风险过高，则只保留 active batch 压缩。
- 不改变现有 provider fallback、颜色复用、GPU argmax fallback 行为。

## Acceptance Criteria

- [x] 两个子任务已创建并挂到父任务。
- [x] active batch 压缩子任务有测试数据和保留/回退决策。
- [x] encoder/decoder split+cache 子任务有实验数据和保留/回退决策。
- [x] 最终保留的变更通过 `npx tsc --noEmit`、`npm run build`，并至少跑 OCR debug/benchmark。

## Notes

- 继续沿用已归档任务中的 telemetry、颜色复用和 GPU argmax 变更。
- 2026-06-01: active batch 和 encoder cache 都已保留。最终 OCR debug fixture 为 `encoderCache: true`，decode session total 1797.49 ms，OCR total 4733.47 ms。
