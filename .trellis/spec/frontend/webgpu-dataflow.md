# WebGPU、ONNX Worker 与数据边界

本文档记录当前浏览器 ONNX Worker、detector WebGPU preprocessing、Browser/Node bridge 和 Paddle OCR 的可执行契约。

## Detector WebGPU preprocessing

### Data flow

```text
Main thread ImageBitmap
  -> Comlink transfer（调用方不再复用该 ImageBitmap）
Worker copyExternalImageToTexture
  -> rgba8unorm GPUTexture
compute shader
  -> bilinear resize + top-left letterbox + normalize + HWC-to-NCHW
GPUBuffer [1, 3, 1024, 1024]
  -> ort.Tensor.fromGpuBuffer()
WebGPU session.run()
  -> detector GPU-backed output
getData()
  -> TensorTransport
  -> Comlink transfer 回主线程
```

### Contracts

- Compute shader 不能使用 fragment-only 的 `textureSample`；使用 `textureLoad` 实现手工 bilinear interpolation。
- `ImageBitmap`/`OffscreenCanvas` 不能使用 `importExternalTexture`；通过 `copyExternalImageToTexture` 上传。
- CPU detector preprocessing 使用 top-left 对齐和黑色 padding，GPU 路径必须一致，不能改成居中或 `0.498` padding。
- `preferredOutputLocation: "gpu-buffer"` 只为 `modelKey === "detector"` 设置。其他模型的通用 transport 读取 CPU data，禁止全局启用。
- GPU output 必须使用 `getData()` 下载；直接读取 `tensor.data` 会报 `The data is not on CPU`。
- `srcTexture`、channel buffers、uniform buffer 在提交完成后销毁；NCHW buffer 的所有权交给 ORT tensor dispose callback。
- GPU preprocessing 失败后保留 CPU preprocessing/provider fallback，不允许因优化路径失败而终止完整 pipeline。

### Bilinear coordinate contract

CPU `canvas.drawImage` 的像素中心语义必须由 shader 复现：

```wgsl
let x = u * f32(params.src_width) - 0.5;
let y = v * f32(params.src_height) - 0.5;
let x0 = i32(floor(x));
let y0 = i32(floor(y));
let fx = x - f32(x0);
let fy = y - f32(y0);
// clamp 四邻域后分别 mix x/y
```

nearest-neighbor 虽可运行，但会改变 detector 输入和框/mask 质量，不是可接受替代。

## Worker 构建与启动

### Build boundary

- `src/workers/onnx-worker.ts` 由 `scripts/build-worker.mjs` 独立生成 `dist/onnxWorker.js`，不加入主 Vite `rollupOptions.input`。
- `npm run build` 顺序为应用 typecheck、Release Vite build、Worker build、`check:artifacts`。
- `public/manifest.json` 必须通过 `web_accessible_resources` 暴露 `onnxWorker.js` 与 `ort/*`。

### Bootstrap contract

- `onnxWorkerBridge` 优先创建 `chrome-extension://.../onnxWorker.js` module Worker。
- `proxy.init(chrome.runtime.getURL("ort/"))` 把 ORT backend 目录显式传给 Worker。
- 某些 Content Script 上下文拒绝 extension URL Worker，因此保留 Blob Worker fallback；失败的候选 Worker 必须 terminate。
- Blob fallback 仍使用同一个 extension `ortPath`，不能退回相对页面路径猜测。

## 当前 Worker API

`src/runtime/onnxWorkerTypes.ts` 是 Browser bridge 与 Worker expose 的事实源：

```typescript
interface OnnxWorkerApi {
  init(ortPath: string): Promise<void>;
  createSession(
    modelKey: string,
    modelUrl: string,
    preferred: RuntimeProvider[],
    sessionOptions?: OnnxSessionOptions,
  ): Promise<WorkerSessionHandle>;
  runInference(
    sessionId: string,
    feeds: Record<string, TensorTransport>,
  ): Promise<InferenceResult>;
  probeRuntime(modelUrl: string): Promise<RuntimeSelfCheckReport>;
  probePaddleGraphCapture(
    options: PaddleGraphCaptureProbeOptions,
  ): Promise<PaddleGraphCaptureProbeResult>;
  runDetectWithGpuPreprocess(
    sessionId: string,
    imageSource: ImageBitmap,
  ): Promise<GpuDetectResult>;
  disposeSession(sessionId: string): Promise<void>;
  disposeAll(): Promise<void>;
}
```

### Session contracts

