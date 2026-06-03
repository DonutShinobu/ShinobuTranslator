# OffscreenCanvas Worker Spinner 实验记录（已回退）

## 当前状态

本实验只作为卡顿观测记录保留，运行时代码已回退：

- 不再保留 `OffscreenCanvas + Worker` spinner 实现。
- 不再保留 spinner canvas、`data-renderer`、Worker 绑定释放、阅读栏 spinner 同步等运行时代码。
- `src/content/core/ui.ts` 的转圈外观与任务开始前一致，避免因为本实验造成模糊或视觉变化。
- 真实浏览器 jank smoke 仍保留，用来观测 frame、LoAF、worker heartbeat、stage 和 spinner DOM 状态。

## 实验目标

- 验证把左侧 spinner 独立到 Worker 是否能绕开主线程卡顿。
- 不修改检测、气泡、OCR、去字等 pipeline 流程。
- 用真实 MV3 extension 场景记录实验前后数据。

## 实测记录

### 迁移前观测

- report: `benchmark/perf/reports/ui-jank-2026-06-03T13-40-20-185Z.json`
- 主线程 frame: max `1291.7ms`, p95 `16.6ms`, longestSlowStreak `8`
- Worker heartbeat: max `258.3ms`, p95 `8.5ms`, longestSlowStreak `1`
- 结论：Worker 心跳在这一轮更平滑，因此曾判断 Worker 侧 spinner 值得试验。

### 迁移后观测

- report: `benchmark/perf/reports/ui-jank-2026-06-03T13-50-02-142Z.json`
- spinner: `renderer=offscreen`, `hasCanvas=true`, `hasFallback=true`
- 主线程 frame: max `1149.8ms`, p95 `8.7ms`, longestSlowStreak `4`
- Worker heartbeat: max `1149.7ms`, p95 `8.5ms`, longestSlowStreak `1`
- UI render: max `24.1ms`, renderCalls `18`

## 回退原因

- 用户观察到 canvas spinner 在 16px 场景下视觉变模糊，不满足“药丸动画视觉效果保持不变”。
- 复测显示仍存在 1s 级全局 stall，且 spike 会同时影响主线程 rAF 和 worker heartbeat。
- 主要卡顿更像 ORT/WebGPU、浏览器调度或 GPU 竞争，单独把 spinner 放到 Worker 不能彻底解决问题。
- 当前阶段只保留观测代码和文档记录，暂停转圈动画优化。

## 保留内容

- `benchmark/perf/src/run-browser-ui-jank-smoke.ts`
- `package.json` 中的 `bench:browser-ui-jank-smoke`
- 本实验记录和观测报告路径

## 验证命令记录

```bash
npx tsc --noEmit
npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler --skipLibCheck --strict --types node --lib ES2022,DOM,DOM.Iterable benchmark/perf/src/run-browser-ui-jank-smoke.ts
npm run test
npm run build
node --check dist/content.js
node --check dist/chunks/orchestrator.js
node --check dist/chunks/onnxWorkerBridge.js
node --check dist/onnxWorker.js
npm run bench:browser-ui-jank-smoke -- --process-mode=erase
npm run bench:browser-pipeline-smoke
```
