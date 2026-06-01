# OCR active batch 压缩设计

## 当前问题

`decodeBatchAutoregressive()` 当前每个 AR step 都用原始 `N` 构造 `[N, ...]` 输入。即使部分样本已经 `finished`，这些样本仍然被送进模型参与推理。

fixture 的 active count 已观测为：

```text
14, 14, 14, 13, 9, 7, 2, 1
```

固定 batch 相当于 8 step * 14 = 112 sample-step；真实需要 74 sample-step。

## 方案

每个 step：

1. 生成 `activeIndices`，仅包含未结束且 token 长度未超过 seqLen 的样本。
2. 为 active 样本构造 compact batch：
   - `activeImage`
   - `activeCharData`
   - `activeDecoderMask`
   - `activeEncoderMask`
3. `session.run()` 使用 active batch。
4. 输出按 `activeIndices` 映射回原 region。
5. GPU argmax reducer 接收 active batch size，并将结果映射回原 region。
6. 颜色复用从 active batch 输出中抽取，写回原 region 的 `latestColors`。

## 风险

- WebGPU 动态 batch shape 可能触发额外编译/缓存 miss，导致收益被抵消。
- compact batch 每步重建 image buffer 会增加 CPU copy；需要和减少模型计算的收益比较。
- 颜色输出维度从 N 变成 activeN，必须用 active local index 读输出。

## 回退

如果 benchmark 显示收益不明显或 WebGPU path 不稳定，撤回 production 改动，只保留记录。
