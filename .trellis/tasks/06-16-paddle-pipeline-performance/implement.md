# Paddle pipeline 性能分析与加速实施计划

## 阶段 1：补齐 Paddle profiling

1. [x] 扩展 Paddle provider 输出，让 `runOcr()` 能返回 Paddle CTC 的真实 debug，而不是 `createDefaultDebug()`。
2. [x] 记录 Paddle session 准备耗时：manifest/model resolution、session 创建或 cache hit、字典加载。
3. [x] 记录 preprocess 总耗时、per-region 耗时、region width 分布、输入字节数。
4. [x] 记录每次 `runInference()` 的 region id、input dims、input bytes、输出 dims、推理 wall time、decode time。
5. [x] 记录 `fillMissingOcrFields()` 颜色补齐耗时，避免把颜色采样误判成模型推理。
6. [x] 更新 `benchmark/perf/src/run-ocr-debug.ts`，让 Node 输出 Paddle 子阶段摘要。
7. [x] 新增或扩展浏览器 Paddle profile benchmark，支持 `--ocr-engine=paddleocr_v6_medium`，输出 stage timings 和 Paddle debug 汇总；OCR worker call 可由 Paddle inferenceRuns/input-output bytes 覆盖，完整 jank workerCalls 仍留给 UI jank smoke。

## 阶段 2：验证瓶颈

1. [x] 在当前 fixture 上跑 Node profile，记录冷/热 OCR、width 分布、推理 run count。
2. [x] 在浏览器 WebGPU 上跑 Paddle profile，至少 `--runs=3`，区分 cold run 和 warm median。
3. [x] 对照 Paddle debug 中的 inferenceRuns/inputBytes/outputBytes，确认 Paddle OCR stage 中 session 创建、input/output transfer、ONNX run 的占比；完整 `PerfTraceWorkerCall` 后续可通过 UI jank smoke 关联到长帧。
4. [x] 明确回答固定输入问题：分别比较当前动态串行、固定 320 串行、bucket batch、全 320 batch。
5. [x] 明确回答 WASM provider 问题：强制 `--paddle-provider=wasm` 和 `--paddle-provider=wasm --paddle-batch` 对照 WebGPU。

## 阶段 3：实验 width-bucket batch

1. [x] 在 Paddle provider 内部把 prepare 和 inference 分离。
2. [x] 实现 batch pack helper：从多个动态 `[1,3,48,w]` 输入打包到 `[N,3,48,bucketW]`。
3. [x] 实现 bucket 策略，初始候选为 32px bucket，上限 320；保留串行 fallback。
4. [x] CTC decode 支持 `[N,T,C]` 输出拆分，并按原 region 顺序映射结果。
5. [x] 记录 batch debug：bucket 宽度、batch size、run count、输入字节、输出 time steps。
6. [x] 默认策略改为 provider-aware：GPU 类 provider（WebGPU/CUDA、非 CPU WebNN）默认 width-bucket；CPU/WASM 默认 serial；benchmark 可用 `--paddle-batch`/`--paddle-serial` 强制对照。

## 2026-06-17 浏览器 WASM 对照结论

- 同一 fixture、`processMode=erase`、`runs=3`、同一版 bundle 下，强制 WebGPU report 为 `benchmark/perf/reports/x-current-2026-06-16T16-19-15-546Z.json`：warm median total 2.46s，OCR 250ms，Paddle inference 113ms，batch 为 width-bucket 8 runs；cold OCR 14.95s，主要是首次 WebGPU shape/session 编译。
- 强制 WASM serial report 为 `benchmark/perf/reports/x-current-2026-06-16T16-17-58-520Z.json`：warm median total 5.40s，OCR 3.49s，Paddle inference 3.36s，serial 17 runs。
- 强制 WASM width-bucket report 为 `benchmark/perf/reports/x-current-2026-06-16T16-18-36-954Z.json`：warm median total 4.95s，OCR 3.47s，Paddle inference 3.03s，width-bucket 8 runs。
- 结论：WASM 可以避开部分首张 WebGPU 编译成本，但热运行 OCR 比 WebGPU 慢约 14x，且全流程 warm total 慢约 2x；不应把 Paddle 默认 provider 改成 WASM。若要优化“无预加载”的首张耗时，优先考虑用户触发后 detect 阶段期间懒并行准备 Paddle session，或更少 shape 的 WebGPU warm-up，而不是长期使用 WASM。

## 阶段 4：可选懒并行加载

1. [ ] 修正或扩展 orchestrator 的 OCR runtime probe：当 `config.ocrEngine === "paddleocr_v6_medium"` 时，探测/准备 Paddle medium，而不是旧 `ocr_encoder`/`ocr_decoder`。
2. [ ] 仅在用户触发 pipeline 后、detect 阶段期间启动，不做页面加载时预加载。
3. [ ] 用浏览器 profile 证明 cold run 总耗时下降且没有明显 worker/GPU 争用后再保留。

