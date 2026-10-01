# 首装着色器模板实验

2026-10-01。范围为 Chromium、原有模型和 float32，目标是无历史 profile 的完整首次处理由 5691 ms 降至 2845 ms；排除外部翻译。**完整模板方案值得进入组合测试，单靠该项没有达到预算。固定模型子集未显示稳定的端到端收益，遗漏 OCR 首次编译。**

## 当前瓶颈与已有收益

生产 `shaderWarmup.ts` 已实现历史 WGSL CacheStorage 和四路 `createComputePipelineAsync()`，与模型加载重叠。该收益已经计入当前 baseline。首装没有以前运行收集的源码，因此仍会在首次 detector、bubble、OCR、inpaint 推理期间编译。

09-16 的控制实验在相同输入上收集 109 个模板、363993 bytes；四路异步预编译与 Session 加载重叠时，旧组首图中位数 4970.0 → 4223.2 ms，结果像素相同。这是候选依据，不能作为 10-01 新 baseline 的新增收益。旧模板缺少精确设备 features/limits 和模型 hash 绑定，本次要求重新捕获。

## 最小候选

复用现有 Worker 前缀 probe，生产运行时和模型不变：

1. `capture` 用当前构建的真实流程收集 WGSL、entry point、constants，以及精确 ORT 版本、完整浏览器 UA、adapter 信息、device features/limits。
2. 模板文件绑定实际打包模型的 SHA-256。改变 ORT 或任一模型后拒绝使用，必须重捕；改变设备指纹时跳过模板，推理仍按原路径执行，实验 runner 将这轮标记为不成立。
3. `async4fixedoverlap` 只预编译真实 detector / bubble / inpaint 使用过的模板；`async4overlap` 使用整个首图捕获集合，作为包括 OCR 特定 shape 的上限对照。
4. 模板只是预热 Dawn native cache。原始 ORT 仍生成原代码、创建和使用原管线；没有替换输出 tensor、改变模型或启用较低精度。新 Worker 解析模板和全部预编译工作都包含在实际计时中。

固定模型 input 为 detector 1024²、bubble 640²、inpaint 512²。OCR width/batch 根据 ROI 改变；单一图片捕获的 OCR 模板不能宣称覆盖所有输入。共享 shader 在多个模型出现时保留所有所属模型，fixed 子集可以复用它们。

设备指纹使用与生产历史缓存相同的格式。模型绑定在实验启动时核验；若以后发行模板，模型 hash 应由构建阶段写入发布清单，避免用户首次启动额外扫描全部模型。Chromium 在当前环境将 `adapter.device/description` 留空；该指纹精确匹配浏览器可见的 nvidia/blackwell、features/limits 和 UA，不能宣称唯一绑定物理显卡或驱动版本。

## 复跑

请将这些浏览器 / GPU 实验与其他性能测试、扩展构建串行执行。每轮会临时改写已构建 Worker，`finally` 恢复原文件。

```powershell
# 主控完成构建后，再收集；capture 不参与性能比较。
node benchmark/perf/src/run-cold-start-experiments.mjs --variants=capture --process-mode=original

# 每个 variant 新浏览器和 profile；同进程另测第二次处理。
# 相邻轮次反转顺序，且检查完整结果 RGBA SHA-256。
node benchmark/perf/src/run-cold-start-experiments.mjs --variants=baseline,async4fixedoverlap,async4overlap --rounds=2 --process-mode=original

# CPU-only 可复跑检查。
node benchmark/perf/src/check-cold-shader-probe.mjs
```

模板写入 `.tmp/cold-start-experiments/templates.json`；原始报告记录 `visibleResultMs`、`displayTailMs`、每阶段时间、冷 / 热结果像素 hash，不能仅比较推理或预编译时长。

## 检查与边界

CPU 检查已通过：Comlink 推理请求的模型标签不会被重叠的 Session 创建覆盖；精确设备匹配启动异步预编译；指纹改变跳过模板且保留原管线创建。runner 语法检查和 `git diff --check` 通过。

