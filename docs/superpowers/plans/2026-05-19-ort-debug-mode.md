# ORT 调试模式实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在浏览器扩展中集成 ORT 调试模式，启用 verbose 日志 + per-kernel 验证 + WebGPU profiling，定位 PaddleOCR 在 WebGPU 上的推理失败算子。

**Architecture:** 新增 `ortDebugMode` 设置项，通过 Comlink bridge 传到 worker。Worker 中启用 `ort.env.logLevel/debug/webgpu.profiling`，收集 profiling 数据到数组，推理完成后传回主线程，自动下载为 JSON 文件。

**Tech Stack:** TypeScript, onnxruntime-web, Chrome Extension APIs (downloads), Comlink

---

### Task 1: 新增 OrtDebugConfig 类型

**Files:**
- Modify: `src/runtime/onnxWorkerTypes.ts`

- [ ] **Step 1: 定义 OrtDebugConfig 和 WebGpuProfilingDataV1 类型**

在 `onnxWorkerTypes.ts` 中添加：

```typescript
export type OrtDebugConfig = {
  logLevel: 'verbose' | 'info' | 'warning' | 'error' | 'fatal';
  debug: boolean;
  profiling: boolean;
};

export type WebGpuProfilingDataV1 = {
  version: 1;
  inputsMetadata: readonly { dims: readonly number[]; dataType: string }[];
  outputsMetadata: readonly { dims: readonly number[]; dataType: string }[];
  kernelId: number;
  kernelType: string;
  kernelName: string;
  programName: string;
  startTime: number;
  endTime: number;
};
```

- [ ] **Step 2: 扩展 OnnxWorkerApi.init 签名**

修改 `OnnxWorkerApi` 接口的 `init` 方法：

```typescript
init(ortPath: string, debugConfig?: OrtDebugConfig): Promise<void>;
```

- [ ] **Step 3: 扩展 InferenceResult 增加 profilingLog**

修改 `InferenceResult` 类型：

```typescript
export type InferenceResult = {
  outputs: Record<string, TensorTransport>;
  profilingLog?: WebGpuProfilingDataV1[];
};
```

- [ ] **Step 4: Commit**

```bash
git add src/runtime/onnxWorkerTypes.ts
git commit -m "feat: 定义 OrtDebugConfig 和 WebGpuProfilingDataV1 类型"
```

---

### Task 2: 新增 ortDebugMode 设置项

**Files:**
- Modify: `src/shared/config.ts`

- [ ] **Step 1: 添加 ortDebugMode 到 ExtensionSettings**

在 `ExtensionSettings` 类型中添加字段：

```typescript
export type ExtensionSettings = {
  // ...现有字段
  showTypesetDebug: boolean;
  ocrEngine: OcrEngine;
  ortDebugMode: boolean;
};
```

- [ ] **Step 2: 添加默认值**

在 `defaultExtensionSettings` 中添加：

```typescript
ortDebugMode: false,
```

- [ ] **Step 3: 在 normalizeSettings 中处理**

在 `normalizeSettings` 函数的返回值中添加：

```typescript
ortDebugMode: sanitizeBoolean(raw.ortDebugMode, false),
```

放在 `ocrEngine` 之后的同一位置。

- [ ] **Step 4: Commit**

```bash
git add src/shared/config.ts
git commit -m "feat: 添加 ortDebugMode 设置项"
```

---

### Task 3: Worker 侧调试配置和 profiling 数据收集

**Files:**
- Modify: `src/workers/onnx-worker.ts`

- [ ] **Step 1: 添加 debugConfig 变量和 init 函数修改**

在 worker 顶部添加：

```typescript
let debugConfig: OrtDebugConfig | undefined = undefined;
const profilingLog: WebGpuProfilingDataV1[] = [];
```

修改 `init` 函数：

```typescript
function init(ortPath: string, config?: OrtDebugConfig): Promise<void> {
  ortPathOverride = ortPath;
  debugConfig = config;
  return Promise.resolve();
}
```

需要新增 import：

```typescript
import type {
  // ...现有 imports
  OrtDebugConfig,
  WebGpuProfilingDataV1,
} from "../runtime/onnxWorkerTypes";
```

- [ ] **Step 2: 在 ensureOrtEnv 中应用调试配置**

修改 `ensureOrtEnv` 函数，在 `envInitialized = true` 之前添加调试配置：

```typescript
if (debugConfig) {
  ortAll.env.logLevel = debugConfig.logLevel;
  ortAll.env.debug = debugConfig.debug;
  if (debugConfig.profiling && ortAll.env.webgpu) {
    ortAll.env.webgpu.profiling = {
      mode: 'default',
      ondata: (data: WebGpuProfilingDataV1) => {
        profilingLog.push(data);
        console.log(
          `[ort-debug] ${data.kernelType}|${data.kernelName}: ${(data.endTime - data.startTime) / 1000}us`,
          `in:`, data.inputsMetadata.map(m => `${m.dataType}[${m.dims}]`),
          `out:`, data.outputsMetadata.map(m => `${m.dataType}[${m.dims}]`),
        );
      },
    };
  }
}
```

