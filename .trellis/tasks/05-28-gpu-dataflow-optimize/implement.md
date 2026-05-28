# Pipeline CPU/GPU 数据流优化 — 实施计划

## 范围: Phase 1 — Detector 预处理 WebGPU 加速

只重构 detector 预处理为 WebGPU compute shader + IO Binding，验证正确性和性能后再扩展。

## 实施步骤

### 1. 确认 Worker 内 WebGPU 可用性

- [ ] 在 Worker 内检查 `navigator.gpu` 和 `ort.env.webgpu.device` 是否可用
- [ ] 确认 `preferredOutputLocation: "gpu-buffer"` 在 session 创建时是否被正确支持
- [ ] 确认 `ort.env.webgpu.device` 在 Worker 内创建 WebGPU session 后可被外部 shader 共享

验证: 在 Worker 内打印 `ort.env.webgpu.device` 信息，确认 device 对象存在

### 2. 创建 GPU 预处理模块

- [ ] 创建 `src/workers/gpuPreprocess.ts`
- [ ] 实现 letterbox compute shader (WGSL)
  - 输入: GPUTexture (from copyExternalImageToTexture)
  - 输出: GPUBuffer (NCHW float32, letterbox padded)
- [ ] 实现 `preprocessLetterboxGpu(imageSource, size, device)` 函数
  - 步骤: copyExternalImageToTexture → compute shader → GPUBuffer → Tensor.fromGpuBuffer

验证: 用简单测试 canvas 输入，比较 GPU 输出与 CPU `preprocessLetterbox` 输出是否一致

### 3. Worker API 扩展

- [ ] `OnnxWorkerApi` 新增 `runDetectWithGpuPreprocess()` 方法
  - 接收 `ImageBitmap` (Comlink transfer)
  - 在 Worker 内完成: copyExternalImageToTexture → shader预处理 → Tensor.fromGpuBuffer → session.run → 后处理(NMS/mask解码)
  - 返回解码后的检测结果 (regions + mask canvas data)
- [ ] session 创建: detector session 添加 `preferredOutputLocation: "gpu-buffer"` (仅 WebGPU EP)
- [ ] 推理输出: 使用 `tensor.getData()` 显式拷回 CPU (仅在后处理需要时)

验证: Worker 内调用 `runDetectWithGpuPreprocess()` 获得正确检测结果

### 4. 主线程改动

- [ ] `onnxDetect.ts` 中 `detectByOnnx()`:
  - 当 provider === "webgpu" 时，创建 `ImageBitmap`，调用 Worker 的 `runDetectWithGpuPreprocess()`
  - 当 provider !== "webgpu" 时，保持现有 CPU 路径
- [ ] `onnxWorkerBridge.ts` 新增 `runDetectWithGpuPreprocess()` bridge 方法
- [ ] `onnxWorkerTypes.ts` 新增相关类型定义

验证: 浏览器内跑完整 pipeline，detector 结果与 baseline 一致

### 5. 性能验证

- [ ] 跑 11.png benchmark，对比 WebGPU 下优化前后耗时
- [ ] 目标: 总耗时减少 ≥15%
- [ ] 检查 CPU 占用率变化

验证: benchmark 报告

### 6. 兼容性验证

- [ ] 在不支持 WebGPU 的环境（如 Firefox）下运行，确认 fallback 路径正常
- [ ] 在支持 WebGPU 的 Chrome 下运行，确认 WebGPU 路径正常

验证: 两个环境都能正确运行

## 验证命令

```bash
# 浏览器端无法用 CLI 验证，需要手动在 Chrome 中运行插件
# 用 DevTools Performance panel 或 console timing 对比耗时

# Node.js baseline (不受影响，但确认 Node 版本没被改坏)
npx tsx benchmark/perf/src/run-perf.ts
```

## 风险文件

- `src/workers/onnx-worker.ts` — Worker API 扩展
- `src/workers/gpuPreprocess.ts` — 新文件，GPU 预处理模块
- `src/pipeline/detect/onnxDetect.ts` — 主线程 detector 入口
- `src/runtime/onnxWorkerBridge.ts` — Bridge 扩展
- `src/runtime/onnxWorkerTypes.ts` — 类型定义

## 回滚点

每完成一个步骤，确认可以回退：
- Step 2: gpuPreprocess.ts 独立模块，不影响现有代码
- Step 3: Worker 新增方法，不改动现有方法
- Step 4: onnxDetect.ts 中 WebGPU 路径和 CPU 路径分支，可回退到纯 CPU 路径