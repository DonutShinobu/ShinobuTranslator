# 技术设计：翻译进度动画优化方案

## 现状判断

旧的“ONNX 推理阻塞主线程”问题已经大部分被 worker 化。当前动画不是彻底冻结，而是明显掉帧和断续。这个现象更像是多源叠加：

1. 药丸自身仍有容易受主线程影响的更新方式。
2. pipeline 仍有多段同步图像处理、DOM canvas 读写和像素循环在主线程。
3. worker 通信时部分输入数据 structured clone，会在主线程产生序列化成本。
4. 进度 UI 只有阶段文本，不提供可独立运行的进度心跳；阶段内如果主线程频繁出现 50ms 以上阻塞，用户看到的就是“还在动，但很卡”。

## 证据地图

- `src/content/core/ui.ts`
  - `.mt-x-spinner svg circle` 动画 `stroke-dasharray` / `stroke-dashoffset`。
  - `renderUi()` 每次阶段变化读宽度、改文字、设置打字机定时器和 width transition。
- `src/content/core/TranslatorCore.ts`
  - `updatePipelineProgress()` 把 pipeline 阶段映射为 `stageText`，再立即 render。
  - `runPipelineFromFile()` 没有阶段内心跳或 long task 采样。
- `src/runtime/onnxWorkerBridge.ts`
  - worker 已存在。
  - 输入 structured clone，输出 transfer。
- `src/pipeline/detect/onnxDetect.ts`
  - WebGPU detector 可在 worker 内做 GPU preprocess。
  - 输出后处理、component 提取和 mask canvas 构建仍在主线程。
- `src/pipeline/ocr/index.ts` + `src/pipeline/ocr/preprocess.ts`
  - OCR decode 在 worker。
  - OCR 输入构建和逐区域图像处理在主线程。
- `src/pipeline/inpaint.ts`
  - inpaint 推理在 worker。
  - 前处理、输出 decode、整图 resize、整图合成在主线程。
- `src/pipeline/maskRefinement/*`、`src/pipeline/typeset*`
  - mask 和排版仍是主线程同步计算。

## 外部技术约束

- Chrome/MDN 将 50ms 作为 long task / long animation frame 的关键观察阈值。
- `scheduler.yield()` 可以让可切分任务让出主线程，但不是所有浏览器 baseline，必须特性检测，并在不可用时使用 `setTimeout(0)` 或只在支持时启用。
- OffscreenCanvas 2D 已是广泛可用能力，并可在 Web Workers 中使用，但迁移 canvas/font/typeset 需要额外验证字体加载、资源生命周期和 transfer 边界。

参考：
- https://developer.mozilla.org/en-US/docs/Web/API/Scheduler/yield
- https://web.dev/articles/optimize-long-tasks
- https://developer.chrome.com/docs/web-platform/long-animation-frames
- https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/CSS_JavaScript_animation_performance
- https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvasRenderingContext2D

## 第一轮方案：观测与归因

第一轮不修改动画表现，只新增低侵入观测。目标是把“看起来卡”拆成可解释的数据。后续优化优先改调度、分片、worker 边界和数据搬运，不能改变药丸动画的最终视觉效果。

### 观测指标

- 帧间隔：
  - 翻译期间启动 `requestAnimationFrame` sampler。
  - 记录 frame delta、最大 delta、p95 delta、超过 33ms / 50ms / 100ms 的帧数、最长连续慢帧。
  - 这个指标最贴近用户看到的动画不顺。
- Long Animation Frame：
  - 如果 `PerformanceObserver.supportedEntryTypes` 支持 `long-animation-frame`，记录 duration、blockingDuration、renderStart、script 摘要。
  - 用于解释“多个小任务累计拖长一帧”的情况。
- Long Task fallback：
  - 如果支持 `longtask`，记录 startTime、duration、attribution。
  - 用于老一点的 Chrome 或 LoAF 不可用场景。