## 2026-06-17 WebGPU cold-first serial 实验

- 实现：WebGPU + width-bucket 的 Paddle session 第一次 OCR run，先用第一个真实 region 逐 region 跑一次，再对剩余 region 继续 32px width-bucket；不是 dummy warmup，不页面预加载，也不创建第二份 session。
- 触发记录在 `ocrDebug.paddle.coldFirstSerial`；benchmark 可用 `--paddle-no-cold-first-serial` 关闭对照。
- 开启默认策略 report `benchmark/perf/reports/x-current-2026-06-16T17-04-26-492Z.json`：cold total 14.56s，OCR 9.05s，Paddle inference 8.10s，首个真实 region `1x3x48x234` 约 7.88s，后续 bucket `N=1/2/3/4` 均为毫秒级；warm median OCR 159ms。
- 同版关闭策略 report `benchmark/perf/reports/x-current-2026-06-16T17-05-03-589Z.json`：cold total 14.70s，OCR 9.41s，Paddle inference 8.56s，首个 bucket `2x3x48x256` 约 8.48s；warm median OCR 155ms。
- 结论：cold-first serial 对本轮同版对照有小幅 cold OCR 收益，历史 worst-case 中可避开 `N=2` 首 bucket 13s+ 的抖动，但 WebGPU 首次 `session.run()` 编译仍是主瓶颈。它可以作为低风险默认策略保留；更大的 cold total 优化仍需研究“用户点击后、OCR 前窗口内准备 Paddle session/受控 warmup”，并必须测 worker/GPU 争用。

## 2026-06-17 临时产品 WASM 构建

- 按用户要求，把 `public/models/models.json` 的当前产品 Paddle 模型 `paddleocr_v6_medium_rec.runtime` 临时改为 `["wasm"]` 并重新 `npm run build`，用于实机试速度；旧 `paddleocr_rec` 和其它模型 provider 不变。
- 不带 `--paddle-provider` 的浏览器 profile smoke 报告 `benchmark/perf/reports/x-current-2026-06-17T11-41-23-533Z.json` 确认默认 Paddle provider 为 `wasm`，serial 17 runs，单次 cold total 30.58s，OCR 9.03s，Paddle inference 6.46s。
- 用户实测后确认 WASM cold 也不够快；已把 `paddleocr_v6_medium_rec.runtime` 回退为 `["webgpu", "webnn", "wasm"]` 并重新 build，当前 dist 为 WebGPU 优先。

## 验证命令

```bash
npm run models:check-paddle-ocr -- public/models/PP-OCRv6_medium_rec.onnx public/models/paddleocr_v6_dict.txt
npm run test -- tests/shared/config.test.ts tests/pipeline/ocr/paddleocrDecode.test.ts
npx tsc --noEmit --pretty false
npm run build
npm run bench:ocr-debug -- --ocr-engine=all --runs=2
npm run bench:ocr-debug -- --ocr-engine=paddleocr_v6_medium --runs=2 --paddle-batch
npm run bench:ocr-debug -- --ocr-engine=paddleocr_v6_medium --runs=2 --paddle-serial
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3 --paddle-serial
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3 --paddle-provider=wasm
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3 --paddle-provider=wasm --paddle-batch
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3 --paddle-provider=webgpu --paddle-no-cold-first-serial
npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3 --process-mode=original
```

浏览器 profile 已支持 X 图片和本地 `--image` fixture；最低要求是能在 Playwright Chromium/WebGPU 下运行 Paddle medium，并输出 JSON report。

## 回归门

- 检测：本任务默认不改 detector，因此 detected region 数和 box/quad 应保持不变。
- OCR：优化默认开启前，非空 OCR 数不能下降；固定宽度/分桶造成的 region 文本差异需要报告，明显质量倒退才阻塞继续。
- 性能：目标是 warm Paddle OCR stage 至少下降 15%，或 cold total 有明确下降；CPU/WASM 不因 Node 数据波动默认 batch，GPU 类 provider 仍需浏览器 WebGPU profile 验证收益。
- 内存：不得新增页面加载时模型 session；用户触发后的 session cache 复用沿用现有 `modelRegistry`。

## 风险与回滚点

- Profiling 改动若只增加字段，不改变行为，回滚风险低。
- Batch pack/CTC decode 是主要风险点；保持串行 fallback，并用实验开关保护。
- Padding 值可能影响 OCR 文本；默认策略必须由浏览器回归数据决定。
- 若 WebGPU 对多 batch 或 bucket shape 支持不稳定，回滚 batch，保留 profiling 和 benchmark。
