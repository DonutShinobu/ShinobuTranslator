# OCR GPU 侧 argmax/topK 设计

## 背景

当前 AR OCR 每步 `session.run()` 输出 `logits: [N,64,46272]`。即使每轮只需要当前 step 的最佳 token，现有代码仍通过 `tensor.data` 把完整 logits 下载到 CPU，然后在 CPU 扫描 `classes` 做 argmax 和 softmax confidence。

这会带来两类成本：

- WebGPU 输出到 CPU 的大 tensor 回传成本。
- CPU 每步每样本扫描 46k classes 的成本。

## 约束

- ORT WebGPU graph capture 已验证不可用：当前 OCR 图不能完全 partition 到 WebGPU EP。
- ORT `preferredOutputLocation` 可让指定输出留在 GPU，但需要 `getData()` 或自定义 GPU 后处理读取结果。
- 当前扩展 worker 使用 `onnxruntime-web/all`，WebGPU device 可通过 `ort.env.webgpu.device` 获取，但只有 WebGPU session 创建后才可靠。
- Node benchmark 没有 WebGPU device，必须保留 CPU 路径。

## 方案

### 方案 A：独立 WebGPU reduction prototype

1. 在浏览器实验脚本中创建 WebGPU OCR session，并将 `logits` output 设置为 `gpu-buffer`。
2. 用 WGSL compute shader 对当前 decode step 的 `[N, classes]` 做两阶段 reduction：
   - pass 1：每个 sample 分多个 workgroup 扫描 class block，输出局部 best token/score。
   - pass 2：每个 sample 归并局部 best，输出最终 token/score。
3. 只 map/download `N * (tokenId + score)` 的小 buffer。
4. 和 CPU path 的 argmax token/score 对比。

优点：不碰生产路径，能验证核心技术风险。
缺点：仍需要保留 logits 在 GPU buffer，ORT GPU tensor lifecycle 要处理好。

### 方案 B：接入 production AR decode

在 `decodeBatchAutoregressive` 中按 provider 分支使用 GPU argmax helper。

优点：能直接减少端到端成本。
缺点：需要把 `session.run` fetches、GPU tensor dispose、CPU fallback、置信度近似或 GPU softmax 一起处理，风险更高。

## 本任务执行选择

先做方案 A。prototype 稳定且收益明显后，已进入方案 B 的 WebGPU-only 接入：

- `src/workers/onnx-worker.ts` 仅在 `modelKey === "ocr"` 且 provider 为 WebGPU 时设置 `preferredOutputLocation: { logits: "gpu-buffer" }`。
- `src/pipeline/ocr/gpuArgmax.ts` 用四段 WGSL reduction 计算 best token、score、softmax probability。
- `decodeBatchAutoregressive` 优先使用 GPU reducer；任意异常都会关闭 reducer 并通过 `getData()` 回退 CPU logits path。
- 单图 fallback beam decode 也改成 `getData()` 读取 logits，因此 WebGPU logits buffer session 下仍可回退。

## 验证指标

- token id 一致性：GPU argmax vs CPU argmax。
- run 后处理耗时：CPU tensor download+argmax vs GPU reduction+small readback。
- 失败模式：WebGPU 不可用、`gpu-buffer` 输出不可用、shader 编译失败、buffer map 失败。
