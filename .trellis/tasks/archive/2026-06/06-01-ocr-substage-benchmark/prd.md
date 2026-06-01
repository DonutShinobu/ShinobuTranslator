# OCR 子阶段性能观测

## Goal

补齐内置 OCR 的子阶段性能观测，让每次 AR 优化都能判断耗时变化来自预处理、decode session.run、颜色 decode、fallback，还是跨线程/跨 bridge 开销。

## Confirmed Facts

- `OcrRunDebugInfo` 已包含 `preprocessTotalMs`、`chunks[].decodeSessionRunCount`、`chunks[].decodeSessionRunTotalMs`、`colorTotalMs` 等字段。
- 当前 `runOcrBatchDecode()` 调用 `decodeBatchAutoregressive()` 时没有传入 `chunkDebug`，导致 bridge 路径下 decode run 统计为 0。
- `runOcrColorBatch()` 同样没有传入 run counter，导致 color session run 统计为 0。

## Requirements

- Worker 和 Node bridge 都要回填 OCR decode/color 的 run count 与耗时。
- perf benchmark 报告需要能输出 OCR 子阶段摘要，至少包括 candidate/prepared、decode run count、decode run ms、color run count、color run ms。
- 观测逻辑不能改变 OCR 结果。

## Acceptance Criteria

- [ ] bridge 路径下 `debug.totalSessionRunCount > 0`。
- [ ] `benchmark/perf` 或独立脚本能输出 OCR 子阶段 JSON 摘要。
- [ ] 观测字段在无 OCR 结果、fallback、CTC 路径下不会抛错。

## Out of Scope

- 直接优化模型耗时。
- 浏览器 DevTools 自动化采样。
