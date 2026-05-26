# Design — 脱离浏览器的Pipeline独立运行

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  Pipeline Stages                     │
│  (detect → OCR → merge → sort → bubble → bake)     │
│  所有阶段通过 platform 参数调用 Canvas/Image API      │
└─────────────────────────┬───────────────────────────┘
                          │
                    PlatformProvider
                          │
            ┌─────────────┴─────────────┐
            │                           │
   browserPlatform               nodePlatform
   (DOM API实现)                 (node-canvas实现)
            │                           │
            │                    ┌──────┴──────┐
            │                    │             │
      onnxWorkerBridge      onnxNodeBridge
      (Comlink+Worker)      (onnxruntime-node
            │                + CUDA EP)
            │                    │
      onnxruntime-web       onnxruntime-node
      (WebGPU/WASM)         (CUDA/DirectML)
```

## PlatformProvider Interface

```typescript
export interface PlatformProvider {
  createCanvas(width: number, height: number): PipelineCanvas;
  createImage(): PipelineImage;              // 空图片对象，后续设置 src
  loadImage(src: string): Promise<PipelineImage>;  // 直接加载图片
  registerFont(path: string, family: string): void;
  waitForFonts(): Promise<void>;
}
```

`PipelineCanvas` 和 `PipelineImage` 是结构类型，只声明 pipeline 实际使用的方法：

```typescript
export interface PipelineCanvas {
  width: number;
  height: number;
  getContext(type: '2d'): PipelineRenderingContext | null;
  toDataURL(type?: string): string;
}

export interface PipelineRenderingContext {
  drawImage(source: any, ...args: number[]): void;
  measureText(text: string): PipelineTextMetrics;
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  strokeText(text: string, x: number, y: number): void;
  putImageData(data: PipelineImageData, dx: number, dy: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): PipelineImageData;
  createImageData(width: number, height: number): PipelineImageData;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  scale(x: number, y: number): void;
  setLineDash(segments: number[]): void;
  fillStyle: string | CanvasGradient;
  strokeStyle: string | CanvasGradient;
  lineWidth: number;
  font: string;
  globalAlpha: number;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
}

export interface PipelineTextMetrics {
  width: number;
  // browser: actualBoundingBoxAscent etc.
  // node-canvas: 只有 width
  // pipeline 只用 width，其他属性 optional
}

