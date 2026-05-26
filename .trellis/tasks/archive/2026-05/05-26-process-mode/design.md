# Design: 处理模式（翻译模式与去字模式）

## 涉及文件

| 文件 | 改动 |
|------|------|
| `src/shared/config.ts` | 新增 `ProcessMode` 类型、`processMode` 字段、normalize、toPipelineConfig 透传 |
| `src/types.ts` | `PipelineConfig` 新增 `processMode` 字段 |
| `src/popup/App.tsx` | 新增"模式"panel UI |
| `src/pipeline/orchestrator.ts` | pipeline 逻辑分支：skip translate/typeset、eraseDebug 改造 |
| `src/shared/messages.ts` | 如有 settings 同步相关消息，确认无需改动 |

## 详细设计

### 1. 配置层 (`src/shared/config.ts`)

新增类型：
```ts
export type ProcessMode = 'translate' | 'erase';
```

`ExtensionSettings` 新增字段：
```ts
processMode: ProcessMode; // 默认 'translate'
```

`DEFAULT_SETTINGS` 添加：`processMode: 'translate'`

新增 `normalizeProcessMode()` 函数，无效值回退到 `'translate'`。

`normalizeSettings()` 中调用 normalize。

`toPipelineConfig()` 中透传 `processMode`。

### 2. PipelineConfig (`src/types.ts`)

`PipelineConfig` 新增：
```ts
processMode: ProcessMode;
```

### 3. UI 层 (`src/popup/App.tsx`)

在 OCR 引擎 panel 后面新增 panel：
```tsx
<section className="panel">
  <div className="panel-title">模式</div>
  <div className="radio-group">
    <label className={`radio-row${settings.processMode === 'translate' ? ' selected' : ''}`}>
      <input type="radio" name="processMode" value="translate" ... />
      <span className="radio-label">翻译模式</span>
    </label>
    <label className={`radio-row${settings.processMode === 'erase' ? ' selected' : ''}`}>
      <input type="radio" name="processMode" value="erase" ... />
      <span className="radio-label">去字模式</span>
    </label>
  </div>
</section>
```

遵循现有 radio group 的样式和交互模式（与 OCR 引擎 panel 一致）。

### 4. Pipeline 层 (`src/pipeline/orchestrator.ts`)

#### 4a. 跳过翻译逻辑

当前翻译在 `Promise.all` 中与去字并行执行。改造：

```ts
const shouldSkipTranslate = config.processMode === 'erase' || config.eraseDebug;

if (shouldSkipTranslate) {
  // 不执行翻译，regions 保持无翻译文本
} else {
  // 执行原有翻译逻辑
}
```

#### 4b. 跳过排版逻辑

```ts
if (config.processMode === 'erase') {
  resultCanvas = cleanedCanvas; // 直接用 inpaint 结果
} else {
  // 执行原有排版逻辑
  resultCanvas = drawTypeset(cleanedCanvas, ...);
}
```

#### 4c. eraseDebug 输出改造

`buildEraseDebugCanvas` 新增 `baseCanvas?` 参数：

```ts
function buildEraseDebugCanvas(
  originalCanvas: HTMLCanvasElement,
  debugLayers: MaskDebugLayers,
  baseCanvas?: HTMLCanvasElement  // 新增
): HTMLCanvasElement
```

内部用 `baseCanvas ?? originalCanvas` 作为底图。

调用处：
```ts
if (config.eraseDebug && eraseDebugCanvas) {
  if (config.processMode === 'erase') {
    resultCanvas = buildEraseDebugCanvas(originalCanvas, debugLayers, cleanedCanvas);
  } else {
    resultCanvas = buildEraseDebugCanvas(originalCanvas, debugLayers); // 原行为
  }
}
```

注意：eraseDebug canvas 的构建不再在 pipeline 末尾替换 resultCanvas，而是在 erase 分支和翻译模式分支分别处理，逻辑更清晰。

#### 4d. 并行结构调整

当前 `Promise.all` 包含 translate 和 erase 两个并行任务。当 `shouldSkipTranslate` 时：
- 不启动 translate promise
- erase 任务独立执行（不再包在 Promise.all 中）
- 或用 `Promise.all([eraseTask])` 保持结构一致

推荐：erase 任务独立 await，去掉 Promise.all 包装，代码更直观。

### 5. 数据流

```
ExtensionSettings.processMode
  → toPipelineConfig()
    → PipelineConfig.processMode
      → orchestrator.runPipeline() 分支判断
        → shouldSkipTranslate = (processMode === 'erase' || eraseDebug)
        → 跳过/执行翻译
        → 跳过/执行排版
        → eraseDebug 底图选择
```

## 兼容性

- `processMode` 默认值为 `'translate'`，现有用户无感知升级
- `normalizeProcessMode()` 处理旧版本 settings 无此字段的情况
- pipeline 行为完全向后兼容
