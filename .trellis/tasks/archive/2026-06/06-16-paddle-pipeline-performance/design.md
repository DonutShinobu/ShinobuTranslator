# Paddle pipeline 性能分析与加速设计

## 目标结论

当前证据指向：Paddle pipeline 的可优化主点不是“必须把每个 OCR 输入固定到 320”，而是 Paddle OCR provider 的多次 `runInference`、provider/shape 开销和缺少可观测性。固定 320 串行会增加计算和输入传输；用户已实测固定宽度不会造成明显 OCR 质量倒退，因此当前实现采用 32px width-bucket batch 作为 GPU 类 provider 的默认优化，同时 CPU/WASM 仍默认 serial，避免 Node CPU 波动误导生产策略。

## 边界

- 不修改 detector 模型、输入尺寸、阈值或后处理，避免影响检测效果。
- 不做页面加载时预加载，不新增长期驻留的大模型内存。
- 保持当前产品决策：`48px` 默认，`Paddle` 对应 `paddleocr_v6_medium`。
- 优化范围集中在 Paddle OCR provider、OCR debug 数据结构、benchmark/profile 脚本。

## 当前链路

1. `runPipeline()` 加载图片并创建原图 canvas。
2. `probeRuntime("detector")` 加载 detector session。
3. detect 阶段运行 `detectTextRegionsWithMask()`，WebGPU 时走 detector GPU preprocess + IO binding，输入固定 `1024x1024`。
4. detect 开始时 `startOcrRuntimeProbe()` 预启动旧 `ocr_encoder`/`ocr_decoder` probe，但这不是 Paddle medium session。
5. OCR 阶段调用 `runOcr(image, regions, "paddleocr_v6_medium", platform)`。
6. Paddle provider 内部加载 `paddleocr_v6_medium_rec`、加载字典、逐 region 运行 `buildPaddleOcrInput()`。
7. CPU/WASM 默认每个 region 单独调用 `runInference(sessionId, [1,3,48,width])`；WebGPU/CUDA、非 CPU WebNN 默认按 32px bucket 打包为 `[N,3,48,bucketWidth]`，再拆分 `[N,T,C]` 做 CTC decode。
8. `fillMissingOcrFields()` 对缺失颜色执行裁切和颜色采样。
9. 后续 merge/order/translate/inpaint/typeset 继续复用现有逻辑。

## Profiling 设计

Paddle 路径的可观测性已补齐；默认优化开关采用 provider-aware 策略，后续继续用同一 debug 字段做浏览器 WebGPU 复测。

需要记录：

- session 准备耗时：`getModel()`、`getModelSession()`、`loadCharset()`。
- region 数量、每个 region 的原始 box、direction、dynamic width、输入字节数。
- preprocess 总耗时和 per-region 耗时。
- OCR 推理分组：group/bucket 宽度、batch size、region ids、run count、input bytes、output time steps。
- 每个 inference run 的 wall time、decode time、有效 OCR 数、输出文本样例。
- `fillMissingOcrFields()` 颜色补齐耗时，避免 OCR stage 里隐藏颜色采样成本。

输出落点：

- 复用 `OcrRunDebugInfo` 的已有字段时，要避免把 CTC batch 硬塞成 AR decode 语义。
- 建议先扩展 debug 类型，新增 Paddle/CTC 友好的字段；UI 可先只消费已有通用字段，benchmark 消费新字段。
- 同时可在 benchmark 中接入 `PerfTraceWorkerCall`，对照 `runInference` worker 调用的 `inputBytes/outputBytes/durationMs`。

## 优化候选

## 浏览器 profile 后的瓶颈排序

基于 2026-06-17 的本地 fixture 浏览器 WebGPU profile：

1. Cold run 最大瓶颈是 Paddle OCR 首次 WebGPU inference/shape 编译。默认 width-bucket cold OCR `15.30s`，其中首次 inference `13.89s`，session 创建约 `1.18s`。
2. Warm run 全流程最大瓶颈不是 Paddle OCR，而是 `processMode=erase/original` 下的去字并行阶段：`parallel` median 约 `0.8-1.3s`，其中 inpaint 约 `0.59-0.95s`，mask refine 约 `0.21-0.36s`。
3. Warm run Paddle OCR 是中等项：`erase` 下 OCR median 约 `245ms`，`original` 下约 `170ms`；其中 Paddle inference 约 `84-124ms`，preprocess 约 `56-81ms`，CTC decode/颜色补齐各约 `6-23ms`。
4. Width-bucket 在浏览器 WebGPU 热跑中能减少 `runInference` 次数（17 -> 8）并略降 inference（约 `144ms -> 124ms`），但对全流程只属于小优化；更大的端到端收益应来自 cold session/shape 编译重叠，以及 inpaint/mask refine。

