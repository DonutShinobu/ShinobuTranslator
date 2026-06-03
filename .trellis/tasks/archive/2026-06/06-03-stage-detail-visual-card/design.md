# 阶段明细可视化卡片设计

## Architecture and Boundaries

改动集中在内容脚本结果展示和共享设置：

- `src/shared/config.ts`
  - 新增布尔设置字段用于持久化阶段明细卡片展开状态。
  - 默认值为 `true`，归一化缺失字段时回落到默认值。
- `src/content/core/types.ts`
  - 扩展 `PhotoState`，让完成态可以携带结构化耗时展示数据，而不是只携带纯文本。
- `src/content/core/utils.ts`
  - 保留 `formatDuration()`、`formatRuntimeProvider()` 等格式化函数。
  - 新增或调整结构化构建函数，把 `stageTimings` / `runtimeStages` / `translationDebug` 转成 UI 友好的卡片数据。
  - 保留纯文本路径，支持“只显示总耗时”。
- `src/content/core/TranslatorCore.ts`
  - 翻译完成后生成结构化阶段卡片数据。
  - 展开状态来自当前设置。
  - 点击卡片切换时通过现有 `mt:get-settings` / `mt:set-settings` 消息持久化设置。
- `src/content/core/ui.ts`
  - `createUiElements()` 增加阶段卡片根节点，仍由 imperative DOM 创建。
  - `renderUi()` 根据 `PhotoState` 同步卡片 DOM 和 detail 文本。
  - CSS 写在 `injectStyles()` 内，全部使用 `mt-x-` 前缀。

不修改 pipeline 阶段执行，也不修改 ONNX worker、模型 registry 或翻译器。

## Data Flow

1. popup 保存现有 `showElapsedTime` / `showStageTimingDetails` 设置。
2. 用户点击翻译后，`TranslatorCore.loadPipelineRunSettings()` 读取设置。
3. pipeline 完成后返回 `artifacts.stageTimings` 和 `artifacts.runtimeStages`。
4. `TranslatorCore` 计算总耗时：
   - 仅 `showElapsedTime` 开启：写入简洁 `elapsedText`。
   - `showElapsedTime + showStageTimingDetails` 开启：写入结构化阶段卡片数据，并保留总耗时摘要。
5. `renderUi()` 在完成态渲染卡片；运行态继续只显示 stageText。
6. 用户点击卡片标题按钮切换展开状态，内容脚本更新 state，并通过 `mt:set-settings` 保存到 `mangaTranslate.settings`。
7. 下一次完成态展示读取保存后的展开状态。

## Display Contract

折叠态：
- 显示总耗时。
- 显示一个明确的展开/收起按钮。
- 不展示长阶段列表，避免遮挡图片。

展开态：
- 顶部为总耗时和阶段数量摘要。
- 阶段列表每行包含中文阶段名、耗时、百分比、占比条。
- 占比按本次 `stageTimings` 总和计算；若总和为 0，则所有百分比显示为 0%。
- runtime 区域以紧凑 chips 展示检测 / OCR / 去字的 provider，例如 `webgpu`、`webnn/gpu`、`cpu(wasm)`、`disabled`、`unknown`。
- 翻译阶段 fallback 信息跟随翻译阶段行展示。

## Compatibility

- 缺失新设置字段的新装或老用户：仅卡片展开状态默认为 `true`，不改变 `showElapsedTime` / `showStageTimingDetails` 的默认关闭状态。
- 旧设置中 `showElapsedTime` 为 false 时：继续不展示耗时和卡片。
- `showStageTimingDetails` 为 false 时：继续不展示阶段卡片，只保留总耗时文本。
- 没有 `runtimeStages` 或没有某个模型状态时：该模型 chip 可省略或显示未知，不影响卡片渲染。
- 截图翻译浮层和普通图片 overlay 复用同一 `renderUi()`，因此两者应同时支持卡片。

## Trade-offs

- 选择在内容脚本本地持久化展开状态，而不是把点击事件传给 popup：popup 不一定打开，内容脚本必须独立完成交互。
- 选择使用手写 DOM 和 CSS，而不是图表库：减少 bundle 和内容脚本风险，符合项目现有 UI 约束。
- 选择完成后展示：不干扰运行中动画，也避免频繁 render 阶段列表带来的额外 jank。

## Rollback

- 删除新增设置字段和归一化逻辑。
- 恢复 `renderUi()` 只写 `.mt-x-detail.textContent` 的纯文本路径。
- 删除新增卡片 DOM / CSS / 结构化数据类型。
