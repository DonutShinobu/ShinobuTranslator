# 阶段明细可视化卡片

## Goal

把翻译完成后的阶段明细从纯文本多行改成可展开/收起的可视化卡片，让用户能快速看懂总耗时、各阶段耗时占比，以及 detector / OCR / inpaint 等模型的运行时情况。

用户价值：
- 完成后直接看到性能瓶颈，不需要下载日志或读控制台。
- 阶段明细更紧凑、更可扫读，不挤占翻译中进度反馈。
- 展开状态跟随用户习惯，新装用户默认展开。

## Confirmed Facts

- 当前版本已执行 `npm run build` 并通过；仅有 `onnxruntime-web` eval 警告和 `onnxWorker.js` chunk 体积警告。
- `showElapsedTime` / `showStageTimingDetails` 已存在于 `ExtensionSettings`，由 popup 调试选项控制，并通过 `mangaTranslate.settings` 持久化。
- `TranslatorCore.loadPipelineRunSettings()` 当前只在 `showElapsedTime` 打开且 `showStageTimingDetails` 打开时传入阶段明细，并把 `showRuntimeStages` 绑定为阶段明细开启。
- 翻译完成后，`TranslatorCore` 调用 `formatElapsedText()`，把 `artifacts.stageTimings`、`artifacts.runtimeStages` 和 `translationDebug` 格式化成 `state.elapsedText`。
- `renderUi()` 当前把 `state.elapsedText` 写进 `.mt-x-detail`，展示形态是纯文本多行。
- pipeline 已提供 `StageTiming[]`，字段为 `stage`、`label`、`durationMs`。
- pipeline 已提供 `RuntimeStageStatus[]`，覆盖 `detector`、`ocr`、`inpaint` 的 enabled/provider/webnnDeviceType 等运行时状态。
- debug log 开启时已有 `ProgressJankReport`，包含 worker call、main-thread task、stage summary 等诊断数据；本任务的主要展示不应要求用户开启日志。
- 内容脚本 UI 必须继续使用 imperative DOM 和 `mt-x-` 前缀 CSS，不能引入 React。
- 产品设计基调为轻巧、精致、粉色点缀；该卡片属于 product UI，应服务结果可读性，避免重装饰。

## Product Decisions

- 阶段明细卡片只在翻译完成后展示，不在运行中展示。
- 卡片支持展开/收起。
- 展开状态需要记住上一次用户选择。
- 新装用户不默认开启“显示耗时/阶段明细”；但用户开启阶段明细后，卡片首次默认展开。
- 可视化需要包含各阶段时长占比和模型运行时情况。

## Requirements

- 保留现有 popup 中“显示耗时”“阶段明细”的设置入口和语义。
- 当翻译完成且用户开启耗时展示时，结果提示显示总耗时。
- 当翻译完成且用户开启阶段明细时，用可视化卡片替代当前多行纯文本阶段列表。
- 卡片折叠时应保留低噪声摘要，至少包含总耗时和可展开 affordance。
- 卡片展开时展示阶段耗时占比，包含阶段中文名、耗时、百分比和横向占比条。
- 卡片展开时展示模型运行时情况，至少包含检测、OCR、去字三个模型的 provider 状态；未启用或未知状态也要可读。
- 翻译阶段如果存在 LLM fallback 信息，继续在翻译阶段展示“有回退/无回退”。
- 展开/收起状态持久化到现有设置归一化路径中，不新建独立存储。
- 新装用户默认展开卡片。
- 展示文案保持中文。
- 样式必须使用内容脚本注入 CSS，类名使用 `mt-x-` 前缀。
- 不改变翻译结果、模型选择、pipeline 阶段执行顺序、进度动画视觉效果或 debug log 下载行为。

## Acceptance Criteria

- [x] `npm run build` 通过。
- [x] `npx tsc --noEmit` 通过。
- [x] `npm run test` 通过，或明确说明失败原因与本任务关系。
- [x] `node --check dist/content.js`、`dist/chunks/orchestrator.js`、`dist/chunks/onnxWorkerBridge.js`、`dist/onnxWorker.js` 通过。
- [x] 开启“显示耗时”但关闭“阶段明细”时，仍只展示简洁总耗时，不展示可视化阶段卡片。
- [x] 开启“显示耗时”和“阶段明细”时，翻译完成后展示可展开/收起的阶段明细卡片。
- [x] 卡片展开时能看到各阶段占比和模型运行时情况。
- [x] 用户点击展开/收起后，下一次翻译完成沿用上一次展开状态。
- [x] 新装或缺失该设置字段时，阶段明细卡片默认展开。
- [x] 运行中进度 UI 不出现阶段明细卡片，不改变 spinner、扫光、打字机/宽度过渡等既有行为。
- [x] 内容脚本不引入 React、CSS-in-JS、Tailwind 或未加 `mt-x-` 前缀的样式。

## Out of Scope

- 不优化模型推理速度。
- 不调整进度动画性能或翻译中阶段文案。
- 不新增图表库或外部 UI 依赖。
- 不重新设计 popup 调试选项区域。
- 不要求 debug log 开启后才显示基础阶段卡片。

## Open Questions

- None.
