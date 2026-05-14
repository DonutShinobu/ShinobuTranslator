# brainstorm: 防止翻译按钮动画在模型加载/OCR期间卡顿

## Goal

翻译按钮在 running 状态下有持续动画（发光扫描、旋转 spinner、打字机文字切换），但 ONNX 推理和图像预处理全部跑在主线程，导致动画冻结卡顿。需要在**视觉效果不变**的前提下消除卡顿。

## What I already know

* 所有 ONNX 推理（session.run、session.create）在主线程执行，`wasm.proxy = false` 明确禁用了 ORT 内置代理 Worker
* 自回归 OCR 解码循环是最大卡顿源——每个 decode step 调用一次 session.run，主线程被反复阻塞
* 画面预处理（canvas getImageData、warpPerspective、connectedComponents、dilate 等）全部同步执行
* 当前动画系统包含三类：CSS keyframe（glow-sweep / spin-rotate / spin-arc）、CSS transition（width / opacity / background-color）、JS 打字机（setTimeout + textContent）
* `stroke-dasharray` 动画和 `width` transition 不受合成器友好，主线程阻塞时会冻结
* 代码中没有任何 Web Worker / OffscreenCanvas / comlink 使用（仅 tesseract.js 内部有 Worker）
* 项目是 Chrome 扩展 content script，Worker 创建受限但可行

## Decision (ADR-lite)

**Context**: ONNX 推理是最大卡顿源（秒级阻塞），自回归 OCR 解码循环每个 step 调用 session.run() 反复阻塞主线程。需要将 ONNX 推理移至 Worker 解耦动画与计算。

**Decision**: 采用修改版方案 B——仅将 ONNX 推理移入自建 Worker，canvas 预处理等保留主线程。合成器友好动画优化延后处理。

**Consequences**: 主线程秒级阻塞消除（ONNX 在 Worker），剩余 50-200ms 预处理阻塞可通过后续合成器动画优化解决。自回归解码循环完整运行在 Worker 内（避免逐 step round-trip）。自建 Worker 作为 Vite 新入口打包，优于 ORT 内置代理（后者在 content script 环境不可行）。通信采用 comlink（RPC 风格，~3KB gzipped）。

## Assumptions

* 动画视觉效果（发光扫描、旋转、打字机）必须保持不变
* 不需要修改翻译管线的结果质量
* 合成器友好动画优化为后续独立任务

## Open Questions

_(已全部解决)_

## Requirements

* ONNX 推理（session.create + session.run + 自回归解码循环）移入自建 Worker
* selfCheck（runtime 能力探测）也移入 Worker（消除开头 0.5-1 秒阻塞）
* Worker 与主线程通过 comlink 通信
* 动画视觉效果与当前完全一致
* 翻译结果质量不受影响
* Worker 加载失败时直接报错（不做主线程 fallback）

## Acceptance Criteria (evolving)

* [ ] 在 ONNX 推理期间，CSS 动画（glow-sweep、spin-rotate）持续流畅运行
* [ ] spinner 弧线动画不出现秒级卡顿（短暂预处理阻塞可接受）
* [ ] 打字机文字切换在阶段过渡时正常执行
* [ ] 翻译结果与当前一致（无精度损失）
* [ ] selfCheck 在 Worker 内运行，不再阻塞主线程

## Definition of Done

* Lint / typecheck / CI green
* 主线程阻塞时间减少至 <50ms 间隔（让动画帧可渲染）
* 不引入新 Worker 相关的安全风险

## Out of Scope (explicit)

* 修改翻译结果质量或精度
* 重构动画视觉设计（效果必须不变）
* 优化 ONNX 推理速度本身（仅解决线程调度问题）
* 合成器友好动画优化（stroke-dasharray → transform、width → scaleX）
* canvas 预处理移入 Worker（OffscreenCanvas）
* 启用 ORT 内置代理 Worker（content script 环境下不可行）

## Technical Notes

### Worker 架构

* Worker 作为 Vite 新入口（`src/workers/onnx-worker.ts`），输出 `onnx-worker.js`
* manifest.json 新增 `web_accessible_resources`: `"onnx-worker.js"`
* content script 通过 `new Worker(chrome.runtime.getURL("onnx-worker.js"))` 创建 Worker
* Worker 运行在扩展 origin，可用 `chrome.runtime.getURL()` 加载 WASM 文件
* `chromeExtensionContentScriptPlugin` 需扩展以处理 Worker 入口的 `import.meta.url` 替换

### Worker 内职责

* 拥有所有 ONNX session（create + cache）
* 自回归 OCR 解码循环完整运行在 Worker 内（避免逐 step round-trip）
* selfCheck / probeRuntime 也运行在 Worker 内
* 设置 `env.wasm.proxy = false`（Worker 本身就是专用线程）
* WASM paths 用 `chrome.runtime.getURL("ort/")` 解析

### 主线程保留职责

* canvas 预处理（getImageData、warpPerspective 等）
* mask 优化（connectedComponents、dilate 等）
* 排版渲染（typeset）
* 所有 UI 动画

### 数据流

1. 主线程预处理 → 生成 input tensors（Float32Array）
2. 主线程 postMessage → 发送 input tensors（Transferable 零拷贝）
3. Worker 接收 → session.run() → 生成 output tensors
4. Worker postMessage → 回传 output tensors（Transferable）
5. 主线程后处理 → 继续管线

### 关键文件
  - `src/content/core/ui.ts` — 动画系统（CSS keyframe + JS 打字机）
  - `src/runtime/onnx.ts` — ORT 会话创建，`wasm.proxy = false`（L149）
  - `src/pipeline/orchestrator.ts` — 管线协调，所有阶段主线程
  - `src/pipeline/ocr/decodeAutoregressive.ts` — AR 解码循环（最大卡顿源）
  - `src/pipeline/detect/onnxDetect.ts` — 检测推理 + 预处理 + 后处理
  - `src/pipeline/ocr/preprocess.ts` — OCR 预处理（warpPerspective）
  - `src/pipeline/inpaint.ts` — 修复推理 + 预处理 + 合成
  - `src/pipeline/bubbleDetect.ts` — 气泡检测 + mask 解码
  - `src/pipeline/maskRefinement/algorithms.ts` — mask 优化算法
  - `src/pipeline/typeset.ts` — 排版渲染
  - `src/content/core/TranslatorCore.ts` — 进度回调是唯一动画更新点

* 非合成器友好动画：stroke-dasharray/dashoffset（spin-arc）、width transition、textContent mutation（打字机）
* 合成器友好动画：transform（glow-sweep translateX、spin-rotate rotate）、opacity transition