# Chromium 首次图片处理卡顿：测试、代码分析与解决方案

2026-09-16；基于提交 `a5af759` 的本机源码重新构建，生产代码未修改。

**结论与适用边界**

已复现首次本地图片处理时的浏览器渲染卡顿，并通过 trace 定位到：ONNX Runtime Web 在首次推理过程中创建 WebGPU 计算管线，Dawn 在 Chrome 的 `CrGpuMain` 线程执行 D3D12/DXC 着色器编译，一批命令连续占用该线程约 149 ms。页面与 Worker 的动画帧同时停顿，页面主线程却没有对应长任务。这是本次冷启动掉帧的明确来源。

不能把这个结论直接扩大成“已证实整个 Windows 卡死”：同时运行的独立浏览器进程未出现类似停顿，也未采集 Windows DWM/ETW 桌面帧数据。用户日常 Chrome 版本、配置、其他扩展与显示环境仍可能放大症状。

**测试条件与方法**

- Windows，本机 RTX 5070 Ti，NVIDIA 610.74，约 31.84 GiB 物理内存。
- Playwright 自带有界面 Chromium **145.0.7632.6**；不是用户日常 Chrome 配置。
- 安装的 `onnxruntime-web` 为 **1.27.0**。旧报告中的 1.24.1 结果不能当成本次结果。
- 使用当前扩展的真实路径：图片快捷操作 → background 准入 → offscreen PipelineHost → 模型 Worker。`erase` 模式仍执行检测、气泡、OCR、去字，排除了外部文本翻译网络等待。
- 输入为仓库已有 `benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png`。
- 每次命令使用独立临时 profile；同一命令的第二次运行刷新内容页面，但复用 offscreen/模型 Session。
- 这里的“冷”指新浏览器进程、新模型 Session，不代表清空了系统文件缓存或 NVIDIA 驱动缓存。未删除用户缓存。
- 对照浏览器使用另一个独立 Chromium 进程，不加载扩展，只测 rAF 与 16 ms 定时器。CPU 百分比为测量窗口内整机平均值，不能当成扩展独占 CPU，也不能排除瞬时尖峰。

已执行：

```powershell
npm run build:extension:chromium
npm run typecheck:benchmark
npx tsx benchmark/perf/src/run-browser-ui-jank-smoke.ts --runs=2 --witness --trace --max-worker-frame-ms=100
```

构建与类型检查通过。最后一条成功完成两次图片处理、写出报告及 trace，然后按预设预算退出 1：

```text
run=1 cold=true  totalMs=5730.6  worker.maxDeltaMs=137.5
run=2 cold=false totalMs=2569.1  worker.maxDeltaMs=37.5
Error: Frame gap exceeded budget (page=Infinity ms, worker=100 ms)
```

这是保留的性能回归检查，不表示问题已经修复。100 ms 是本次选定的诊断预算，不是浏览器规范阈值，也不能保证所有负载下完全无噪声。

**同一轮冷／热对照**

| 指标 | 首次 | 第二次 |
|---|---:|---:|
| 端到端处理 | 5730.6 ms | 2569.1 ms |
| 检测模型 preload | 790.8 ms | 1.8 ms |
| 检测阶段 | 925.9 ms | 253.9 ms |
| 气泡阶段 | 754.8 ms | 54.0 ms |
| OCR 阶段 | 972.0 ms | 411.1 ms |
| OCR 阶段页面最大帧间隔 | 149.9 ms | 6.5 ms |
| Worker 动画心跳最大间隔 | 137.5 ms | 37.5 ms |
| 整机平均 CPU 忙碌率 | 31.7% | 37.1% |
| 最低可用物理内存 | 10.93 GiB | 10.73 GiB |
| 独立浏览器最大帧间隔 | 6.5 ms | 6.7 ms |
| 独立浏览器定时器最大间隔 | 17.9 ms | 17.4 ms |

检测、气泡、OCR 两轮均没有内容页主线程长任务。第二次的全程页面最大间隔仍达 200 ms，说明存在与冷启动编译不同的页面级停顿；不能只用全程 max 把所有卡顿归到着色器编译。Worker 动画心跳也不是 ONNX Worker 的 CPU 执行计时，而是独立的渲染节奏探针。

