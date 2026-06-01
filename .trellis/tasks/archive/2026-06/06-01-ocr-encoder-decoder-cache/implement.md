# OCR encoder/decoder split + cache 实施计划

## Steps

1. 等 active batch 压缩任务完成并决定保留后启动。
2. 用 ONNX tooling inspect `public/models/ocr.onnx` 输入、输出、节点和分支汇合点。
3. 判断是否存在可切分 encoder output。
4. 若可切分，导出临时子图到 benchmark/temp，不提交大型模型资产。
5. 跑 fixture token 一致性和耗时对比。
6. 成功则设计生产接入；失败则记录原因并不保留。

## Validation

- ONNX 图分析日志。
- 可选：临时子图实验结果。
- 若生产接入：`npx.cmd tsc --noEmit`、`npm.cmd run build`、OCR benchmark。

## Result 2026-06-01

- ONNX graph split boundary found at `/encoders.3/Add_1_output_0`.
- Generated split models:
  - `public/models/ocr_encoder.onnx`: 96.88 MB
  - `public/models/ocr_decoder.onnx`: 154.89 MB
- Added `npm run models:split-ocr` to regenerate the split models from `public/models/ocr.onnx`.
- Random tensor parity test: full vs encoder+decoder outputs matched exactly for `logits`, `fg`, `bg`, `fg_ind`, and `bg_ind`.
- Direct fixture experiment:
  - full active AR model run: 4730.22 ms
  - split encoder cache model run: 1874.28 ms
  - model run reduction: 60.38%
  - wall reduction in direct decode loop: 60.06%
  - text mismatches: 0
- Production OCR debug after wiring split cache:
  - detected/ocr regions: 14/14
  - `encoderCache: true`
  - encoder run: 733.78 ms
  - decoder run total: 1063.71 ms
  - decode session total: 1797.49 ms
  - OCR total: 4733.47 ms
  - color decode mode: reuse, color session runs: 0
  - fallback trigger count: 0
- Validation passed:
  - `npx.cmd tsc --noEmit`
  - `npm.cmd run models:split-ocr`
  - `npm.cmd run bench:ocr-debug`
  - `npm.cmd run build`
  - `npm.cmd run test`

Decision: keep encoder/decoder split cache. The production path uses split cache when split models are present and falls back to the full AR model if split session creation fails.
