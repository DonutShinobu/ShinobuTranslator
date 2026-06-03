# 阶段明细可视化卡片执行计划

## Checklist

1. 进入实现前运行 `task.py start`，并加载 `trellis-before-dev`。
2. 扩展设置类型：
   - `ExtensionSettings` 新增 `stageTimingCardExpanded`。
   - 默认值 `true`。
   - `normalizeSettings()` 缺失字段回退默认值。
3. 扩展内容脚本状态类型：
   - 新增阶段卡片展示数据类型。
   - `PhotoState` 增加可选阶段卡片数据字段。
4. 提取结构化展示构建逻辑：
   - 总耗时。
   - 阶段行 label/duration/percent/fallback。
   - runtime chips。
5. 更新 `TranslatorCore`：
   - 运行开始时清空卡片数据。
   - 完成后按设置写入纯文本或卡片数据。
   - 添加展开切换持久化逻辑。
6. 更新 `ui.ts`：
   - `UiElements` 添加卡片元素。
   - `createUiElements()` 创建卡片 DOM。
   - `renderUi()` 同步折叠/展开、阶段行、runtime chips 和点击状态。
   - 注入符合现有主题变量的 `mt-x-` CSS。
7. 验证普通图片 overlay 和截图结果 overlay 共用渲染路径没有破坏。

## Validation Commands

- `npx tsc --noEmit`
- `npm run test`
- `npm run build`
- `node --check dist/content.js`
- `node --check dist/chunks/orchestrator.js`
- `node --check dist/chunks/onnxWorkerBridge.js`
- `node --check dist/onnxWorker.js`

## Risky Files

- `src/content/core/ui.ts`：体积较大，渲染逻辑和动画计时器已有复杂度，修改要保持运行态 pill 逻辑稳定。
- `src/content/core/TranslatorCore.ts`：翻译完成、错误处理、截图结果和普通图片路径共用，需避免状态残留。
- `src/shared/config.ts`：设置字段归一化影响 popup、background、content script 三端。

## Review Gates

- PRD 开放问题已清空。
- 设计不改变 pipeline 执行和模型行为。
- 构建和类型检查通过后再总结。
