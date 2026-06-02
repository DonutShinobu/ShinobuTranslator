# OCR WebGPU AR 专项优化实验

## Goal

如果 AR 结构复用收益不足，实验 WebGPU 专项优化：固定 AR batch/shape、尝试 ORT WebGPU graph capture、减少 CPU/GPU 往返，并评估 GPU 侧 token 选择的可行性。

## Confirmed Facts

- 浏览器侧 OCR runtime 配置为 `["webgpu", "webnn", "wasm"]`。
- 当前 OCR 输入仍由 CPU `Float32Array` 创建并传给 Worker。
- `.trellis/spec/frontend/webgpu-dataflow.md` 已沉淀 detector GPU 预处理/IO Binding 约束。
- `preferredOutputLocation:"gpu-buffer"` 不能全局用于所有 WebGPU session，否则现有 `tensor.data` 路径会失败。

## Requirements

- 只在 OCR WebGPU provider 下实验，webnn/wasm fallback 不受影响。
- 优先验证固定 batch/shape + graph capture 是否能降低 AR 每步 `session.run` 成本。
- 若启用 GPU output location，必须限制在 OCR 专用路径并通过 `getData()` 或 GPU 侧 reduction 安全读取。
- 所有 WebGPU 变更必须可开关或易回退。

## Acceptance Criteria

- [x] 浏览器 WebGPU 环境下有 before/after 数据。
- [x] WebGPU 优化失败时自动回退当前 OCR 路径。
- [x] 不破坏 detector 已有 GPU preprocess 路径。

## Outcome

已测试并撤掉 WebGPU graph capture 方案：当前 OCR 图存在不能全部 partition 到 WebGPU EP 的节点，ORT 在 session create 阶段拒绝启用 graph capture。生产路径不做 WebGPU graph capture 改动，保留现有 provider fallback。

## Out of Scope

- 训练 parallel decoder 模型。
- 提交新的 ONNX 模型资产。
