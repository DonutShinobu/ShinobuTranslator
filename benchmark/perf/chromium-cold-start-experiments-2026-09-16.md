# 首次处理卡顿缓解实验：不依赖模型常驻，兼顾首图速度

2026-09-16。延续同日的冷启动诊断。实验使用 Chromium 145.0.7632.6、ORT Web 1.27.0、RTX 5070 Ti / NVIDIA 610.74；没有修改生产源码或依赖。每个样本均创建全新浏览器进程和 profile，第一张图重新加载模型；同进程第二次运行作为热路径检查。

**结论**

最值得继续产品化的方向是：**重用以前收集的 WGSL 源码，在新 GPUDevice 上以 4 路 `createComputePipelineAsync()` 预编译，并让预编译与模型 Session 加载重叠。**

第一张测试图的三轮对照，首次处理总耗时中位数从 **4970.0 ms 降到 4223.2 ms（约快 15.0%）**，Worker 动画心跳最大间隔的中位数从 **125.0 ms 降到 62.4 ms**，超过 50 ms 的间隔从中位 **10 次降到 1 次**。第二张图片复用第一张图的着色器集合，首次总耗时从 **3492.3 ms 降到 2512.75 ms（约快 28.0%）**。对应结果图的 RGBA 像素 SHA-256 完全一致。

这证明了“可以减轻冷启动卡顿，同时让首图更快”，但有两条不能省略的边界：

- 使用的是**预先收集的着色器集合**，不是首次安装时凭空知道任意输入形状。初次无缓存的运行仍须生成这些源码。本次没有实现通用磁盘缓存、失效策略或生产接入。
- 如果“加载速度不变”严格指 detector Session 的 preload 子阶段，三轮重叠方案是 **758.3 → 793.5 ms**，增加约 **35.2 ms / 4.6%**；第二张图是 **662.8 → 682.6 ms**。首图完成明显加快，但不能宣称每个加载子阶段都零退化。带 trace 的另一轮 preload 为 757.8 → 741.2 ms，也说明几十毫秒差异存在环境波动，需要更大样本确认。

**实验方法**

两个输入：

1. `benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png`
2. `benchmark/images/字体颜色 2.jpg`

使用真实扩展的快捷图片处理路径，`erase` 模式包含检测、气泡、OCR 与去字，排除外部翻译服务。每轮第一张图的耗时包含 Worker 启动、源码解析、WASM／模型加载、预编译、推理和结果交付；没有把预编译放在计时之前。只收集模板的 capture 运行不参与性能比较。

第一张图收集到 **109 个去重后的 shader 描述，JSON 大小 363,993 bytes**。实验将源码放进临时 Worker 前缀，在新设备上创建异步管线并持有引用，再让原始 ORT 按原路径创建／使用管线；依赖本次 Chromium/Dawn 对相同源码的 native cache 复用，没有替换模型数学计算。

`async4` 会等待预编译完成才返回 GPUDevice；`async4overlap` 立即返回设备，让模型创建与后台编译重叠。后者没有为卡顿插入固定 sleep，也没有把原始 ORT 的同步返回对象冒充成 Promise。未命中的形状仍走原来的同步编译路径。

每组按正序／反序交替执行，尽量降低时间顺序偏差；未清空系统文件缓存或驱动缓存。每种确认方案为 2–3 个新进程样本，不是统计显著性证明。系统同时运行其他应用，CPU 平均负载和热路径也有波动，不能把跨组的不同基线混在一起计算收益。

主要流畅度指标使用现有独立 Worker 的动画心跳，不把它误称为 ONNX Worker 执行时间。页面的全程最大间隔可能混有 UI 布局和交付停顿，因此保留原始数据，但不单独拿它证明 GPU 编译优化。

**方案筛选结果**

下表每行使用所在实验组自身的 baseline；具体原始样本见同目录 `chromium-cold-start-experiment-results-2026-09-16.json`。

