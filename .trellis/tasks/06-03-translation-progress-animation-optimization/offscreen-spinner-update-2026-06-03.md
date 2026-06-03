# OffscreenCanvas Worker Spinner 更新记录

## 本轮目标

- 不再继续改检测、气泡、OCR 等 pipeline 流程。
- 只把进度按钮左侧 spinner 从主线程 CSS 旋转迁移到 `OffscreenCanvas + Worker`。
- 保留 SVG/CSS fallback，确保不支持 OffscreenCanvas 或 Worker 失败时视觉不消失。

## 实现内容

- `src/content/core/ui.ts`
  - 新增单例 spinner Worker，用 `transferControlToOffscreen()` 接收 16px canvas。
  - Worker 仅在 spinner active 时绘制，停止运行后暂停循环。
  - `.mt-x-spinner[data-renderer='offscreen']` 禁用主线程 CSS 旋转，canvas 由 Worker 绘制。
  - `.mt-x-spinner[data-renderer='css']` 保留原 SVG 静态弧 + `transform` 旋转 fallback。
  - 浮层和截图结果 UI 增加 `dispose()`，移除 DOM 前释放 Worker canvas 绑定。
- `src/content/core/TranslatorCore.ts`
  - 图片浮层、截图结果和阅读栏移除前调用 `dispose()`。
  - 阅读栏每次渲染后同步当前页/全部按钮 spinner active 状态。
- `benchmark/perf/src/run-browser-ui-jank-smoke.ts`
  - 新增真实浏览器 UI jank smoke。
  - 报告中记录 spinner `renderer/hasCanvas/hasFallback/visible`，用于确认是否实际启用 offscreen 路径。

## 实测记录

### 迁移前观测

- report: `benchmark/perf/reports/ui-jank-2026-06-03T13-40-20-185Z.json`
- 主线程 frame: max `1291.7ms`, p95 `16.6ms`, longestSlowStreak `8`
- Worker heartbeat: max `258.3ms`, p95 `8.5ms`, longestSlowStreak `1`
- 结论：Worker 心跳明显更平滑，值得尝试 Worker 侧 spinner。

### 迁移后观测

- report: `benchmark/perf/reports/ui-jank-2026-06-03T13-50-02-142Z.json`
- spinner: `renderer=offscreen`, `hasCanvas=true`, `hasFallback=true`
- 主线程 frame: max `1149.8ms`, p95 `8.7ms`, longestSlowStreak `4`
- Worker heartbeat: max `1149.7ms`, p95 `8.5ms`, longestSlowStreak `1`
- UI render: max `24.1ms`, renderCalls `18`
- 结论：
  - Offscreen spinner 已在真实扩展运行中启用。
  - p95 和连续慢帧有所改善，但仍存在 1s 级全局 stall。
  - 这些 spike 同时影响主线程和 worker heartbeat，更像 ORT/WebGPU/浏览器调度或 GPU 竞争，不能只靠 spinner Worker 完全消除。

## 验证命令

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
