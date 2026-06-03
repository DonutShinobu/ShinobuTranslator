# 2026-06-03 执行记录

## 当前保留范围

- 新增 `ProgressJankMonitor` 和 worker perf trace，单次翻译会输出 `[shinobu:jank]`，debug log 开启时写入 `progressJank`。
- 保留 Long Animation Frame、Long Task、rAF frame delta、worker heartbeat、UI render、stage summary、worker roundtrip、main-thread task 等观测字段。
- 保留真实 MV3 浏览器 smoke：`npm run bench:browser-ui-jank-smoke -- --process-mode=erase`。
- 保留观测文档和实验结论，便于后续只按数据挑选一个方向复测。

## 已回退范围

- 已回退会影响检测、气泡、OCR、去字、mask refinement、typeset、orchestrator 时序的 pipeline 优化实验。
- 已回退 `src/pipeline/scheduler.ts` 以及相关 cooperative yielding 实验。
- 已回退转圈动画优化：包括静态圆弧方案和 `OffscreenCanvas + Worker` spinner 方案。
- `src/content/core/ui.ts` 的 spinner 外观与任务开始前保持一致，不再引入 canvas spinner 或 `data-renderer` 状态。

## 关键观测结论

- 当前卡顿不是单纯 UI render 成本导致；多次 smoke 中 UI render 最大耗时通常在几十毫秒以内。
- 主要尖峰集中在模型/session/worker/WebGPU/canvas 边界，尤其是 detect、bubble、OCR、inpaint 和最终输出编码附近。
- 有些 long frame 的 blocking duration 很低，说明卡顿可能来自浏览器内部调度、GPU/合成压力或 ORT/WebGPU 边界，而不只是主线程 JS 循环。
- Worker heartbeat 与主线程 rAF 同时出现大尖峰时，单独把 spinner 放进 Worker 不能彻底解决转圈卡顿。

## OffscreenCanvas Spinner 实验结论

- 迁移后真实 smoke 能看到 `renderer=offscreen`，说明实验路径确实启用过。
- p95 和连续慢帧曾有局部改善，但仍存在 1s 级全局 stall。
- 用户观察到 16px canvas spinner 视觉发糊，不满足“药丸动画视觉效果保持不变”。
- 因此该方案只保留为文档记录，不保留运行时代码。

## 回退后 smoke

- report: `benchmark/perf/reports/ui-jank-2026-06-03T14-41-22-925Z.json`
- spinner: `renderer=null`, `hasCanvas=false`, `hasFallback=true`
- totalMs: `48308.4`
- frame: max `741.8ms`, p95 `16.5ms`, over100 `13`
- worker heartbeat: max `216.6ms`, p95 `8.5ms`, over100 `6`
- UI render: max `19.7ms`, renderCalls `18`
- 结论：回退后观测脚本仍可用，当前运行时代码没有 OffscreenCanvas spinner。

## 后续原则

- 暂时不继续优化转圈动画本身。
- 后续只基于 jank report 做分析；如果继续改代码，每次只选择一个明确变量并复测。
- 若要追求“完全不卡”，优先分析推理管线、WebGPU/ORT 调度、worker payload 和 canvas 边界，而不是继续改药丸 UI。

## 验证记录

- `npx tsc --noEmit` 通过。
- `npm run test` 通过。
- `npm run build` 通过。
- `node --check dist/content.js` 通过。
- `node --check dist/chunks/orchestrator.js` 通过。
- `node --check dist/chunks/onnxWorkerBridge.js` 通过。
- `node --check dist/onnxWorker.js` 通过。
- `npm run bench:browser-pipeline-smoke` 通过。
- `npm run bench:browser-ui-jank-smoke -- --process-mode=erase` 可生成真实浏览器 UI jank smoke 报告。