| 方案 | 每项冷样本数 | 首图耗时中位数：对照 → 实验 | Worker 最大间隔中位数：对照 → 实验 | 判断 |
|---|---:|---:|---:|---|
| WASM 线程限制为 1 | 2 | 5229.8 → 4892.5 ms | 125.0 → 121.85 ms | 没有明显缓解 GPU 编译卡顿 |
| dispatch 批量 16 → 1 | 2 | 5229.8 → 5564.3 ms | 125.0 → 62.55 ms | 平滑一些，但慢约 6.4%，不符合首图速度目标 |
| dispatch 批量 16 → 4 | 3 | 5106.9 → 5318.6 ms | 118.6 → 62.5 ms | 慢约 4.1%，不优先 |
| 4 路异步预编译，阻塞设备返回 | 3 | 5106.9 → 4444.6 ms | 118.6 → 62.4 ms | 有收益，但 preload 739.9 → 1157.2 ms |
| 16 路异步预编译，阻塞设备返回 | 2 | 5229.8 → 4634.05 ms | 125.0 → 62.5 ms | 同组不如 4 路，不能假设并发越大越好 |
| **4 路预编译与模型加载重叠** | **3** | **4970.0 → 4223.2 ms** | **125.0 → 62.4 ms** | **目前最值得继续验证** |
| 2 路预编译与模型加载重叠 | 3 | 4990.1 → 4950.0 ms | 118.7 → 68.7 ms | 本组速度收益不稳定，未优于 4 路 |

4 路重叠方案主对照的原始首次耗时：

```text
baseline       5350.0, 4908.8, 4970.0 ms
async4overlap  4223.2, 4639.8, 4169.7 ms
```

对应三轮各自都比同轮 baseline 更快。热路径中位数为 1954.7 → 2126.7 ms，约 +8.8%；另一组带 trace 的热路径为 1944.5 → 1959.2 ms，第二张图则更快。本次尚不能严格排除热路径退化，也没有证据把这个波动单独归因于候选代码；产品验收需要继续跟踪，不能只挑最快单轮。

**第二张图：使用第一张图的着色器集合，不重新训练模板**

| 指标 | baseline | async4overlap |
|---|---:|---:|
| 首次处理两个样本 | 3302.2 / 3682.4 ms | 2513.0 / 2512.5 ms |
| 首次处理中位数 | 3492.3 ms | 2512.75 ms |
| Worker 最大帧间隔中位数 | 103.1 ms | 49.95 ms |
| Worker >50 ms 间隔中位次数 | 8 | 0 |
| 模型 preload 中位数 | 662.8 ms | 682.6 ms |
| 热运行中位数 | 1134.35 ms | 877.6 ms |

结果像素哈希：

- 第一张图：`b7b8b16fca83417705d69257f3a72b0e346f01c4eebf7ed6204f18beac5c5be1`
- 第二张图：`fe906487f9b3b0c742039ad752f465832675008459f7bea516efd89ea4bde832`

两图的 baseline、候选方案、冷／热运行均分别得到各自相同的哈希。这是这两个去字输入的像素一致性证据，不能替代完整 OCR 质量集和所有 GPU 的兼容性验证。

**为什么能同时更流畅、更快：trace 证据**

最终同组 trace：

- 对照：`reports/ui-jank-trace-1789570551542.json`
- 4 路重叠：`reports/ui-jank-trace-1789570564676.json`

| 事件 | 对照 | 4 路重叠 |
|---|---:|---:|
| 同步 CreateComputePipeline 次数 | 124 | 124 |
| 同步创建累计时间 | 1246.161 ms | 12.043 ms |
| 异步 CreateComputePipelineAsync 次数 | 0 | 109 |
| DXC 编译总次数 | 111 | 111 |
| 在 CrGpuMain 上的 DXC 编译 | 111 | 2 |
| 在 ThreadPoolForegroundWorker 上的 DXC 编译 | 0 | 109 |
| 最大 HandleDawnCommands | 125.476 ms | 56.088 ms |
| 这次首图总耗时 | 5011.4 ms | 3829.6 ms |