export interface PipelineImageData {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
```

### 为什么不用完整 Canvas API 镜像

`HTMLCanvasElement` 有 50+ 方法，`CanvasRenderingContext2D` 有 80+ 属性/方法。pipeline 只用了约 20 个。定义完整接口意味着 Node 实现要实现所有方法（大部分是空实现），增加维护负担。结构类型只约束 pipeline 实际使用的部分，TypeScript 在浏览器侧自然满足（`HTMLCanvasElement` 覆盖这些方法），Node 侧由 node-canvas 满足。

### PlatformProvider 传递方式

- `orchestrator.ts` 的 `runPipeline()` 顶层创建 `browserPlatform`，传入各阶段
- `shinobuBake()` 接收 `platform` 参数
- 各内部函数（`detectByOnnx`、`runOcr` 等）通过闭包或参数接收 `platform`
- 浏览器路径：`runPipeline(file, config, onProgress, browserPlatform)`
- Node 路径：`shinobuBake(dataUrl, nodePlatform)`

### `document.fonts.ready` 替代

浏览器实现：`waitForFonts() → document.fonts.ready`
Node 实现：`waitForFonts() → Promise.resolve()`（字体通过 `registerFont` 预注册）

## ONNX Bridge Abstraction

### 当前架构

```
Pipeline → getModelSession() → onnxWorkerBridge → Comlink → onnx-worker (Web Worker)
                                                            → onnxruntime-web
```

### 目标架构

```
Pipeline → getModelSession() → [条件导入]
                                ├→ onnxWorkerBridge (浏览器) → Comlink → Worker → onnxruntime-web
                                └→ onnxNodeBridge    (Node)   → 直接调用 → onnxruntime-node (CUDA EP)
```

### 条件导入实现

`modelRegistry.ts` 中：

```typescript
import type { WorkerSessionHandle } from './onnxWorkerTypes';

// 条件导入：浏览器用 worker bridge，Node 用直接 bridge
const isNode = typeof process !== 'undefined' && !!process.versions?.node;

let bridge: typeof import('./onnxWorkerBridge') | typeof import('./onnxNodeBridge');

async function getBridge() {
  if (!bridge) {
    bridge = isNode
      ? await import('./onnxNodeBridge')
      : await import('./onnxWorkerBridge');
  }
  return bridge;
}
```

`getModelSession()` 改为 async 获取 bridge 后调用对应实现。

### onnxNodeBridge.ts 设计

实现与 `onnxWorkerBridge.ts` 相同的导出函数集：
- `createSession(modelKey, modelUrl, preferred)` — 用 `onnxruntime-node` 的 `InferenceSession.create()`，preferred 映射为 CUDA EP
- `runInference(sessionId, feeds)` — 直接 `session.run(feeds)`
- `runOcrBatchDecode / runOcrSingleDecode / runOcrColorBatch / runOcrColorSingle` — 调用共享 decode 模块
- `probeRuntime(modelUrl)` — 检测 CUDA 可用性
- `disposeSession / disposeAll` — 关闭 session

Session 缓存用进程内 Map（不需要跨 Worker 传递 sessionId）。

### OCR Decode 共享模块

当前 OCR decode 逻辑在 `onnx-worker.ts` 内部，需要提取为独立模块供两个桥接使用：

```
src/runtime/ocrDecode/
  ├── batchDecode.ts      — 批量自回归解码
  ├── singleDecode.ts     — 单条自回归解码
  ├── colorDecode.ts      — 颜色采样解码
  └── decodeShared.ts     — 共享类型和辅助函数
```

每个 decode 函数接收 `InferenceSessionLike` 接口参数：

```typescript
export interface InferenceSessionLike {
  run(feeds: Record<string, ort.Tensor>): Promise<Record<string, ort.Tensor>>;
  inputNames: string[];
  outputNames: string[];
}
```

- Worker 桥接：传入 Comlink proxy 包装的 session（实现 `InferenceSessionLike`）
- Node 桥接：传入 `ort.InferenceSession` 实例（天然实现 `InferenceSessionLike`）

## Model Loading

浏览器路径：模型从 `chrome-extension://` URL 通过 `fetch` 加载
Node 路径：模型从本地文件系统加载

```typescript
// nodePlatform 中的模型加载
function resolveModelPath(modelName: string): string {
  // 从 public/models/ 目录读取
  return path.join(ROOT, 'public/models', modelName + '.onnx');
}
```

`onnxruntime-node` 支持 `InferenceSession.create(modelPath)` 直接从文件路径加载，不需要 `fetch`。

## Node CLI Entry

`benchmark/typeset/src/bake-node.ts`:

```typescript
// 输入: 图片文件路径列表
// 输出: BakeResult JSON 文件 (同 shinobuBake 格式)

async function main() {
  const platform = createNodePlatform();
  for (const imagePath of imageFiles) {
    const image = await platform.loadImage(imagePath);
    const canvas = platform.createCanvas(image.width, image.height);
    canvas.getContext('2d').drawImage(image, 0, 0);

    const result = await shinobuBake(imagePath, platform);
    // 写入 fixture JSON
  }
}
```

## Compatibility Notes

- node-canvas 的 `measureText()` 只返回 `{ width }`，不含 `actualBoundingBoxAscent` 等。pipeline 中 typeset 部分需要 `width` 之外的属性——但 scope B 不包含 typeset 渲染，只有 detect + OCR + merge
- OCR 预处理中的 canvas 操作（裁剪区域、绘制）在 node-canvas 中可用
- `ImageData` 构造：node-canvas 用 `new Canvas.ImageData(w, h)` 或 ctx.createImageData，与浏览器兼容
- `onnxruntime-node` 的 CUDA EP 需要系统安装 CUDA Toolkit + cuBLAS + cuDNN

## Key Trade-offs

1. **结构类型 vs 完整接口** — 选择结构类型（只约束 pipeline 使用的 ~20 个方法），牺牲了 IDE 提示完整性，换取更小的实现负担
2. **条件导入 vs Platform 包含 ONNX** — 选择条件导入（ONNX 桥接在 `modelRegistry.ts` 层切换），不在 PlatformProvider 中包含 ONNX，因为 ONNX 的 API 差异（Worker vs 直接）不适合用同一接口覆盖
3. **OCR decode 提取 vs 复制** — 提取为共享模块增加一次重构，但保证两端 decode 逻辑一致；复制则更快但违背"自动同步"目标