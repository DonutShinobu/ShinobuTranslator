# OCR WebGPU AR 专项优化实验结果

## 实验目标

验证当前 AR OCR 模型是否适合通过 ORT WebGPU graph capture 或 GPU buffer 输出减少每 token `session.run()` 成本。

## 官方最佳实践对照

- ORT WebGPU graph capture 只适合静态 shape 且所有计算 kernel 都能落到 WebGPU EP 的模型。
- WebGPU 默认仍会把 CPU tensor 拷贝到 GPU、再把输出拷回 CPU；AR/transformer 型多次 run 的模型更适合用 IO binding 或 GPU tensor 避免反复往返。
- `preferredOutputLocation: "gpu-buffer"` 需要按输出精确控制，并显式处理 `getData()`/`dispose()`，不能全局打开后继续走现有 `tensor.data` 路径。

## 本地浏览器验证

环境：

- Chrome: `C:\Program Files\Google\Chrome\Application\chrome.exe`
- 启动参数：`--enable-unsafe-webgpu`
- 页面：`http://127.0.0.1:<port>/__probe.html`
- ORT bundle：`node_modules/onnxruntime-web/dist/ort.all.bundle.min.mjs`
- 模型：`public/models/ocr.onnx`
- GPU adapter: AMD / RDNA 3

结果：

```json
{
  "gpu": {
    "secureContext": true,
    "hasNavigatorGpu": true,
    "adapter": true,
    "adapterInfo": {
      "vendor": "amd",
      "architecture": "rdna-3"
    }
  },
  "baseline": {
    "status": "ok",
    "elapsedMs": 8403.57,
    "run1Ms": 3990.89,
    "run2Ms": 232.8,
    "outputs": {
      "logits": [1, 64, 46272],
      "fg": [1, 64, 3],
      "bg": [1, 64, 3],
      "fg_ind": [1, 64, 2],
      "bg_ind": [1, 64, 2]
    }
  },
  "graphCapture": {
    "status": "error",
    "elapsedMs": 2304.39,
    "error": "This session cannot use the graph capture feature as requested by the user as all compute graph nodes have not been partitioned to the JsExecutionProvider"
  }
}
```

## 结论

- 不合入 WebGPU graph capture。当前 OCR ONNX 图不满足 ORT graph capture 的硬条件，直接开启会导致 session 创建失败。
- 不做全局 `preferredOutputLocation: "gpu-buffer"`。当前 OCR 解码需要 CPU 读取 `logits` 做 argmax/top-k 和颜色抽取；若只把输出留在 GPU，必须同步改 GPU 侧 token selection/reduction，否则会引入额外 `getData()` 复杂度和泄漏风险。
- 保留当前 provider fallback。WebGPU session 普通 warm run 表现可用，但现阶段主瓶颈仍是 AR 多步解码和 CPU 读取大 logits；本轮已落地的“AR 输出复用颜色”收益更稳。

## 后续建议

1. 若继续优化 AR 路径，优先做 GPU/worker 侧 argmax/top-k，只把每步 token id 和必要颜色结果传回 CPU，避免下载 `[N, 64, 46272]` 完整 logits。
2. 中期方案是替换为非 AR/CTC 或并行 decoder OCR 模型，减少 `session.run()` 次数。
3. WebGPU 专项应保留为实验项，不默认启用 graph capture。

## 验收状态

- [x] 浏览器 WebGPU 环境下有实测数据。
- [x] WebGPU graph capture 失败时不改生产路径，等价于回退当前 OCR 路径。
- [x] 未修改 detector GPU preprocess 路径。
