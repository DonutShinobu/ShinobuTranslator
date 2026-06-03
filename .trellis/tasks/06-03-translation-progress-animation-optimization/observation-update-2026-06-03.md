# 2026-06-03 观测增强更新

## 本轮决策

用户确认不使用 iframe 方案，并要求先回退会影响推理速度、检测精度或 pipeline 时序的检测流程优化。本轮已将上一轮引入的 pipeline cooperative yielding / detector、bubble、OCR、inpaint、mask refinement、typeset、orchestrator 流程调整回退到基线版本，并删除 `src/pipeline/scheduler.ts`。

当前方向改为：只保留观测增强、真实浏览器 smoke 和实验记录。转圈动画优化暂时停止，已尝试过的 `OffscreenCanvas + Worker spinner` 不再作为当前实现保留。

## 新增观测项

- `ProgressJankReport.observerSupport`：记录 Long Animation Frame、Long Task、worker heartbeat 是否实际启用。
- `ProgressJankReport.workerHeartbeat`：用独立 dedicated worker tick 对照主线程 rAF。
- `longFrames[].scripts`：记录 LoAF top scripts、`invoker`、`sourceURL`、`forcedStyleAndLayoutDurationMs` 等，用于判断长帧来自 UI、pipeline chunk、host page 还是浏览器调度。
- `longFrames[].renderStartMs/styleAndLayoutStartMs/firstUIEventTimestampMs`：补充渲染与布局时间戳，解释 longtask 少但动画仍卡的情况。
- `workerCalls[].stage` / `mainThreadTasks[].stage`：让 worker roundtrip 和 canvas/debug 主线程任务能直接归因到当前 pipeline stage。
- `stages[]` 增加 main-thread task 与 worker call 计数/最大耗时，便于快速比较阶段边界。

## 下一步判定

- 先继续使用真实浏览器 smoke、`[shinobu:jank]` 和 debug log 记录卡顿，不再改药丸 spinner 外观或渲染方式。
- 如果主线程 rAF 和 worker heartbeat 都卡，优先分析 LoAF scripts、WebGPU/ORT worker boundary、host page/GPU contention；此时单纯把 spinner 放 worker 收益有限。
- 只有当 LoAF 明确指向某个纯主线程子循环时，才考虑小范围 cooperative yielding 或 worker offload；不得再一次性改多段检测流程。

## 验证

- `npx tsc --noEmit` 通过。
- `npm run test` 通过，24 个测试文件 / 378 个测试。
- `npm run build` 通过，只有 ORT eval/chunk-size 既有警告。
- `node --check dist/content.js` 通过。
- `node --check dist/chunks/orchestrator.js` 通过。
- `node --check dist/chunks/onnxWorkerBridge.js` 通过。
- `node --check dist/onnxWorker.js` 通过。
- `npm run bench:browser-pipeline-smoke` 通过：2921x4096 fixture，检测 7 个区域，7 个 OCR 非空，source 字符数 59。
