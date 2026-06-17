# Paddle 冷启动验证设计

## 验证边界

本任务以 benchmark/spike 为主，生产行为默认不变。所有新能力优先通过 benchmark-only 参数、global flag 或窄工具入口触发，只有结论明确后才考虑进入产品默认路径。

## Baseline 链路

当前 cold run 形态：

1. `runPipeline()` 加载图片。
2. `probeRuntime("detector")` 准备 detector。
3. detect 阶段开始时 `startOcrRuntimeProbe()` 准备旧 `ocr_encoder`/`ocr_decoder`。
4. Paddle OCR 阶段进入 `paddleocrProvider.recognize()` 后才加载 `paddleocr_v6_medium_rec` session 和 v6 字典。
5. WebGPU 下默认 width-bucket，并在冷 session 上执行 `coldFirstSerial`。

已知问题是第 3 步与当前 Paddle medium 产品形态不匹配，导致 detect/bubble 窗口没有真正为 Paddle 做准备。

## 实验 A：Paddle 触发后懒准备

目标是在用户点击后、detect/bubble 阶段内提前完成 Paddle model/session/charset 准备。

设计：

- 增加窄的 Paddle prepare helper，复用 `getModel()`、`getModelSession()`、`loadCharset()` 和当前 provider override 规则。
- orchestrator 在 `config.ocrEngine === "paddleocr_v6_medium"` 时可选择启动 Paddle prepare promise，而不是旧 AR OCR probe。
- benchmark 中提供开关对比关闭/开启 prepare。
- prepare 只创建 session/加载字典，不执行 dummy inference，先验证低风险收益。

风险：

- ONNX worker 是单例，session 创建可能和 detector/bubble 争用。
- 只准备 session 不一定降低首次 WebGPU `run()` 编译，但能减少 OCR 阶段里的 session/charset 等待。

## 实验 B：small vs medium 冷启动候选

目标验证 `PP-OCRv6_small_rec` 是否能在首图速度上显著优于 medium，并保持样本文本可接受。

设计：

- 重新注册或临时暴露 `paddleocr_v6_small_rec` 给 benchmark 使用。
- 复用同一 Paddle provider 工厂和 v6 字典。
- 同一图片、同一 provider、同一 process mode 下比较 cold total、cold OCR、首个 inference、warm median、识别文本。

风险：

- small 质量可能在更复杂图片上弱于 medium；本任务只给出 benchmark 证据，不直接产品切换。
- 如果当前运行时代码已收敛为 medium-only，需要小心不要恢复用户可见选项。

## 实验 C：WebGPU 静态 shape / graph capture / controlled warmup

目标验证 ORT WebGPU 高级选项是否能降低真实首图等待。

设计：

- 在 session options 层增加 benchmark-only 配置：`enableGraphCapture`、`preferredOutputLocation`、必要时固定输入 shape。
- 优先用固定 `[1,3,48,320]` 或 small set of bucket shapes 做单独 benchmark，不直接进入产品默认。
- warmup 必须测端到端 cold total，不只看 OCR stage；若 warmup 阻塞 detect/bubble，则判定无净收益。

风险：

- `enableGraphCapture` 要求输出在 `gpu-buffer`，但 Paddle CTC 需要把 logits 拉回 CPU decode，可能增加额外约束或失败。
- graph capture 更偏向后续 replay，首次编译成本仍可能存在。
- 静态 shape 会改变 padding/time steps，需要记录文本差异。

## 数据输出

每组 report 至少整理：

- cold total、cold OCR、warm median total、warm median OCR。
- Paddle provider、batch mode、sessionLoadMs、preprocessTotalMs、inferenceTotalMs、decodeTotalMs。
- 首个 inference 的 input dims 和 duration。
- region 数、accepted/rejected 数、样本文本。
- 失败时的错误信息和发生阶段。

## 回滚

benchmark-only 开关可直接移除。若实现了 shared helper 但不改变默认行为，可保留；若任何实验影响生产路径，回滚到仅 medium baseline。