[WebGPU 规范](https://gpuweb.github.io/gpuweb/#pipeline-creation)明确指出普通管线创建返回对象后，真实编译仍可能在创建、使用、finish 或 submit 时引起等待；异步创建在可使用时才 resolve，可避免编译阻塞 queue timeline。**规范没有保证另一次相同描述的同步创建一定复用 native cache**，该收益必须实测，不能靠 API 名称推定。

当前严格绑定的 RTX 模板只覆盖匹配环境。若希望所有 GPU 在首装获益，需要多个经过验证的设备模板包，或修改 ORT 的初始化生命周期，在当前设备上根据固定 shapes 提前生成 WGSL 并异步编译。没有源码模板时，单纯把一个同步方法名替换成 Async 会破坏 ORT 的返回对象契约。

[ORT WebGPU 文档](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)中的 graph capture 主要帮助固定 shape 的重复执行，必须先执行一次捕获；它不能省掉真正首图的编译。IO binding 可减少数据搬运，是其他阶段的独立候选。

## 端到端实验结果

统一 capture 已完成，原始汇总 `.tmp/cold-start-experiments/1790844711456-results.json`。当前模板 109 个，文件 371935 bytes；全部有模型归属，detector 40 / bubble 21 / OCR 41 / inpaint 13 个。跨模型共享模板使合计超过 109；fixed 子集共 71 个。Paddle 逐组顺序 await，当前真实推理请求的标签不会被 Session 创建覆盖。

capture 冷 / 热结果的完整 RGBA hash 均为 `d3bd5084867c64501ac615d6baacb8cb31ee38f6b93af28cb7ce78f2d1d8ba97`，与主控 baseline 一致。capture 带有多次 HTTP 上报，仅用来生成模板，7149.3 / 3173.9 ms 不作为性能对照。

两轮真实扩展对照已完成，原始汇总 `.tmp/cold-start-experiments/1790844865670-results.json`。相邻轮次执行顺序反转；每次新浏览器和 profile，随后同 Worker 测第二次处理。全部使用 `original` 模式，不请求外部翻译。没有清空 OS / 驱动缓存。

| 方案 | 首图显示完成：两轮 ms | 首图中位 ms | 同 Worker 热图中位 ms |
|---|---:|---:|---:|
| 当前 baseline | 5813.1 / 7281.2 | 6547.2 | 3035.1 |
| 71 个固定模型模板 | 7513.3 / 6240.3 | 6876.8 | 3388.4 |
| 109 个完整模板 | 4198.4 / 6453.2 | 5325.8 | 2695.4 |

完整模板首图显示完成中位数减少 1221.4 ms / 18.7%；两轮分别减少 1614.8 / 828.0 ms。固定模板中位数慢 329.6 ms / 5.0%。只测两轮且系统负载明显波动；这不是统计显著性证明，不能直接把 18.7% 平移到之前 5691 ms 的组。

### 内部阶段

下表是 `pipelineSummary.stageTimings` 的两样本中位数。它们包含阶段内等待和处理，不能称为纯 GPU 计算时间。PNG 仅指编码，显示完成还包括结果交付和浏览器解码。

| 内部阶段 ms | baseline | 固定模板 | 完整模板 |
|---|---:|---:|---:|
| detector preload | 1120.5 | 1226.3 | 1207.7 |
| detector | 908.2 | 976.2 | 452.0 |
| bubble | 748.4 | 649.9 | 496.8 |
| OCR | 842.2 | 893.8 | 453.4 |
| mask refine | 280.9 | 319.6 | 284.0 |
| inpaint | 557.1 | 476.8 | 429.3 |
| order | 167.6 | 209.7 | 171.6 |
| typeset | 45.3 | 63.0 | 43.8 |
| PNG | 205.0 | 256.8 | 207.5 |

完整模板 detector 两轮为 413.5 / 490.4 ms，对照 896.3 / 920.1 ms；两轮都有清楚的减少。预编译总耗时 978.6 / 938.6 ms，与 preload 等任务重叠；不能再把该时间加到总耗时，或从总耗时中完整扣除。

OCR 的实际 `session.run()` + 输出回传总时长，对照 673.2 / 735.3 ms，固定模板 711.3 / 724.4 ms，完整模板 176.6 / 286.7 ms。第一组 OCR 对照 491.5 / 510.7 ms，完整模板 83.8 / 148.9 ms；第二组 105.6 / 102.7 → 12.0 / 20.1 ms。固定模板刻意遗漏 38 个 OCR 独有 shader，因此保留了约 500 ms 的首次 OCR 等待。为达到整体预算，不能只覆盖 detector/bubble/inpaint。

固定模板首轮 detector 1430.5 ms，第二轮 521.9 ms。首轮 CPU busy 60.1%，同时 CPU order/mask/typeset 和热 detector 也更慢；仅靠这些计时无法区分负载与预编译争用，不能把首轮异常当成争用根因的证明。完整模板第二轮的 font/准备、模型 preload、order、PNG 和热图也广泛变慢，说明绝对耗时受到环境影响。热图中位数 3035.1 → 2695.4 ms 的波动不能全部归因于首图预编译。

### 输出质量与预算判断

12 个冷 / 热结果的 RGBA SHA-256 完全相同。另对 6 个冷报告做了严格比较：检测数量、四个模型 provider、17 个 OCR box / 方向 / 输入维度 / 文本 / confidence / 是否接受、输入和输出 tensor 总字节数完全相同。全部仍为原有 WebGPU 模型，原图最终显示一致。本次覆盖一个大尺寸输入，不代表完整多 GPU / 多图片质量集已经完成。

完整模板在本组仍需 5325.8 ms，最快单轮 4198.4 ms，均未达到 2845 ms；需要和加载、数据搬运等候选一起测真正的组合。未将 09-16 的旧组收益、生产已经具备的历史缓存收益或跨线程累计编译时间纳入本次预算。
## 追加：Chromium 151 完整模板的调度窗口

只读分析主控 `.tmp/cold-budget/1790850878014-results.json`，不运行额外 GPU 负载。该组相邻两次新 profile 含多个组合变量，不能作为 shader 并发的独立 A/B 结论。

151 的 109 模板首次归属顺序：detector index 0–39（40），bubble 40–58（19 新模板），OCR 59–97（39 新模板），inpaint 98–108（11 新模板）。计入共享模板则分别 40/21/41/13。**Detector 已位于最前**，没有被 OCR 模板排到后面；重排模型优先级不足以解决当前 detector 未就绪。

组合 `all-direct-latefonts-binary-prefetch-nofence-reuse`：GPUDevice 约 743.7ms 就绪，detector preprocess 1345.9–1371.2ms、run 1371.2–1446.6ms、首 blk readback 1446.6–1742.1ms。full109 的 precompile 用 1538.1ms，按 device 返回时间估算约 2281.8ms 全部就绪，晚于 detector 使用时机。先前组合该计时为 2647ms，说明负载/驱动缓存变动大，不应按并发倍数推算收益。

该 run 的复用统计：detector module40 hits、pipeline12 hits/28 misses、nativeSyncMs0.5；bubble25/25；OCR 首批32/32+1 miss；inpaint13/13。module 命中而 pipeline 不命中可能是 async pipeline 尚未完成；这里的 28 misses 也包含至少一个确定的非时间原因：index0 是旧 letterbox 预处理，运行时使用 explicit layout，而模板以 auto 编译，probe 按约定不会复用 explicit layout。不能把 28 全称为模板不足或全部未完成。原生 synchronous create 返回仅 0.5ms，不等于 driver shader 编译只需 0.5ms，延后的工作可能由首次提交/readback 承担。

最小独立配置建议：保持相同 109 模板和原顺序、reuse=true、overlap=true，预算 runner 配 `--shader-concurrency=4|8|16`，传给现有 probe `config.concurrency`；先做 4 与 8 的同组合反转两轮，再按结果决定 16。8 有机会在 device→detector run 的约 627.5ms 窗口内准备更多模板，但线程池、驱动和设备争用可能限制并发收益，不能保证完成时间减半。不要删掉 OCR/inpaint 模板，也不要先等待 full109 完成再启动 detector。

当前 probe 只记录 full109 总完成用时，没有逐模板 completion timestamps，无法证明具体哪些 detector templates 晚到。比较应至少看 detector 的 pipeline hits、preprocess/run/首输出等待、其余模型首次输出等待和 visible 总时间；若只减少 precompile duration 却拖慢实际 inference，则不满足预算。新增 compile 细分诊断可沿现有 InitMark buffer 发 `templateIndex`、`model`、`startedAt`、`durationMs`，避免 109 次单独 fetch；Promise 回调完成时间仍包含 JavaScript 调度，不能称为纯 driver 编译时间。本次仅建议配置和观测接口，未编辑主控 runner/probe。

## 历史缓存 async8 的默认关闭候选

主控随后批准在 `shaderWarmup.ts` 加 `__shinobuColdStartShaderAsync8 === true ? 8 : 4`，仅改变历史缓存的异步预热 worker 数量，默认仍为 4。格式验证、MAX_SHADERS/MAX_BYTES、设备指纹、lost 检查、错误回退和现有缓存存储均保留；输入、模型、WGSL 和实际推理顺序不变。主控 runner 的 `async8` variant 将同时设置该 scalar 和静态模板并发 8，才能对 retained restart 也建立有效 A/B；只改静态模板 config 的版本对 restart 不生效。

```powershell
node benchmark/perf/src/check-shader-warmup-concurrency.mjs
node node_modules/typescript/bin/tsc --noEmit -p packages/model-runtime/tsconfig.json
```

CPU mock 检查已通过：13 个历史模板逐个释放 compilation Promise，undefined/false 的 peak 严格为 4、true 严格为 8，所有模板只编译一次且在途数始终不超上限。此检查不执行 shader，也不证明实际编译加速。

建议先测 async8：新 profile 有首 detector 未完成预编译窗口，最终仍保留同一套模板，新增的是并发编译暂存。dispatch64 可以影响 fresh/restart/warm，但 1.27 的 release 会将 tensor buffer 挂到 pending，flush 后才回 free pool；更晚提交可能扩大 GPUBuffer 峰值并推迟第一批执行，见 [gpu-data-manager.ts](https://github.com/microsoft/onnxruntime/blob/v1.27.0/js/web/lib/wasm/jsep/webgpu/gpu-data-manager.ts#L339)。它不是减少 GPU fence 的开关：现有 flush 不等 GPU 完成，upload/readback 的额外提交也不受同一阈值合并，不能预设省百毫秒。

两候选都需在两张图片保持输入 SHA、三个原始 detector 输出 SHA、所有 OCR 明细和全图像素严格一致，保持 provider，无 device lost / uncaptured error / OOM。dispatch64 额外比较 createBuffer 的已创建未 destroy bytes 峰值、buffer 数、submit 次数/首提交时间和连续 warm 后是否稳定；这些是 WebGPU 对象分配的代理值，不是完整 VRAM 实际占用。`system.minFreeMemoryBytes` 只有系统 RAM，不能替代 GPU 内存检查。质量/内存诊断与纯性能组分开，性能组不新增 fence。

## 追加：显式预处理布局与 CTC miss 已覆盖

主控在 gpuPreprocess.ts 增加默认关闭 auto layout 候选，保持原 LETTERBOX_SHADER / buffer / 参数，使用实际 pipeline.getBindGroupLayout(0)，并把原 gpuPaddleCtc.ts 导出的静态 shader 加到独立 151 的 CTC110 模板文件。原 109 与指纹未改，新增 shader 的精度和采样/归约逻辑未改。

质量/诊断 `.tmp/cold-budget/1790857001697-results.json` 两组均看到 detector 40/40、bubble 25/25、OCR 首批 33/33 和第二批 14/14、inpaint 13/13 命中，零 pipelineMisses/nativeSyncMs。此 fixture 的先前 explicit layout / CTC 原生创建 miss 已消失；原始输入、三个完整检测输出、全图 RGBA SHA 与完整 OCR 一致，provider 仅 webgpu，无 lost/error。

两组使用相同 CTC110 和 auto layout，独立变量为 CPU→GPU upload 开关。它们的诊断单样本时间不能作为 shader 调度收益或冷启动 median，具体 API 计数和正常性能验证状态见 `cold-budget-gpu-upload-2026-10-01.md`。其他 OCR width/batch 的模板覆盖仍由原 shape/key/fallback 规则决定。
