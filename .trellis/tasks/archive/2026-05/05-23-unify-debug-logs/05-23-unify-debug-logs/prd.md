# 统一日志功能：合并排版调试与ORT调试为日志记录

## 目标

将"排版调试"和"ORT 调试"两个选项重构为职责清晰的三个独立功能：
- **排版调试** → 仅控制可视化叠层（列框、字体适配信息等）
- **日志记录**（原 ORT 调试位置）→ 控制诊断数据采集 + "下载日志"按钮显示
- **下载日志** → 按钮可见性由"日志记录"控制，与"排版调试"解耦

日志内容保持现有排版调试日志的完整数据（流水线诊断 + 源图base64），移除 ORT profiling 相关内容。

## 需求

1. `showTypesetDebug` 保持独立，仅控制排版调试的可视化叠层渲染
2. 将 `ortDebugMode` 重命名为 `enableDebugLog`（UI 显示"日志记录"），控制诊断数据采集
3. "下载日志"按钮的显示条件从 `showTypesetDebug && debugLogData` 改为 `enableDebugLog && debugLogData`
4. 移除所有 ORT profiling 相关代码：`setOrtDebugConfig()`、`downloadDebugReport()`、PaddleOCR 中的自动下载
5. 内置OCR和PaddleOCR的流水线诊断数据统一通过 `toTypesetDebugDownloadData()` 收集

## 具体变更

### 设置层 (`src/shared/config.ts`)
- 删除 `ortDebugMode: boolean`
- 新增 `enableDebugLog: boolean`
- 更新 `defaultExtensionSettings`、`normalizeSettings`、`toPipelineConfig`

### UI 层 (`src/popup/App.tsx`)
- "ORT 调试" checkbox → "日志记录" checkbox，绑定 `enableDebugLog`

### 翻译核心 (`src/content/core/TranslatorCore.ts`)
- 删除 `setOrtDebugConfig()` 调用
- `debugLogData` 的赋值条件从 `showTypesetDebug` 改为 `enableDebugLog`
- `debugOriginalCanvas` 的生成条件保持 `showTypesetDebug`
- 源图 base64 的生成条件从 `showTypesetDebug` 改为 `enableDebugLog`

### 阅读模式 UI (`src/content/core/ui.ts`)
- "下载日志"按钮显示条件从 `showTypesetDebug && debugLogData` 改为 `enableDebugLog && debugLogData`

### 类型层 (`src/content/core/types.ts`)
- `PhotoState` 保持不变（`showTypesetDebug` + `debugLogData` 字段含义不变）

### 清理
- 删除 `src/runtime/ortDebugDownload.ts`
- 删除 `src/shared/messages.ts` 中的 `DownloadDebugReportMessage`
- 删除 `src/pipeline/ocr/paddleocrProvider.ts` 中的 `downloadDebugReport` 导入和调用
- 删除 `src/runtime/onnxWorkerBridge.ts` 中的 `setOrtDebugConfig` / `globalOrtDebugConfig`
- 清理 `src/runtime/onnx.ts` 中 `ensureOrtEnv` 的 `debugConfig` 参数
- 清理 `src/workers/onnx-worker.ts` 中的 `debugConfig`、`profilingLog` 和相关逻辑
- 清理 `src/runtime/onnxWorkerTypes.ts` 中的 `OrtDebugConfig`、`WebGpuProfilingDataV1`

## 未变更

- `showTypesetDebug` 仍控制排版叠层可视化 + `debugOriginalCanvas` 生成
- 日志 JSON 结构保持不变（`TypesetDebugDownloadData`）
- `downloadJson()` 工具函数保持不变

## 已确认决策

- 日志保留源图 base64（保持自包含）
- 新增 `pageUrl` 字段记录当前页面地址（`window.location.href`）

## 待确认问题

（已全部解决）

## 技术约束

- 修改涉及 7+ 文件
- 需要清理 ORT profiling 的跨文件依赖链

## 涉及文件清单

| 文件 | 变更类型 |
|------|----------|
| `src/shared/config.ts` | 修改：替换 ortDebugMode → enableDebugLog |
| `src/popup/App.tsx` | 修改：UI checkbox 文字和绑定字段 |
| `src/content/core/TranslatorCore.ts` | 修改：解耦 debugLogData 和 showTypesetDebug，删除 ORT 相关 |
| `src/content/core/ui.ts` | 修改：下载按钮显示条件 |
| `src/content/core/types.ts` | 不变 |
| `src/runtime/ortDebugDownload.ts` | 删除 |
| `src/shared/messages.ts` | 修改：删除 DownloadDebugReportMessage |
| `src/pipeline/ocr/paddleocrProvider.ts` | 修改：删除 downloadDebugReport 调用 |
| `src/runtime/onnxWorkerBridge.ts` | 修改：删除 setOrtDebugConfig |
| `src/runtime/onnx.ts` | 修改：删除 ensureOrtEnv 的 debugConfig 参数 |
| `src/runtime/onnxWorkerTypes.ts` | 修改：删除 OrtDebugConfig, WebGpuProfilingDataV1 |
| `src/workers/onnx-worker.ts` | 修改：删除 debugConfig 和 profilingLog |