没有少做编译：DXC 累计墙钟时间反而是 1159.987 → 1305.353 ms。这些工作被移出 GPU 主线程，并与其他编译／模型加载重叠，所以关键路径缩短。不能把不同线程的累计时间当成端到端时间，也不能把嵌套 trace 事件相加。

这与 [WebGPU 管线创建规范](https://gpuweb.github.io/gpuweb/#pipeline-creation)描述一致：异步创建可在管线准备好后完成，避免把编译阻塞带入队列使用路径。当前 [ORT WebGPU 文档](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)中的 graph capture 与 IO binding 面向不同问题；本次收益不依赖打开 graph capture 或改变输出所在内存。

**建议的产品落点**

先实现一个可回退的“着色器源码缓存 + 4 路后台预编译”，无需延长模型 Session 常驻时间：

1. 正常推理时收集真正使用过的 WGSL、entry point、constants；异步存到当前扩展自己的 IndexedDB。只在首次生成时记录，避免每个 kernel 重复写盘。
2. 缓存至少绑定模型内容 hash、ORT／生成器版本、GPU adapter 及参与生成代码的 features/limits；升级或换设备不盲目使用旧描述。
3. 新 Worker 获得实际 GPUDevice 后开始预编译，同时继续模型创建。优先处理早期 detector、bubble 会使用的模板，再处理 OCR／inpaint；本次模板顺序来自真实执行顺序。
4. 模板缺失、旧缓存不兼容或预编译失败时继续原有路径。不要为覆盖所有可能的 OCR width/batch 组合一次编译大量猜测形状。
5. 以首图总耗时、preload 子阶段、GPU 主线程长任务、Worker 长帧、热路径及输出一致性共同验收。实际 Chrome 稳定版和其他 GPU 必须补测。

这是下一步工程方案，不是本次已经交付的生产缓存。首次安装完全没有历史模板时，仍需要首次收集；若一定要改善这一次，需要发行与模型／设备特征匹配的模板包，或者修改 ORT 的程序生成与异步编译调用链。当前基于两张图的模板不能直接当通用模板发布。

**复跑与工程状态**

```powershell
npm run build:extension:chromium

# 先收集默认输入的 shader 源码；不计入后续优化收益。
node benchmark/perf/src/run-cold-start-experiments.mjs --variants=capture

# 每个样本是新进程；同进程执行冷、热各一次；自动反转相邻轮次顺序。
node benchmark/perf/src/run-cold-start-experiments.mjs --variants=baseline,async4overlap --rounds=3
node benchmark/perf/src/run-cold-start-experiments.mjs --variants=baseline,async4overlap --trace
node benchmark/perf/src/run-cold-start-experiments.mjs --variants=baseline,async4overlap --rounds=2 "--image=benchmark/images/字体颜色 2.jpg"
```

实验 runner 仅临时改写构建产物 `apps/extension/dist-chromium/onnxWorker.js`，在 `finally` 中恢复。不要与扩展构建或另一个同类实验同时运行。原始日志和模板在 `.tmp/cold-start-experiments/`，报告／trace 在既有 reports 目录，紧凑汇总已保存到本报告同目录的 JSON。

有两次测试在推理开始前因悬停目标丢失报“未找到可翻译区域”，未将它们计为性能样本；后续将鼠标定位改为图片可见部分并显式派发移动事件。一次中途失败的 2 路预实验未混入三轮确认结果。诊断失败记录保留在本机日志中。

最终校验：benchmark TypeScript 检查、两个实验脚本语法检查、像素一致性断言通过；构建 Worker 已恢复，SHA-256 为 `d2032f27f3e64b9e095dd7a9d5ea9b9193bfbb29b0f7c9d27d2ebe9b093b0c9b`，与实验前一致。生产源码、模型、依赖和五分钟空闲释放策略均未改动。
