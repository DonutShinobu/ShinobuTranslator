# Pipeline CPU/GPU 数据流优化 — Browser 侧 WebGPU 加速预处理

## Goal

减少浏览器插件 Pipeline 运行时 CPU 占用率和推理延迟。通过 WebGPU compute shader 完成预处理（canvas → NCHW 归一化），配合 IO Binding（`Tensor.fromGpuBuffer` / `preferredOutputLocation: "gpu-buffer"`），将预处理和推理数据流尽量留在 GPU 侧，消除 CPU Float32Array 中间操作。

## 已确认事实

1. **浏览器侧已用 WebGPU EP**: manifest 中所有模型 runtime 都配置为 `["webgpu", "webnn", "wasm"]`
2. **IO Binding 在 onnxruntime-web 已支持**: `Tensor.fromGpuBuffer()` / `preferredOutputLocation: "gpu-buffer"` (#17480, #16452)
3. **当前完全没利用 IO Binding**: 所有输入从 CPU Float32Array 创建，所有输出拷回 CPU
4. **Pipeline 在 Web Worker 内运行**: ONNX 推理通过 Comlink 在 Worker 内执行
5. **`copyExternalImageToTexture()` 在 Worker 内可用**: 可以直接从 OffscreenCanvas 拷贝像素到 GPUTexture（GPU fast path），且在 Web Worker 中可用
6. **当前数据流**: 主线程 canvas getImageData → Float32Array → TensorTransport(Comlink clone) → Worker ort.Tensor(CPU→GPU) → session.run → ort.Tensor(GPU→CPU) → TensorTransport(Comlink transfer) → 主线程 putImageData
7. **优化后数据流**: Worker OffscreenCanvas → copyExternalImageToTexture → GPUTexture → copyTextureToBuffer → GPUBuffer → compute shader 归一化 → GPUBuffer → Tensor.fromGpuBuffer → session.run(输入已在GPU) → preferredOutputLocation:gpu-buffer → GPU输出 → getData()仅需要时拷回CPU
8. **3 个 ONNX 推理阶段**: detector、OCR(encoder+自回归decoder)、inpainter
9. **预处理类型**: letterbox(detector/bubble)、直接resize+归一化(inpaint)、透视变换+归一化(OCR)

## Requirements

1. 从 browser 侧开始优化（WebGPU compute shader + IO Binding）
2. 优化后跑 11.png 做快速验证
3. 优化目标：减少 CPU 占用率 + 减少总耗时
4. 不改变 Pipeline 的输入输出行为（功能性不变）
5. 兼容 webnn/wasm fallback（不支持 WebGPU 时保持现有行为）

## Acceptance Criteria

- [ ] WebGPU EP 下，预处理通过 compute shader 完成，不在 CPU 上创建中间 Float32Array
- [ ] WebGPU EP 下，推理输入通过 `Tensor.fromGpuBuffer()` 传入，避免 CPU→GPU 拷入
- [ ] WebGPU EP 下，推理输出使用 `preferredOutputLocation: "gpu-buffer"`，仅在需要时 `getData()` 拷回 CPU
- [ ] 跑 11.png benchmark，WebGPU 下总耗时比 baseline 减少 ≥15%
- [ ] 功能不变：输出图像与 baseline 一致
- [ ] webnn/wasm fallback 不受影响

## Out of Scope

- Node.js 侧优化
- 翻译阶段的网络 I/O 优化
- 模型压缩/量化
- 后处理（NMS、mask 解码、connectedComponents）迁移到 GPU（这些是纯 CPU 算法，需要 Float32Array 数据）

## Resolved Questions

1. **预处理在 Worker 内完成** — 已确认: 预处理和推理全在 Worker 内完成，主线程只传 ImageBitmap 给 Worker。WebGPU GPUDevice/GPUBuffer 不能跨线程传输。
2. **OffscreenCanvas + WebGPU 在 Worker 内可用** — Dedicated Worker 内 `navigator.gpu` 和 `copyExternalImageToTexture()` 都可用。Service Worker 有 import() 限制但不影响我们。
3. **Phase 1 只做 detector** — 分步推进，先验证 detector letterbox 预处理的 GPU 加速，再扩展到 inpaint/OCR。

## Remaining Open Questions

1. **ort.env.webgpu.device 共享**: onnxruntime-web WebGPU EP 在 Worker 内创建 session 时初始化了 device，我们需要在 shader 中使用同一个 device。需在 Step 1 中确认。
2. **compute shader 正确性验证**: letterbox 的 padding/resize 必须与 CPU 实现完全一致，否则检测结果不同。这是关键风险点，需要像素级对比测试。