最早针对原有 dist 的探索运行曾出现 11.87 s 总耗时、556.2 ms 页面间隔、549.9 ms Worker 间隔。后续重新构建后多次新进程首次运行约 5.45–6.44 s。由于未控制原构建版本与驱动缓存，不把这个差异作为修复收益。

一次中间测试还出现约 1000 ms 周期帧间隔，Worker 却正常，存在窗口遮挡／节流干扰；最终测试显式关闭测试窗口的相关节流并 bringToFront，不采用那组数据做冷／热结论。

**trace 的直接证据**

最终 trace：`reports/ui-jank-trace-1789569331610.json`。

| 事件 | 次数 | 累计墙钟时间 |
|---|---:|---:|
| DeviceBase::APICreateComputePipeline | 124 | 1430.701 ms |
| ShaderModuleD3D12::Compile | 126 | 1387.581 ms |
| CompileShaderDXC | 111 | 1331.036 ms |
| tint::hlsl::writer::Generate | 111 | 47.047 ms |

这些是嵌套事件，**不能相加**。线程元数据确认管线创建发生在 `CrGpuMain`。最长 `WebGPUDecoderImpl::HandleDawnCommands` 为 148.501 ms，其中嵌套 9 次管线创建，共 142.109 ms，约占 95.7%。这里测到的是 GPU 进程内的 CPU 编译工作，不是 GPU 芯片执行 kernel 的时间。

另一份 trace `reports/ui-jank-trace-1789569104539.json` 同样记录 124 次创建、1611.390 ms 总创建时间、1499.396 ms DXC 编译；最长 130.073 ms 命令中，9 次创建占 124.529 ms。两次 trace 对阻塞机制的指向一致。

最终原始报告：

- `reports/ui-jank-2026-09-16T14-35-24-386Z.json`
- `reports/ui-jank-2026-09-16T14-35-27-318Z.json`

原始大文件保留在本机的 reports 目录，受仓库既有忽略规则管理。

**代码路径如何造成这个现象**

1. `packages/image-pipeline/src/pipeline/orchestrator.ts:479` 先创建 detector Session，再执行检测。OCR 默认在检测完成后准备，与后续气泡阶段可能重叠；不是默认同时预热所有模型。`probeRuntime()` 默认主要创建 Session，并不代表所有输入形状已经完成首次推理编译。
2. `packages/model-runtime/src/workers/onnx-worker.ts:36` 在 Worker 内初始化 ORT；`:79` 已有串行推理队列，`:344` 的 `runInference()` 通过该队列调用 `session.run()`。模型 manifest 优先选择 WebGPU。
3. `node_modules/onnxruntime-web/lib/wasm/jsep/backend-webgpu.ts:633` 按程序和输入信息查找编译产物，未命中时调用 `programManager.build()`。
4. `node_modules/onnxruntime-web/lib/wasm/jsep/webgpu/program-manager.ts:111` 创建 shader module，`:115` 使用立即返回句柄的 `device.createComputePipeline()`。实际编译经浏览器 IPC 落到 Dawn/D3D12；把 JavaScript 放到 Worker 并不能把 Chrome GPU 主线程上的编译移走。
5. ORT 编译缓存键可以依赖输入类型和维度。`packages/image-pipeline/src/pipeline/ocr/paddleocrProvider.ts:649` 的宽度分桶与变化的 batch 数会引入不同形状。首次一次小输入 warmup 不保证后续所有形状都命中缓存。
6. `packages/model-runtime/src/runtime/modelRegistry.ts:148` 已有 Session 缓存和 pending 创建去重。`packages/image-pipeline/src/protocol/index.ts:31` 定义 5 分钟空闲释放；`apps/extension/src/offscreen/pipelineHost.ts:758` 会 dispose 模型运行时。它会让后续任务重建内存状态，但不等于浏览器／驱动磁盘缓存也被清空。

因此，“再次加 Worker”“新增全局推理队列”“缓存 ONNX 下载”均不能直接消除已经定位的 GPU 进程编译长任务。内存耗尽与无限并发也不是本次证据支持的主因。并发 Session 准备可能有附加开销，但未做单变量验证，不能认定为根因。

