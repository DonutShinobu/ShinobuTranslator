# OCR active batch 压缩实施计划

## Steps

1. 基于现有 `decodeBatchAutoregressive()` 增加 active compact batch 构建。
2. 保持旧固定 batch 逻辑易回退，尽量不改上层 API。
3. 确保 CPU logits path 和 WebGPU argmax path 都能处理 active batch。
4. 跑 Node OCR debug，确认文本数量、颜色复用、telemetry。
5. 跑 WebGPU argmax benchmark/浏览器实验，判断动态 batch 是否真的更快。
6. 根据结果保留或撤回。

## Validation

- `npx.cmd tsc --noEmit`
- `npm.cmd run build`
- `npm.cmd run bench:ocr-debug`

## Result 2026-06-01

- Implemented compact active-batch feeds in `decodeBatchAutoregressive()`.
- Added per-step `batchSize` and `compactFallback` telemetry.
- Added full-batch retry for a compact `session.run()` failure so dynamic batch backends can fall back without aborting OCR.
- CPU OCR debug fixture:
  - detected/ocr regions: 14/14
  - active counts: 14, 14, 14, 13, 9, 7, 2, 1
  - actual batch sizes: 14, 14, 14, 13, 9, 7, 2, 1
  - compact fallback: false on every step
  - decode session total: 4770.97 ms
  - OCR total: 6696.12 ms
  - color decode mode: reuse, color session runs: 0
- Compared with the same fixture's pre-active-batch fixed-batch baseline from this session (~6916.4 ms decode / ~8767.68 ms OCR):
  - decode session time: about 31.0% lower
  - OCR wall time: about 23.6% lower
- Validation passed:
  - `npx.cmd tsc --noEmit`
  - `npm.cmd run bench:ocr-debug`
  - `npm.cmd run build`
  - `npm.cmd run test`

Decision: keep active batch compression.
