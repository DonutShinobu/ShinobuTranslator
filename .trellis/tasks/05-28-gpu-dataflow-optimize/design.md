# Pipeline CPU/GPU 数据流优化 — 技术设计

## 架构概览

将 detector 预处理从「主线程 CPU → Worker CPU」改为「Worker 内 WebGPU 全流程」：

**当前数据流**:
```
主线程: canvas.getImageData() → Float32Array(letterbox归一化)
  → TensorTransport(Comlink clone) →
Worker: transportToTensor → ort.Tensor(CPU→GPU) → session.run
  → ort.Tensor(GPU→CPU) → tensorToTransport → TensorTransport(Comlink transfer) →
主线程: 后处理(NMS, mask解码)
```

**优化后数据流**:
```
主线程: createImageBitmap(image) → ImageBitmap(Comlink transfer) →
Worker: copyExternalImageToTexture → GPUTexture
  → copyTextureToBuffer → GPUBuffer
  → compute shader(letterbox归一化) → GPUBuffer(NCHW float32)
  → Tensor.fromGpuBuffer → session.run(输入已在GPU)
  → preferredOutputLocation:"gpu-buffer" → GPU输出
  → getData() → CPU Float32Array → 后处理(NMS, mask解码)
  → 结果(Comlink transfer) → 主线程
```

## 核心改动

### 1. Worker 内新增 WebGPU 预处理模块

文件: `src/workers/gpuPreprocess.ts`（新文件）

职责:
- 获取 `ort.env.webgpu.device`（onnxruntime-web 已初始化的 GPUDevice）
- 实现 letterbox compute shader（HWC RGBA → NCHW float32, padding #7f7f7f）
- 提供 `preprocessLetterboxGpu(imageSource, size)` → `{ gpuTensor: ort.Tensor, ratio, padX, padY }`

Compute shader 核心逻辑:
```
输入: GPUBuffer(RGBA uint8, HWC layout, padded canvas size × size)
输出: GPUBuffer(float32, NCHW layout, [1, 3, size, size])

每个线程处理一个像素:
  - 读取 RGBA[src_idx]
  - 输出 channel_0[y*size+x] = R/255
  - 输出 channel_1[y*size+x] = G/255
  - 输出 channel_2[y*size+x] = B/255
  - padding区域输出 #7f7f7f = (0.5, 0.5, 0.5)
```

### 2. Worker API 扩展

`OnnxWorkerApi` 新增方法:
```typescript
runDetectWithGpuPreprocess(
  imageSource: ImageBitmap | OffscreenCanvas,
  size: number
): Promise<DetectGpuResult>
```

该方法在 Worker 内完成完整的预处理+推理+后处理，返回解码后的检测结果（regions + rawMaskCanvas data）。

### 3. onnx-worker.ts session 创建改动

为 detector/inpaint session 添加 `preferredOutputLocation: "gpu-buffer"`:
```typescript
const session = await createSessionWithTimeout(modelUrl, {
  executionProviders: [ep],
  graphOptimizationLevel: "all",
  preferredOutputLocation: "gpu-buffer",  // 新增
}, SESSION_CREATE_TIMEOUT_MS);
```

注意: 只在 WebGPU EP 下设置此选项，webnn/wasm 不支持需要 fallback。

### 4. 主线程改动

`onnxDetect.ts` 中 `detectByOnnx()`:
- 当 provider === "webgpu" 时，使用新的 `runDetectWithGpuPreprocess()` 路径
- 当 provider !== "webgpu" 时，保持现有 CPU 预处理路径
- 主线程需要传递 `ImageBitmap` 给 Worker（而非当前传递 Float32Array TensorTransport）

### 5. ImageBitmap 传输优化

主线程改为：
```typescript
const imageBitmap = await createImageBitmap(image);
// 通过 Comlink transfer 传给 Worker
```
`ImageBitmap` 支持 Comlink transfer（零拷贝跨线程），比当前 TensorTransport 结构化 clone 更高效。

## Compute Shader 设计

### Letterbox 预处理 Shader (WGSL)