**网上调研与方案优先级**

| 方案 | 能解决什么 | 实施边界与验收 |
|---|---|---|
| 在 ORT WebGPU 路径支持异步管线准备、复用编译产物 | 最直接针对首次编译阻塞 | 优先做小范围原型／向 ORT 提供 trace。不是给调用者的 `session.run()` 加 await，也不能把返回句柄的 API 直接替换成返回 Promise 的 API。需要调整 ORT build/cache/调用链；以 GPU 长任务和 Worker 帧间隔改善、结果一致为验收。 |
| 减少重复冷启动，按用户需要延长模型保留窗口 | 减少同一使用时段再次建 Session、再次首次运行 | 基于现有 5 分钟释放策略做有限调整或显式“保留模型”选项，保留释放入口并测驻留内存。不能解决全新浏览器进程第一次处理。 |
| 限制 OCR 输入形状组合，验证固定 batch／少量宽度档位 | 减少新增 shape 触发的 shader 变体 | 先用现有 benchmark 开关实验；不仅固定宽度，还要处理 batch。padding 可能增加算力、显存和延迟，需比较 OCR 文本、区域数、冷／热耗时。未验证前不改变默认。 |
| 用户主动的分阶段 warmup | 将等待安排到正式处理前，改善可预期性 | 单靠 warmup 会把同一编译卡顿提前，不能视为根治；尤其不要在 Chrome 启动时自动同时预热全部模型。需搭配可中断的调度，并限制 shape 覆盖范围。 |
| 在用户实际 Chrome 及另一稳定浏览器版本复测 | 验证版本、Dawn、驱动和其他扩展的影响 | 当前实测仅代表 Chromium 145。使用隔离 profile 做对照，不直接升级用户环境或清除驱动缓存；不能承诺升级必然修复。 |

[WebGPU 规范的管线创建说明](https://gpuweb.github.io/gpuweb/#pipeline-creation)指出：立即创建 API 返回句柄时，实际管线创建未必完成，后续设备时间线可能停顿；异步创建 API 在管线可用后才完成，适合避免编译阻塞队列。它支持上面的技术方向，但不保证消除所有驱动或操作系统层面的争用。

[Chrome 136 的官方 D3D12 编译改进说明](https://developer.chrome.com/blog/new-in-webgpu-136#shader_compilation_time_improvements_on_d3d12)描述了 Tint 的 WGSL→HLSL 改进。本机 trace 中 Tint HLSL 生成只有约 47 ms，而 DXC 约 1331 ms，所以不能把“Tint 翻译最高快十倍”推导成项目冷启动也能快十倍。

[ORT WebGPU 文档](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)说明 graph capture 适用于静态形状且计算 kernel 全部在 WebGPU 的模型；IO binding 用于减少 CPU/GPU 数据往返。它们可优化热路径，但不是首次 DXC 编译阻塞的直接开关。[ORT 性能诊断文档](https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html)建议按模型、provider 与 profiling 分析；项目已在 Worker 中运行，不应重复添加 proxy Worker。

本次不建议默认改成 WASM、关闭硬件加速、盲目打开 graph capture 或直接改模型精度：这些会改变性能与质量边界，尚无本机 A/B 收益证据。

**后续验证标准与尚未闭合的部分**

优先实施一个异步编译原型，复用本次检查：同一张图比较至少数轮新进程与热运行，观察 `CrGpuMain` 的长命令数、Worker >100 ms 间隔、端到端耗时，并验证 OCR／输出一致。不要只用平均推理耗时验收。

若用户的日常环境仍然表现为鼠标、其他程序、桌面也同时卡顿，需要在同一次触发中录制 WPR/GPUView 的 CPU、GPU 调度、DWM、硬缺页等事件，并记录实际 Chrome 版本与加载的扩展版本。本次独立进程对照未复现这种范围的停顿；无法据此宣称已定位或修复 Windows 全局卡顿。

本次仅增强已有 smoke 脚本，增加冷／热重复、Dawn trace、独立浏览器对照、CPU／内存观察与可选帧预算。生产推理逻辑保持原状，报告中的方案均明确区分已测事实和待验证优化。