- Worker cache key 为 `` `${modelKey}:${normalizedProviders}:${sessionOptionsKey}` ``。不同 provider plan 或实验 session options 不能互相污染。
- `WorkerSessionHandle.sessionId` 必须与 cache key 一致。
- `disposeSession(exactSessionId)` 删除精确 session；传 bare `modelKey` 时还必须删除所有 `modelKey:` 前缀变体。
- Browser/Node 代码都从 `runtime/onnxBridge.ts` 进入；pipeline 禁止直接导入 `onnxWorkerBridge` 或 `onnxNodeBridge`。
- 普通 tensor input 使用 structured clone，避免 detach 后破坏 retry/后续消费者；Worker output 在发送端不再使用，可通过 `Comlink.transfer` 返回。
- `ImageBitmap` 是明确的一次性 detector 输入，可以 transfer。

### Removed domain RPC

Worker 只承担通用推理和 detector GPU preprocessing，不承担 OCR 领域 decode。以下能力禁止重新加入 `OnnxWorkerApi`、Browser/Node bridge 或产物：

- AR batch/split/single decode RPC
- AR token color batch/single RPC
- `decodeAutoregressive` / `gpuArgmax`
- `ocr_encoder` / `ocr_decoder` session 特例

当前 OCR 的模型、preprocess、CTC decode 和颜色采样由 `src/pipeline/ocr/` 管理。若未来需要把新算法移入 Worker，必须以当前产品模型为前提重新设计通用 transport、Browser/Node parity、性能 benchmark 和回归测试，不能恢复旧 AR API。

## Paddle OCR data flow

```text
Pipeline regions
  -> paddleocrPreprocess（Browser/Node PlatformProvider）
  -> generic onnxBridge.runInference
  -> logits TensorTransport [batch, timeSteps, 18710]
  -> CPU CTC decode（dictionary entries + blank + space）
  -> colorSampling*（当前图像区域取样）
  -> OcrResult
```

### Contracts

- 产品 provider 固定为 `paddleocr_v6_medium`，模型 key 为 `paddleocr_v6_medium_rec`。
- Browser provider 按 WebGPU/WebNN/WASM fallback 创建 session；Node bridge 使用 onnxruntime-node CPU/CUDA 可用路径。
- Paddle logits 需要 CPU CTC decode，普通产品 session 不设置 GPU-backed output。
- `probePaddleGraphCapture` 是 benchmark 实验 API，不代表产品 graph capture 已启用；它要求 external GPU input/output 和固定 shape。
- 字典/输出契约为 `outputClasses === dictionaryEntries + 2`，当前 smoke 应为 `[1, 40, 18710]` 与 18,708 条字典。
- 历史设置 `48px`、`builtin`、`paddleocr`、`paddleocr_v6_small` 只在 config/provider normalization 中映射到 medium；不得触发旧模型或旧 Worker RPC。

## Runtime self-check 与 fallback

- `probeRuntime` 分别验证 secure context、`navigator.ml`、模型 fetch、WebNN session 和 WASM session。
- self-check 失败只生成结构化报告，不应改变后续产品 session 的 provider cache。
- WebNN/WebGPU 可用性探测和 session create timeout 必须保留明确中文错误信息。
- Background/Content 不持有 `InferenceSession`；session 生命周期只由 Node bridge 或 Worker 管理。

## Validation matrix

| Condition | Symptom | Required fix |
| --- | --- | --- |
| Worker/ORT 文件未暴露 | module/wasm fetch 失败 | 检查 `web_accessible_resources` 和传入的 `ortPath` |
| Blob Worker 改变 origin | ORT backend dynamic import 失败 | 优先 extension URL Worker，保留受控 fallback |
| cache 只按 modelKey | probe/实验 session 污染产品 provider | cache key 加 provider plan 与 session options |
| 所有 WebGPU session 都输出 GPU tensor | generic transport 读取失败 | 只为 detector 设置 GPU output |
| 输入 ArrayBuffer 被 transfer 后重试 | detached/空输入 | structured clone，或只 transfer throwaway copy |
| Release 出现旧 AR 符号 | bundle 增长且恢复死 API | 契约测试和 `check:artifacts` 直接失败 |
| Paddle classes 与字典不匹配 | CTC token 错位 | 停止发布并校验 model/dict 配对 |

## Required verification

- `npx vitest run tests/runtime/onnxWorkerContract.test.ts tests/pipeline/ocr/provider.test.ts tests/pipeline/ocr/paddleocrDecode.test.ts tests/pipeline/ocr/colorSampling.test.ts`
- `npm run typecheck`
- `npm run build`（包含独立 Worker 和 Release artifact assertion）
- `npm run bench:browser-ocr-smoke`
- OCR/provider 或 Worker 变化后运行 `npm run bench:browser-paddle-profile -- --image=<fixture> --runs=3`
- Node parity 变化后运行 `npm run bench:ocr-debug -- --ocr-engine=paddleocr_v6_medium`
- detector GPU preprocessing 变化还需运行浏览器 pipeline smoke，并比较 CPU/GPU 检测区域和 mask。