- UI render 成本：
  - 包装 `renderUi()` / `renderScreenshotResultUi()` 调用，记录调用次数、总耗时、最大耗时、阶段文本变化次数。
  - 重点看 `getBoundingClientRect()` 测宽和打字机定时器是否在阶段切换时造成局部尖峰。
- Pipeline stage：
  - 复用现有 `stageTimings`。
  - 在阶段开始/结束时记录 `performance.mark()`，用于和 LoAF / long task 时间戳对齐。
- 关键子阶段：
  - OCR preprocess：candidate 数、prepared 数、preprocessTotalMs、最大单 region preprocess。
  - detect postprocess：输出 tensor 后到 regions/mask canvas 完成的耗时。
  - inpaint：preprocess、worker run、decode、resize、compose 分段耗时。
  - `canvasToBlob()` / debug canvas 生成耗时。
- Worker roundtrip：
  - 包装 `createSession`、`runInference`、`runOcrSplitBatchDecode`、`runDetectWithGpuPreprocess`。
  - 记录模型、provider、输入 payload 估算字节数、输出 payload 估算字节数、roundtrip duration。
  - 这不能直接分离 structured clone 和 worker 执行，但能和 LoAF 时间戳交叉判断。

### 输出格式

性能摘要挂在 debug log 中；若未开启 debug log，可在开发模式 console 输出一行结构化摘要。建议结构：

```ts
type ProgressJankReport = {
  runId: string;
  entry: "image" | "screenshot" | "context-image" | "reading-mode";
  totalMs: number;
  frame: {
    samples: number;
    maxDeltaMs: number;
    p95DeltaMs: number;
    over33Count: number;
    over50Count: number;
    over100Count: number;
    longestSlowStreak: number;
  };
  ui: {
    renderCalls: number;
    renderTotalMs: number;
    renderMaxMs: number;
    stageTextChanges: number;
  };
  stages: Array<{
    stage: string;
    startMs: number;
    durationMs: number;
    maxFrameDeltaMs: number;
    longFrameCount: number;
    longTaskCount: number;
  }>;
  workerCalls: Array<{
    kind: string;
    model?: string;
    provider?: string;
    inputBytes?: number;
    outputBytes?: number;
    durationMs: number;
  }>;
  longFrames: Array<{
    startMs: number;
    durationMs: number;
    blockingDurationMs?: number;
    stage?: string;
  }>;
  longTasks: Array<{
    startMs: number;
    durationMs: number;
    stage?: string;
  }>;
};
```

### 阶段归因规则

- 如果 rAF 慢帧和 LoAF 集中在 `renderUi()` 调用附近，优先怀疑药丸文本/宽度动画和布局测量。
- 如果 LoAF 集中在 OCR preprocess，优先怀疑 `buildOcrInput()`、透视变换和 `getImageData()`。
- 如果 LoAF 集中在 detect 后处理，优先怀疑 mask component 提取、convex hull / minAreaRect 和 mask canvas 构建。
- 如果 LoAF 集中在 inpaint 推理前后，而 worker call 本身不产生主线程 LoAF，优先怀疑前处理、输出 decode、resize、compose。
- 如果 worker roundtrip 长且起止附近伴随 LoAF，但阶段内没有明显 JS 子阶段，怀疑 structured clone、GPU contention 或浏览器内部调度。
- 如果 rAF 慢帧很多但 longtask/LoAF 记录少，补充 Chrome DevTools Performance 录制和页面 FPS overlay，排查 host page 合成/绘制压力。

### 隔离实验

第一轮观测实现后，每次只改一个变量做对照：

1. Baseline：当前动画 + 当前 pipeline，跑普通图片、截图翻译、阅读模式各至少一次。
2. UI 静默对照：仅在临时诊断分支中关闭药丸打字机/圆弧/扫光动画，只保留静态 running 文案，判断 UI 动画自身占比；该对照不能作为最终改动保留。
3. Process mode 对照：分别跑 `original`、`erase`、`translate`，隔离 typeset、inpaint、翻译网络/LLM 的影响。
4. Debug log 对照：开启/关闭 debug log，确认 debug canvas 和 JSON 生成是否放大卡顿。
5. 图片规模对照：小图、中图、大图各跑一次，判断是否由整图像素循环主导。