- [ ] **Step 3: 在 runInference 中收集和返回 profilingLog**

修改 `runInference` 函数：推理开始前清空 `profilingLog`，推理结束后将数据附到返回值。

在 `const outputs = await entry.session.run(ortFeeds);` 之前添加：

```typescript
profilingLog.length = 0;
```

在构造 `result` 时添加 profilingLog：

```typescript
const result: InferenceResult = {
  outputs: {},
  profilingLog: debugConfig?.profiling ? [...profilingLog] : undefined,
};
```

- [ ] **Step 4: Commit**

```bash
git add src/workers/onnx-worker.ts
git commit -m "feat: worker 侧 ORT 调试配置和 profiling 数据收集"
```

---

### Task 4: Bridge 侧传递 debugConfig

**Files:**
- Modify: `src/runtime/onnxWorkerBridge.ts`

- [ ] **Step 1: 新增 import**

在 import 中添加 `OrtDebugConfig`：

```typescript
import type {
  // ...现有 imports
  OrtDebugConfig,
} from "./onnxWorkerTypes";
```

- [ ] **Step 2: 添加 getOrtDebugConfig 辅助函数**

从 settings 读取 `ortDebugMode` 并构造 `OrtDebugConfig`。在 `ensureWorker` 之前添加：

```typescript
function getOrtDebugConfig(): OrtDebugConfig | undefined {
  // 设置由 content script 管理，通过 chrome.storage 读取。
  // bridge 初始化时 settings 可能还未加载，因此这里使用一个简单的全局变量，
  // 由 content script 在 pipeline 启动前设置。
  return globalOrtDebugConfig;
}

let globalOrtDebugConfig: OrtDebugConfig | undefined = undefined;

export function setOrtDebugConfig(config: OrtDebugConfig | undefined): void {
  globalOrtDebugConfig = config;
}
```

- [ ] **Step 3: 修改 ensureWorker 中 init 调用**

修改 `proxy.init(ortPath)` 为：

```typescript
await proxy.init(ortPath, getOrtDebugConfig());
```

- [ ] **Step 4: Commit**

```bash
git add src/runtime/onnxWorkerBridge.ts
git commit -m "feat: bridge 侧传递 OrtDebugConfig 到 worker"
```

---

### Task 5: 主线程 onnx.ts 调试配置

**Files:**
- Modify: `src/runtime/onnx.ts`

主线程的 `ensureOrtEnv()` 也需要支持调试配置（用于 session 创建前的探针阶段日志，以及未来可能的直接 session 创建场景）。

- [ ] **Step 1: 添加调试配置参数**

修改 `ensureOrtEnv` 函数签名：

```typescript
export function ensureOrtEnv(debugConfig?: OrtDebugConfig): void {
```

新增 import：

```typescript
import type { OrtDebugConfig } from "./onnxWorkerTypes";
```

- [ ] **Step 2: 在 ensureOrtEnv 中应用调试配置**

在 `envInitialized = true` 之前，与 worker 相同的逻辑：

```typescript
if (debugConfig) {
  ortAll.env.logLevel = debugConfig.logLevel;
  ortAll.env.debug = debugConfig.debug;
  if (debugConfig.profiling && ortAll.env.webgpu) {
    ortAll.env.webgpu.profiling = {
      mode: 'default',
      ondata: (data) => {
        console.log(
          `[ort-debug] ${data.kernelType}|${data.kernelName}: ${(data.endTime - data.startTime) / 1000}us`,
          `in:`, data.inputsMetadata.map(m => `${m.dataType}[${m.dims}]`),
          `out:`, data.outputsMetadata.map(m => `${m.dataType}[${m.dims}]`),
        );
      },
    };
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/runtime/onnx.ts
git commit -m "feat: 主线程 onnx.ts 支持 OrtDebugConfig"
```

---

### Task 6: Pipeline 层集成

**Files:**
- Modify: `src/content/core/TranslatorCore.ts`

需要在 TranslatorCore 中（pipeline 启动前）从 settings 读取 `ortDebugMode`，构造 `OrtDebugConfig`，调用 `setOrtDebugConfig` 传到 bridge。

- [ ] **Step 1: 添加 import**

在 TranslatorCore.ts 的 import 区域添加：

```typescript
import { setOrtDebugConfig } from '../../runtime/onnxWorkerBridge';
import type { OrtDebugConfig } from '../../runtime/onnxWorkerTypes';
```

- [ ] **Step 2: 在 pipeline 启动前设置 debugConfig**

在 TranslatorCore.ts 中 `const settings = settingsResponse.settings;` 之后（约 line 283），添加：

```typescript
if (settings.ortDebugMode) {
  setOrtDebugConfig({ logLevel: 'verbose', debug: true, profiling: true });
} else {
  setOrtDebugConfig(undefined);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/content/core/TranslatorCore.ts
git commit -m "feat: pipeline 启动前设置 OrtDebugConfig"
```

---

### Task 7: 调试日志保存为 JSON 文件

**Files:**
- Create: `src/runtime/ortDebugDownload.ts`

- [ ] **Step 1: 创建 OrtDebugReport 类型**

