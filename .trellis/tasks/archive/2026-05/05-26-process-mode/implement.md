# Implement: 处理模式

## 执行步骤

### Step 1: 配置层 — 新增 ProcessMode 类型和字段
- 文件: `src/shared/config.ts`
- [ ] 新增 `ProcessMode` 类型 (`'translate' | 'erase'`)
- [ ] `ExtensionSettings` 新增 `processMode` 字段
- [ ] `DEFAULT_SETTINGS` 添加 `processMode: 'translate'`
- [ ] 新增 `normalizeProcessMode()` 函数
- [ ] `normalizeSettings()` 中调用 normalize
- [ ] `toPipelineConfig()` 中透传 `processMode`
- 验证: `npx tsc --noEmit` 通过

### Step 2: PipelineConfig 类型
- 文件: `src/types.ts`
- [ ] `PipelineConfig` 新增 `processMode: ProcessMode`
- 验证: `npx tsc --noEmit` 通过

### Step 3: Pipeline 逻辑改造
- 文件: `src/pipeline/orchestrator.ts`
- [ ] `buildEraseDebugCanvas` 新增 `baseCanvas?` 参数，默认用 originalCanvas
- [ ] 翻译跳过逻辑: `shouldSkipTranslate = config.processMode === 'erase' || config.eraseDebug`
- [ ] 去字模式下跳过翻译（不启动 translate promise）
- [ ] 去字模式下跳过排版，`resultCanvas = cleanedCanvas`
- [ ] eraseDebug 输出: 去字模式用 cleanedCanvas 作底图，翻译模式用 originalCanvas
- [ ] 去字模式下 eraseDebug canvas 构建后赋值给 resultCanvas
- 验证: `npx tsc --noEmit` 通过

### Step 4: UI 层
- 文件: `src/popup/App.tsx`
- [ ] 在 OCR 引擎 panel 后新增"模式"panel
- [ ] radio group: 翻译模式 / 去字模式
- [ ] 绑定 `settings.processMode`
- 验证: `npx tsc --noEmit` 通过

### Step 5: 构建验证
- [ ] `npm run build` 通过
- [ ] 编译插件并替换 D:\Downloads\ShinobuTranslator 供用户测试