### 第一轮交付

- 一套可开关的观测工具。
- 一份或多份单次翻译性能摘要。
- 基于摘要给出下一个最值得尝试的优化项。

## 后续方案 A：主线程 cooperative yielding

给仍必须在主线程执行的纯 JS 循环增加时间片让出：

- 新增 `yieldToMain()`：优先 `globalThis.scheduler?.yield?.()`，fallback `setTimeout(0)`。
- 新增 `maybeYield(startedAt, budgetMs)`，只在超过预算时 yield，避免每次循环都付调度成本。
- 优先应用在：
  - OCR 逐区域 `buildOcrInput()` 循环。
  - OCR chunk decode 之间。
  - mask refinement region/component 循环。
  - inpaint 后处理几个整图循环之间。
  - typeset 多 region 渲染循环之间。
- 不在紧密像素内层逐像素 yield，避免总耗时暴涨。

优点：
- 可以把明显长任务拆成多段，让 UI 有绘制机会。
- 不需要立即重构 worker 数据流。

风险：
- pipeline 函数需要变成 async 或传播 async 边界。
- 总耗时可能略增。
- 与并行阶段 `Promise.all` 交织后，progress 顺序需要保持稳定。

## 后续方案 B：迁移主线程图像子阶段到 worker

如果方案 B/C 后仍有明显冻结，迁移实测最大子阶段：

- 短期优先候选：
  - OCR preprocess worker 化：传 `ImageBitmap` 或图像像素、regions，返回 batch input。
  - inpaint pre/post worker 化：worker 内完成 resize、decode、compose，主线程只拿最终 canvas/blob。
  - detection postprocess worker 化：让 detector worker 在返回前完成 mask components 和 raw mask 生成。
- 中长期候选：
  - 新建 pipeline worker，主线程只负责 UI、截图、下载和最终 object URL。
  - 逐步把 `browserPlatform` 的 canvas 能力抽象为主线程 canvas / OffscreenCanvas 双实现。

优点：
- 根治主线程冻结的能力最强。
- 与当前“ONNX worker 化”的方向一致。

风险：
- 边界大，容易影响调试图、字体、canvas blob、object URL、fallback。
- 需要较多浏览器真实环境验证。

## 推荐路线

推荐把工作拆开推进：

1. 第一轮做观测与归因。
2. 根据报告选择一个最可能有效的优化项。
3. 每做一个优化项都复测同一组输入，确认 max frame delta、p95 delta、LoAF 数量和主观观感是否改善。
4. 优先尝试不改变视觉效果的主线程 yielding。
5. 如果 yielding 后仍有明确长任务集中在某个子阶段，再迁移该子阶段到 worker。
6. UI 降噪只允许作为诊断对照；最终改动必须保留药丸动画视觉效果。

这个路线符合当前现象：动画没有完全冻结，所以第一目标不是“救活动画”，而是解释掉帧来源。

## 验证策略

- `npx tsc --noEmit`
- `npm run build`
- 浏览器手测普通图片翻译、右键浮动结果、截图翻译、Pixiv 阅读模式药丸。
- 开启调试采样后观察：
  - running 期间最大帧间隔、p95 帧间隔、慢帧数量。
  - LoAF / long task 在各 pipeline stage 的分布。
  - `renderUi()` 是否出现阶段切换尖峰。
  - worker roundtrip 是否和慢帧重叠。
- 对比翻译前后截图，确认译图质量无变化。

## 风险和回滚

- UI 修补可单独回滚到旧 `renderUi()` 动画策略。
- yielding 若影响总耗时或进度顺序，可逐阶段关闭。
- worker 迁移必须分子阶段推进，每个阶段保留旧路径作为临时 fallback，直到真实浏览器验证稳定。
