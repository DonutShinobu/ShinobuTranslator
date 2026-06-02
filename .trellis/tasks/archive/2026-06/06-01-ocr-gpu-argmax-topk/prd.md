# OCR GPU 侧 argmax/topK 实验

## Goal

实验在 WebGPU OCR AR 路径中把 logits argmax/topK 放到 GPU 侧，只回传 token id 和分数，减少 `[N,64,46272]` 大 logits CPU 下载。

## Requirements

- 只影响 OCR AR + WebGPU provider 的实验路径；WASM/WebNN/Node 路径必须保持原样。
- 先实现最小 prototype：针对 greedy decode（当前 `OCR_BEAM_WIDTH === 1`），每步从 logits 的当前 decode step 选出每个 batch sample 的最佳 token 和 score。
- prototype 必须可关闭；失败时自动回退现有 CPU logits 路径。
- 不改变 OCR 文本质量阈值、颜色复用逻辑和 provider fallback 语义。
- 不引入新的 ONNX 模型资产。

## Acceptance Criteria

- [x] 有浏览器 WebGPU 环境下的 prototype 数据：CPU logits path vs GPU argmax path。
- [x] GPU argmax 输出与 CPU argmax 在至少一个 fixture 上 token id 一致。
- [x] GPU prototype 失败时能回退 CPU logits path。
- [x] `npx tsc --noEmit` 与 `npm run build` 通过。
- [x] 若收益不稳定或实现风险过高，记录撤回原因，不默认启用。

## Outcome

已完成 prototype 并接入 WebGPU-only production 分支：

- 新增 `bench:ocr-gpu-argmax`，用真实 fixture 做 detect + OCR preprocess，然后在 Chrome WebGPU 里对比 CPU logits path 与 GPU argmax path。
- OCR WebGPU session 现在仅将 `logits` 输出留在 GPU buffer；`fg/bg/fg_ind/bg_ind` 仍走 CPU，保留颜色复用逻辑。
- batch AR decode 在 WebGPU provider 下优先用 WGSL reduction 计算 best token、logit score、softmax probability；失败时关闭 GPU reducer 并回退 `getData()` 下载 logits 的 CPU 路径。
- Node/CUDA/CPU 路径不启用该分支。

## Notes

- 延续归档任务 `06-01-ocr-ar-path-optimization` 的后续优化方向。
- 本任务不是 graph capture；上一轮已经确认当前 OCR 图不满足 ORT WebGPU graph capture 条件。
