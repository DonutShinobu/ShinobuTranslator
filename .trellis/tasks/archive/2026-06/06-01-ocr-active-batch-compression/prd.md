# OCR active batch 压缩

## Goal

在 AR OCR batch decode 中每步只运行未结束样本，减少固定 batch 下已结束 region 的无效计算；先测试，效果好则保留。

## Requirements

- 仅优化 batch AR decode；single fallback、CTC path、PaddleOCR path 不受影响。
- 每步只 pack `finished === false` 的样本，run 完再映射回原 region。
- 必须保持文本 token、confidence、颜色复用结果与现有固定 batch 路径一致或在可接受误差内。
- 必须兼容 WebGPU GPU argmax path；如果动态 active batch 导致 GPU path 不稳定，应自动回退 CPU logits path 或回退固定 batch。
- 必须输出可判断效果的 telemetry：每步 active count、session run time、postprocess mode/time。
- 效果不好或破坏稳定性时撤回本子任务生产改动。

## Acceptance Criteria

- [ ] fixture 上 OCR 文本数量和文本内容不回退。
- [ ] `colorDecodeMode` 仍可保持 `reuse`。
- [ ] OCR debug 或 benchmark 显示 active batch 压缩带来明确收益。
- [ ] `npx tsc --noEmit`、`npm run build`、`npm run bench:ocr-debug` 通过。
- [ ] 做出保留/回退决策并记录到 `implement.md`。

## Notes

- 现有 fixture 的 active count 为 `14,14,14,13,9,7,2,1`，理论样本 step 从 112 降到 74，存在约 34% 的无效 batch 工作可消除。