```wgsl
@group(0) @binding(0) var<storage, read> src_pixels: array<u32>;  // RGBA packed
@group(0) @binding(1) var<storage, read_write> dst_ch0: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst_ch1: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst_ch2: array<f32>;

struct Params {
  src_width: u32,
  src_height: u32,
  dst_size: u32,      // letterbox target size
  pad_x: u32,
  pad_y: u32,
  ratio: f32,         // scale ratio
};

@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dst_idx = gid.x;
  if (dst_idx >= params.dst_size * params.dst_size) { return; }

  let dst_x = dst_idx % params.dst_size;
  let dst_y = dst_idx / params.dst_size;

  // Check if in padded area
  let in_image = dst_x >= params.pad_x && dst_x < params.pad_x + u32(f32(params.src_width) * params.ratio)
              && dst_y >= params.pad_y && dst_y < params.pad_y + u32(f32(params.src_height) * params.ratio);

  if (in_image) {
    let src_x = u32(f32(dst_x - params.pad_x) / params.ratio);
    let src_y = u32(f32(dst_y - params.pad_y) / params.ratio);
    let src_pixel_idx = src_y * params.src_width + src_x;
    let packed = src_pixels[src_pixel_idx];
    let r = f32(packed & 0xFFu) / 255.0;
    let g = f32((packed >> 8u) & 0xFFu) / 255.0;
    let b = f32((packed >> 16u) & 0xFFu) / 255.0;
    dst_ch0[dst_idx] = r;
    dst_ch1[dst_idx] = g;
    dst_ch2[dst_idx] = b;
  } else {
    // Padding: #7f7f7f = 0.498
    dst_ch0[dst_idx] = 0.4980392156862745;
    dst_ch1[dst_idx] = 0.4980392156862745;
    dst_ch2[dst_idx] = 0.4980392156862745;
  }
}
```

注意: 实际实现中需要用 `copyExternalImageToTexture` 从 canvas 获取像素，然后 `copyTextureToBuffer` 到 GPUBuffer，再作为 shader 输入。shader 输入应该是 texture 而不是 storage buffer。

### 更精确的实现路径

1. `copyExternalImageToTexture(canvas/OffscreenCanvas → GPUTexture)` — GPU fast path
2. `copyTextureToBuffer(GPUTexture → GPUBuffer rgba8uint)` — 获取像素数据到 storage buffer
3. compute shader: `rgba8uint → NCHW float32`（归一化 + letterbox padding）
4. 输出 GPUBuffer → `Tensor.fromGpuBuffer()` → session.run feeds

或者更优化：
1. `copyExternalImageToTexture(canvas → GPUTexture)` 
2. 在 compute shader 中直接从 texture 采样（`texture_2d<f32>` binding），输出到 storage buffer
3. 这避免了 `copyTextureToBuffer` 步骤，但 letterbox 需要采样不同位置的像素

**推荐**: 用 texture 采样方式，因为 letterbox 的 resize+padding 可以通过 texture sampling 直接实现（GPU 纹理采样自带 bilinear filtering），不需要先拷到 buffer 再逐像素处理。

## 兼容性设计

- WebGPU 路径: Worker 内 WebGPU 预处理 + IO Binding
- webnn/wasm fallback: 保持现有 CPU 预处理路径
- 选择逻辑: `if (provider === "webgpu") { useGpuPath } else { useCpuPath }`
- 主线程传递: WebGPU 路径传 `ImageBitmap`，CPU 路径传 `Float32Array TensorTransport`

## 风险点

1. **Compute shader 正确性**: letterbox 的 padding/resize 必须与 CPU 实现完全一致，否则检测结果会不同
2. **ort.env.webgpu.device 在 Worker 内**: 需要确认 onnxruntime-web WebGPU EP 在 Worker 内创建 session 时初始化了 device，且可以被我们的 shader 共享
3. **preferredOutputLocation 兼容性**: webnn/wasm EP 不支持此选项，需要条件判断
4. **ImageBitmap 跨 Worker 传输**: Comlink transfer 是否支持 ImageBitmap？如果不支持，需要用 OffscreenCanvas 或回退到 pixel data 传输