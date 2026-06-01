# OCR encoder/decoder split + cache 设计草案

## 背景

当前 `ocr.onnx` 每个 token step 都接收 `image`、`char_idx`、`decoder_mask`、`encoder_mask`，推测视觉 encoder 可能每步重算。若能将 encoder 与 decoder 拆开，encoder 每个 region 只需跑一次，decoder 后续 token step 复用 encoder hidden state。

## 方案

1. 用 ONNX 图分析确认：
   - `image` 分支与 `char_idx` 分支在哪里汇合。
   - 是否存在稳定的 encoder hidden tensor 边界。
   - decoder 是否需要过去 key/value cache 或只依赖完整 prefix。
2. 若边界清晰，用 ONNX 工具导出两个子图：
   - encoder: `image` -> hidden states / masks
   - decoder: hidden states + `char_idx` + masks -> logits/colors
3. 用 Node/Browser fixture 对比 token 一致性和速度。

## 风险

- 原始 ONNX 可能经过融合/命名清理，缺少可稳定切分的中间输出。
- WebGPU EP 对导出子图的 op partition 可能更差。
- 拆图后中间 hidden state 体积可能很大，若每步 CPU/GPU 往返会抵消收益。

## 保留条件

只有当子图能跑通、token 一致、且端到端 OCR 明显更快时，才进入生产接入。
