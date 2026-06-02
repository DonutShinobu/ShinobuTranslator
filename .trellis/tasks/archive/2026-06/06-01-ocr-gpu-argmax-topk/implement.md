# OCR GPU 侧 argmax/topK 实施计划

## Steps

1. [x] 读取 Trellis specs，确认 WebGPU dataflow 和 runtime 约束。
2. [x] 新增一个浏览器侧实验 benchmark，不接生产默认路径。
3. [x] 在实验里：
   - 创建 WebGPU OCR session。
   - 先跑 CPU logits path，得到当前 step CPU argmax。
   - 再跑 `preferredOutputLocation: { logits: "gpu-buffer" }` 或 fetches GPU tensor path。
   - 用 WGSL reduction 读取 GPU logits buffer，输出 token id/score。
4. [x] 对比 token id/score 和耗时。
5. [x] 根据结果决定是否推进到生产路径接入，或记录撤回原因。
6. [x] 接入生产 Worker 的 WebGPU-only batch decode 分支，并保留 CPU fallback。

## Browser Prototype Results

Fixture: `benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png`

Chrome WebGPU adapter: AMD / RDNA 3

| Batch | CPU run + argmax | GPU run + reduction/readback | Token mismatch | CPU logits download | GPU result download |
|-------|------------------|------------------------------|----------------|---------------------|---------------------|
| 1 | 208.98ms + 0.52ms | 176.05ms + 9.38ms | 0 | 11,845,632 bytes | 8 bytes |
| 4 | 387.18ms + 4.21ms | 321.87ms + 17.16ms | 0 | 47,382,528 bytes | 32 bytes |
| 14 | 940.27ms + 2.73ms | 760.04ms + 60.46ms | 0 | 165,838,848 bytes | 112 bytes |

Prototype 只计算 token/score；production 分支进一步在 GPU 上计算 softmax probability，以保持原 confidence 语义。

## Validation

- [x] `npm.cmd run bench:ocr-gpu-argmax -- --batch=1`
- [x] `npm.cmd run bench:ocr-gpu-argmax -- --batch=4`
- [x] `npm.cmd run bench:ocr-gpu-argmax -- --batch=14`
- [x] `npx.cmd tsc --noEmit`
- [x] `npm.cmd run build`
- [x] `npm.cmd run bench:ocr-debug`
- [x] `npm.cmd run test`

## Rollback

- 若 prototype 不稳定，只保留任务记录，不改 production OCR decode。
- 若新增 benchmark 代码影响构建，撤回 benchmark 脚本。
