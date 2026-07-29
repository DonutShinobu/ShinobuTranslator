# ORT 调试模式设计文档

## 背景

PaddleOCR ONNX 模型在 WebGPU 执行提供商下推理失败，但浏览器中只有一条最终报错，缺少中间层日志来定位具体是哪个算子/节点出错。需要在浏览器扩展中集成 ORT 调试配置，启用 verbose 日志 + per-kernel 验证 + profiling，以便定位出错算子并辅助后续修复（类似 LaMa WebGPU patch 的流程）。

## 目标

1. 定位 PaddleOCR 在 WebGPU 上推理失败的具体算子（名称、类型）
2. 获取每个算子的输入/输出 shape 和执行时间
3. 将调试日志保存为 JSON 文件，方便离线分析
4. 不修改 ONNX 模型文件本身

## 设计

### 1. 新增设置项

在 `ExtensionSettings` 中添加：

```typescript
ortDebugMode: boolean; // 默认 false
```

启用后的效果：
- `ort.env.logLevel = 'verbose'` — 输出所有级别日志（算子名称、shader 源码、dispatch 尺寸、数据传输）
- `ort.env.debug = true` — 启用 per-kernel ErrorScope 验证（精确定位哪个算子触发 GPU 验证错误）
- `ort.env.webgpu.profiling = { mode: 'default', ondata }` — 捕获每个算子的输入/输出 shape、类型、执行时间

### 2. 配置传播

ORT 推理全部在 worker 中运行，需要将配置从主线程传到 worker。

**修改 `init()` 接口：**

```typescript
// onnxWorkerTypes.ts
interface OrtDebugConfig {
  logLevel: 'verbose' | 'info' | 'warning' | 'error' | 'fatal';
  debug: boolean;
  profiling: boolean;
}

// OnnxWorkerApi.init 扩展
init(ortPath: string, debugConfig?: OrtDebugConfig): Promise<void>;
```

**传播流程：**
1. 主线程 `onnxWorkerBridge.ts` 的 `init()` 从 settings 读取 `ortDebugMode`，构造 `debugConfig`
2. 通过 Comlink 传给 worker 的 `init()`
3. Worker 的 `ensureOrtEnv()` 在设置 `ort.env` 时读取 `debugConfig`

**主线程侧：** `onnx.ts` 的 `ensureOrtEnv()` 同样需要读取 debug 配置（主要用于 session 创建前的探针阶段日志）。

### 3. Profiling 数据收集

**Worker 侧：**

`ondata` 回调将每条 profiling 数据追加到 `profilingLog[]` 数组：

```typescript
const profilingLog: WebGpuProfilingDataV1[] = [];

ort.env.webgpu.profiling = {
  mode: 'default',
  ondata: (data) => {
    profilingLog.push(data);
    // 同时 console.log 方便即时观察
    console.log(`[ort-debug] ${data.kernelType}|${data.kernelName}: ${(data.endTime - data.startTime) / 1000}us`,
      `in:`, data.inputsMetadata.map(m => `${m.dataType}[${m.dims}]`),
      `out:`, data.outputsMetadata.map(m => `${m.dataType}[${m.dims}]`));
  }
};
```

**推理完成后传回主线程：**

扩展 `runInference` 返回结果，增加可选 `profilingLog` 字段。仅在 `ortDebugMode` 启用时填充。

```typescript
interface InferenceResult {
  // ...现有字段
  profilingLog?: WebGpuProfilingDataV1[];
}
```

每次推理开始前清空 `profilingLog[]`，推理结束后作为返回值的一部分传回。

### 4. 日志保存为 JSON 文件

**触发时机：** 每次推理完成后，如果 `ortDebugMode` 启用且有 profiling 数据，自动触发下载。

**保存内容：**

```typescript
interface OrtDebugReport {
  timestamp: string;          // ISO 8601
  model: string;              // 模型名称
  provider: string;           // 实际使用的执行提供商
  success: boolean;           // 推理是否成功
  error?: string;             // 错误信息（如果失败）
  profilingLog: WebGpuProfilingDataV1[];  // 每个算子的执行详情
}
```

**保存方式：** 使用 Chrome Downloads API（需在 `manifest.json` permissions 中添加 `"downloads"`）：

```typescript
const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
const url = URL.createObjectURL(blob);
chrome.downloads.download({
  url,
  filename: `ort-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  saveAs: false  // 自动保存到下载目录
});
URL.revokeObjectURL(url);
```

如果不愿添加 `downloads` 权限，退回 Blob URL + `<a download>` 标签触发下载（用户需确认一次下载位置）。

### 5. 设置 UI

在 popup 设置页面的调试选项组中添加 checkbox：

```
☐ ORT 调试模式（开发者选项，启用后产生大量日志并自动下载 JSON 文件）
```

放在已有的 "显示耗时"、"显示阶段明细"、"排版调试模式" 旁边。

### 6. 对比测试流程

启用调试模式后定位出错算子的步骤：

1. 设置 OCR 引擎为 PaddleOCR，启用 ORT 调试模式
2. 运行一次翻译
3. 查看下载的 JSON 文件或 worker console 输出
4. 找到最后一个成功执行的算子 → 后续算子就是出错点
5. GPU 验证错误格式：`Kernel "ConvTranspose2D xxx" failed: 具体错误`
6. 确认问题后，像 LaMa 那样写针对性 patch 脚本

### 7. 影响范围

| 文件 | 变更内容 |
|------|----------|
| `src/shared/config.ts` | 新增 `ortDebugMode` 设置项 |
| `src/runtime/onnx.ts` | `ensureOrtEnv()` 读取 debug 配置 |
| `src/workers/onnx-worker.ts` | `ensureOrtEnv()` 读取 debug 配置 + profiling ondata + profilingLog 收集 |
| `src/runtime/onnxWorkerBridge.ts` | `init()` 扩展参数传递 debugConfig |
| `src/runtime/onnxWorkerTypes.ts` | `OnnxWorkerApi.init()` 类型扩展 + `InferenceResult` 增加 profilingLog |
| `src/popup/App.tsx` | UI checkbox |
| `public/manifest.json` | 可能需要添加 `downloads` 权限（或使用 Blob URL fallback） |

无模型变更，无依赖变更。

### 8. 不做的事

- 不修改 ONNX 模型文件
- 不获取中间层 tensor 数值对比（需要预处理模型，超出 C-1 范围）
- 不改变 runtime provider 选择逻辑
- profiling 数据只在 `ortDebugMode` 启用时收集，不影响正常使用性能