```typescript
export type OrtDebugReport = {
  timestamp: string;
  model: string;
  provider: string;
  success: boolean;
  error?: string;
  profilingLog: WebGpuProfilingDataV1[];
};
```

- [ ] **Step 2: 实现 downloadDebugReport 函数**

```typescript
import type { WebGpuProfilingDataV1 } from './onnxWorkerTypes';
import type { RuntimeProvider } from './onnxTypes';

export type OrtDebugReport = {
  timestamp: string;
  model: string;
  provider: string;
  success: boolean;
  error?: string;
  profilingLog: WebGpuProfilingDataV1[];
};

export function downloadDebugReport(
  model: string,
  provider: RuntimeProvider,
  success: boolean,
  error?: string,
  profilingLog?: WebGpuProfilingDataV1[],
): void {
  if (!profilingLog || profilingLog.length === 0) {
    return;
  }

  const report: OrtDebugReport = {
    timestamp: new Date().toISOString(),
    model,
    provider,
    success,
    error,
    profilingLog,
  };

  const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const chromeApi = (globalThis as typeof globalThis & {
    chrome?: { downloads?: { download?: (options: { url: string; filename: string; saveAs?: boolean }) => Promise<number> } };
  }).chrome;

  if (chromeApi?.downloads?.download) {
    chromeApi.downloads.download({
      url,
      filename: `ort-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
      saveAs: false,
    }).catch(() => {
      // Downloads API 失败时 fallback 到 <a> 标签下载
      fallbackDownload(url);
    });
  } else {
    fallbackDownload(url);
  }
}

function fallbackDownload(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = `ort-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 3: Commit**

```bash
git add src/runtime/ortDebugDownload.ts
git commit -m "feat: 调试日志保存为 JSON 文件下载"
```

---

### Task 8: 添加 downloads 权限到 manifest

**Files:**
- Modify: `public/manifest.json`

- [ ] **Step 1: 在 permissions 中添加 downloads**

```json
"permissions": [
  "storage",
  "declarativeNetRequest",
  "downloads"
],
```

- [ ] **Step 2: Commit**

```bash
git add public/manifest.json
git commit -m "feat: 添加 downloads 权限到 manifest"
```

---

### Task 9: Popup UI 添加 ORT 调试模式 checkbox

**Files:**
- Modify: `src/popup/App.tsx`

- [ ] **Step 1: 在 timing-options-row 中添加 checkbox**

在现有的三个 checkbox（显示耗时、显示阶段明细、排版调试模式）之后添加：

```tsx
<label className="checkbox-row">
  <input
    type="checkbox"
    checked={settings.ortDebugMode}
    onChange={(event) => updateField('ortDebugMode', event.target.checked)}
    disabled={loading}
  />
  <span className="checkbox-label">ORT 调试模式</span>
</label>
```

- [ ] **Step 2: Commit**

```bash
git add src/popup/App.tsx
git commit -m "feat: popup UI 添加 ORT 调试模式 checkbox"
```

---

### Task 10: PaddleOCR 推理结果中触发调试报告下载

**Files:**
- Modify: `src/pipeline/ocr/paddleocrProvider.ts`

在 PaddleOCR 推理调用 `runInference` 后（line 46），检查返回结果中的 `profilingLog`，如果存在则触发下载。

- [ ] **Step 1: 添加 import**

在 paddleocrProvider.ts 添加：

```typescript
import { downloadDebugReport } from '../../runtime/ortDebugDownload';
import { toErrorMessage } from '../../shared/utils';
```

- [ ] **Step 2: 在推理成功后触发下载**

修改 line 46 附近的推理调用，将 sessionHandle.provider 传入下载函数：

```typescript
const inferenceResult = await runInference(sessionHandle.sessionId, feeds);

if (inferenceResult.profilingLog) {
  downloadDebugReport('paddleocr_rec', sessionHandle.provider, true, undefined, inferenceResult.profilingLog);
}
```

- [ ] **Step 3: 在推理失败时也触发下载**

将 `recognize` 方法中的 `runInference` 调用包裹在 try/catch 中，失败时也下载报告：

```typescript
try {
  const inferenceResult = await runInference(sessionHandle.sessionId, feeds);

  if (inferenceResult.profilingLog) {
    downloadDebugReport('paddleocr_rec', sessionHandle.provider, true, undefined, inferenceResult.profilingLog);
  }
  // ...现有推理结果处理逻辑
} catch (error) {
  downloadDebugReport('paddleocr_rec', sessionHandle.provider, false, toErrorMessage(error));
  throw error;
}
```

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/ocr/paddleocrProvider.ts
git commit -m "feat: PaddleOCR 推理完成后触发调试报告下载"
```

---

### Task 11: 构建验证

- [ ] **Step 1: 运行 TypeScript 编译检查**

```bash
npx tsc --noEmit
```

Expected: 无类型错误

- [ ] **Step 2: 运行现有测试**

```bash
npx vitest run
```

Expected: 所有测试通过

- [ ] **Step 3: 构建扩展**

```bash
npm run build
```

Expected: 构建成功

- [ ] **Step 4: 最终 commit（如有修复）**

如有构建/测试中发现的问题需要修复，commit 修复。