### 1. Width-bucket batch

已把 Paddle OCR 分为准备和推理两步：

1. 先对所有 region 构造动态宽度 input。
2. 按 bucket 宽度分组，例如向上取整到 32px 或 64px，上限 320。
3. 每组 pack 成 `[N,3,48,bucketWidth]`。
4. 每组调用一次 `runInference()`。
5. 按 batch index 拆输出 `[N,T,C]`，分别 CTC decode 后映射回 region。

优点：

- 减少 `runInference` 次数和 worker 往返。
- 保留接近动态宽度的计算量，避免所有 region 都固定 320。
- 不改 detector，符合检测效果约束。

风险：

- padding 会改变 CTC time steps 和上下文，少量 OCR 文本可能变化；用户已接受固定宽度无明显质量倒退，但 benchmark 仍必须记录差异。
- WebGPU 下不同 bucket width 可能触发不同 shape 编译/缓存行为，必须用浏览器测。
- 需要继续观察 padding 对文本/标点的影响。当前按 bucket 补零，用户已接受固定宽度无明显质量倒退，但 benchmark 仍需要记录文本差异。

### 2. Paddle profile benchmark

新增或扩展 benchmark，支持浏览器中运行 Paddle pipeline：

- `--ocr-engine=paddleocr_v6_medium`
- `--process-mode=erase/original`
- `--runs=N`
- 输出 stageTimings、Paddle debug、worker calls、region width 分布。

这比改 `run-browser-x-compare.ts` 的旧 AR 对比模式更稳，因为它避免和 `48px` 历史优化参数混在一起。

### 3. 用户触发后的懒并行加载

当前 detect 开始时预启动的是旧 OCR encoder/decoder，不是 Paddle。可以在确认用户选择 Paddle 后，在 detect 阶段开始后并行创建 Paddle medium session 和加载字典。

优点：

- 不在页面加载时占内存，只在用户点击翻译后发生。
- 可把一部分 Paddle session cold start 与 detect 重叠。

风险：

- detector、bubble、inpaint 也会争用 worker/GPU；并行 session 创建可能让 cold run 抖动。
- 需要 perf 证明有收益，否则先不做。

### 4. Preprocess 小优化

当前每个 region 会裁切、透视、旋转、resize、`getImageData()`、RGBA 到 NCHW。现有样本约 40-70ms/14 框，不是首要瓶颈；实现已避免 serial 单 region 重新 pack 造成的二次复制。

优先级低于 profiling 和 batch 推理。

## 不推荐方案

- 把每个 region 无条件固定到 320 后继续串行推理：Node 探针显示更慢，输入字节明显增加，还会改变 OCR 输出。
- 页面加载时预加载 Paddle medium：违背“不预加载占内存”约束。
- 为了速度调低 detector 输入或阈值：会直接触碰检测效果，超出本任务首选边界。
- 复用旧 `48px` prewarm 设计给 Paddle：旧 prewarm 面向 AR encoder/decoder，不适配 Paddle CTC medium，且已有 cold-start 文档显示预热收益噪声较大。

## 验证策略

- Node 探针只作为开发快速反馈，不能替代浏览器 WebGPU 结论。
- 浏览器必须验证冷启动和热运行，至少 2-3 次 runs，分别记录第 1 次和 warm median。
- OCR 质量回归至少比较：
  - 非空识别 region 数。
  - 总字符数。
  - 每个 region 文本差异。
  - 代表性样本输出。
- 检测回归要求：改动后 detected region 数、box/quad、mask 生成不得变化；如果实现只改 OCR provider，检测输出应天然不变。
- 内存约束检查：不新增页面加载时 session；session 仍由现有 `modelRegistry` cache 在用户触发后复用。

## 回滚

- Profiling 字段可保留，不改变行为。
- Batch 优化应集中在 Paddle provider 内部；若浏览器或 OCR 文本回归失败，回滚到逐 region 串行。
- 当前默认按 provider 选择：GPU 类 provider 使用 width-bucket，CPU/WASM 保持串行；benchmark 可显式打开或关闭 batch。
