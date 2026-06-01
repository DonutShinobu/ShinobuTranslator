# OCR encoder decoder split cache 实验

## Goal

尝试将 OCR AR 模型拆成 encoder 与 decoder/cache 路径，避免每个 token step 重算视觉 encoder；若失败则不保留。

## Requirements

- 在 active batch 压缩完成并决定保留后再启动。
- 先检查 `public/models/ocr.onnx` 图结构是否存在可切分的 encoder/decoder 边界。
- 优先做离线 ONNX 图分析和最小导出/切分实验；不要直接改生产路径。
- 若能成功得到可运行 encoder/decoder 子图，再做 fixture token 一致性和耗时对比。
- 若图结构不可切、ORT WebGPU 不支持必要中间 tensor、或工程风险过高，则记录原因，不保留生产改动。

## Acceptance Criteria

- [ ] 有 ONNX 图分析结论。
- [ ] 成功时有 encoder/decoder split 的可运行实验和耗时对比。
- [ ] 失败时有明确失败原因和不保留决策。
- [ ] 若保留，必须通过 `npx tsc --noEmit`、`npm run build` 和 OCR benchmark。

## Notes

- 这是高风险模型结构实验，不应阻塞 active batch 压缩的保留。
