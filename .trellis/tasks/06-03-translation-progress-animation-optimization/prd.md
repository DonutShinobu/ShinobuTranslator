# 翻译进度动画优化调研

## 目标

翻译过程中药丸按钮需要持续给用户可靠的“正在工作”反馈。当前问题不是动画彻底冻结，而是模型运行和图像处理期间药丸动画明显掉帧、断续、视觉上很卡。本任务的最终目标是解决这类卡顿，同时不改变药丸动画的视觉效果；观测和分析只是第一步，用来量化卡顿发生在哪些阶段、由哪些主线程任务或 UI 更新造成，再按证据逐个尝试优化方案。

## 用户价值

- 用户点击翻译后能确认扩展仍在工作，而不是因为动画卡顿误以为扩展变慢或状态不可靠。
- 翻译阶段切换、截图结果浮层、阅读模式按钮等复用药丸 UI 的入口都应获得一致改进。
- 后续每个优化尝试都有基线数据可对比，避免凭感觉改动画。
- 优化不能改变翻译结果质量、模型选择、用户设置语义或药丸动画视觉效果。

## 已确认事实

- 内容脚本 UI 必须继续使用 imperative DOM，不能引入 React；class 继续使用 `mt-x-` 前缀。
- 药丸 UI 位于 `src/content/core/ui.ts`，运行态包含旋转 spinner、SVG 圆弧动画、发光扫光、阶段文本打字机、按钮宽度 transition。
- `renderUi()` 在状态或 `stageText` 变化时会读取 `getBoundingClientRect()`、临时改文字测量宽度、设置多个 `setTimeout()` 来做打字机动画。
- `TranslatorCore.updatePipelineProgress()` 只按 pipeline 阶段更新文本，没有连续百分比；`runPipelineFromFile()` 在 progress 回调里立即触发渲染。
- 旧任务 `05-14-prevent-animation-jank` 已把 ONNX session 创建、推理和 OCR AR decode 迁移到自建 worker；当前代码已有 `src/workers/onnx-worker.ts` 和 `src/runtime/onnxWorkerBridge.ts`。
- ONNX 输入张量当前通过 structured clone 传给 worker，注释说明这是为了保留 fallback 数据；输出张量由 worker transfer 回主线程。
- 检测 WebGPU 路径已有 worker 内 GPU 预处理，但检测输出后处理、mask component 提取、mask canvas 构建仍在主线程。
- OCR decode 在 worker 内，但 `generateTextDirection()`、逐区域 `buildOcrInput()`、透视变换、`getImageData()` 和 fallback 颜色采样仍在主线程。
- 去字阶段的 inpaint 推理在 worker 内，但前处理、输出 decode、原图/mask 读取、缩放和合成是主线程整图像素循环。
- mask refinement、typeset、debug 图和最终 canvas 转 blob 也在主线程。
- 现有 benchmark 有 stage timing 和 OCR substage debug，但缺少浏览器端 long task / long animation frame 观测。
- Web 平台资料确认：长任务会推迟交互和渲染；Chrome 可用 Long Animation Frames 观察被拖长的渲染帧；`scheduler.yield()` 可切分主线程长任务，但需要特性检测和 fallback。
- 用户反馈当前动画不会完全停住，但视觉上明显卡顿，因此观测指标需要覆盖帧间隔抖动、连续慢帧、阶段内 LoAF/long task，而不只判断是否无更新。

## 需求

- 第一轮实现先聚焦观测和分析；后续优化可以改调度、数据流、主线程让出或 worker 边界，但不能改药丸动画视觉效果。
- 定义可量化的卡顿观测方式，而不是只凭肉眼判断。
- 观测需要覆盖药丸 UI render 成本、浏览器帧间隔、Long Animation Frame / Long Task、pipeline stage timing、worker roundtrip 和主要主线程子阶段。
- 分析输出需要能回答：卡顿主要发生在药丸渲染、主线程图像处理、worker 通信、浏览器 canvas/blob API，还是外部页面压力。
- 后续优化方案按观测结果逐个尝试，每次只改变一个主要变量并复测；任何会改变药丸外观、节奏、文案过渡形态或运行态视觉元素的方案都不进入本任务。
- 方案必须保留中文进度文案、现有药丸视觉语义、截图/普通图片/阅读模式的交互含义。
- 方案必须兼容 Chrome MV3 content script 和现有 worker 打包方式。

## 验收标准

- [ ] 规划文档明确列出卡顿观测指标、采样位置、输出格式、分析方法和后续实验顺序。
- [ ] 第一轮实现后能生成单次翻译的性能摘要，至少包含最大帧间隔、慢帧数量、LoAF/long task 摘要、各阶段耗时、UI render 耗时和 worker roundtrip 摘要。
- [ ] 分析报告能把卡顿归因到具体阶段或标记为待进一步隔离。
- [ ] 后续优化实验有明确顺序，每一项都有复测指标。
- [ ] 经过优化后，翻译期间药丸动画主观上不再明显卡顿，并有帧间隔/LoAF 数据证明改善。
- [ ] 药丸动画视觉效果保持不变：spinner、扫光、打字机/宽度过渡、运行态状态语义和中文文案不因本任务改动而改变。
- [ ] 方案不要求改变模型精度、翻译质量、站点适配器边界或 popup 架构。
- [ ] 实现范围已明确：开始实施，持续推进到卡顿问题被解决；观测分析、调度优化和 worker 边界优化按证据逐项尝试。

## 暂不处理

- 不重做或弱化药丸视觉设计。
- 不改变药丸动画的外观、节奏或状态过渡视觉效果。
- 不优化模型本身的推理速度。
- 不改变翻译、OCR、去字、排版的输出质量。
- 不引入 React 或外部状态库到 content script。
- 不把整个 pipeline 一次性重写，除非用户明确选择高投入路径。

## 已定范围

- 已开始实施，直到药丸动画卡顿被解决。
- 优化按数据逐个尝试：优先主线程 cooperative yielding 和子阶段 worker 迁移等不改变视觉效果的方向；药丸 UI 降噪只能作为诊断对照，不作为最终改动保留。
