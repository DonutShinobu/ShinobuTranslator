# Firefox 157：绕过昂贵 workgroup 清零代码的验证

**可以在扩展侧彻底移除已知的“大共享数组整块清零”触发代码，且已有可运行原型。** 做法是在严格匹配的 ORT 矩阵 kernel 中移除共享数组和搬运循环，直接从原始输入 buffer 读取所需元素。它保留原始矩阵分块和乘加顺序，而不是继续缩小分块。

2026-10-08 基准四次、候选三次隔离浏览器实测：当时的小分块版本冷运行 **8.540–10.549 s**，直接读取候选 **6.187–6.417 s**，后者中位数 **6.400 s**；热运行候选为 **2.484–2.641 s**，目前没有明显退化。三张图片、四次冷／热质量检查全部精确通过。当日原型保存在临时扩展副本，尚未修改正式构建策略；随后采用情况见下一节。

这条路径仍使用 DX12 / DXC：消除的是病态初始化的输入形状，不能称为完全关闭 DXC，也不能把 Firefox 剩余时间全部归因于该缺陷。完全绕过 DXC 的 Vulkan 路径在本机被另一处设备创建错误阻断。

## 2026-10-09 正式采用

按用户选择，正式构建采用上述“原始分块、移除共享数组、直接读取输入”方案，停止推进后续替代实验。

- [构建接入](D:/code/ShinobuTranslator/scripts/build-jsep.mjs)在 ORT JSEP ProgramManager 拼好完整 WGSL 后、创建 shader module 前调用[严格匹配变换](D:/code/ShinobuTranslator/scripts/firefox-matmul.mjs)。仅 Windows Firefox 启用；其他平台／浏览器保留原码。匹配失败也保留原码。移除了此前的三处小分块生成器重写，使用 ORT 原始几何；保持 ORT 1.27.0 和 shader 创建锚点校验。
- 沿用已验证原型的转换函数，并补充拒绝可变 batch／globalRowStart 和额外 kStart 自增的保护；26 个 shader（4 类原始几何和 22 个实际捕获样本）的生成结果与已测原型逐字节一致。[核对结果](D:/code/ShinobuTranslator/.tmp/firefox-direct-integration-20261009/prepared-equivalence.json)。
- 四类原始 8×8 fixture 覆盖 vec4、vec3、普通 scalar、sequential scalar，inner 分别为 32／24／32／8；后三类由未修改的本地 ORT 生成器生成。新旧两组独立坐标 oracle 共 **3,022,848** 项比较通过，其中 **918,528** 项为负／越界索引，覆盖后续 K tile、非零工作组和 batchIndices。[原始几何核验](D:/code/ShinobuTranslator/.tmp/firefox-direct-integration-20261009/original-geometry-verification.json)、[23 样本 oracle](D:/code/ShinobuTranslator/.tmp/firefox-direct-integration-20261009/direct-cpu-checks.json)。
- [11 项回归测试](D:/code/ShinobuTranslator/tests/workers/firefoxMatmul.test.ts)、测试类型检查、扩展类型检查、两种浏览器构建和 release boundaries 通过；39 个共享产物通过严格 parity。Firefox lint 为 0 errors，6 条既有审计警告不变，仅更新 Worker 指纹；隔离 profile 加载检查通过。
- 正式 Worker 的诊断副本另做主图冷／热两次检查：detector、bubble、OCR、inpaint 均为 WebGPU；检测输入及三个输出张量、完整 OCR、文本顺序、完整记录、PNG 和离线解码 RGBA 均与参考精确一致，未记录到错误。[质量复测](D:/code/ShinobuTranslator/.tmp/firefox-direct-integration-20261009/direct-quality-summary.json)。为了让最小化窗口中的诊断可完成，终点为结果解码，不等待 animation frame；诊断开启额外 readback／hash，因此不将该轮耗时作为性能数据。

正式产物位于 [dist-firefox](D:/code/ShinobuTranslator/apps/extension/dist-firefox)，Worker SHA-256 为 `c2afbdbb2999255c503215d395c22cb017053e64fd63ef64a3ef92198035ad49`。没有采用后续 Vulkan、row1、替换 ORT 或 OCR 调度实验。此前三张图片的原型验证仍有效；本次正式接入只复测主图冷／热，未重做整组正常计时，也未增加其他 GPU 覆盖。

## 环境和范围

- Windows、NVIDIA、原生 Firefox **157.0**，BuildID `20260924084938`，源码 `8eb25af4acf031ab1e06abf1a912275083c820ed`，内置 wgpu/Naga `9b095f553c0701329b92a347f5ab02ec02e133fc`。
- 主图 `typeset-debug-log-2026-05-23T06-03-39-877Z.png`，2921×4096，original 模式。计时终点为结果图解码、显示；“冷”是新浏览器 profile 中首次处理图片，不是 Firefox 程序启动时间。未清除 OS／驱动缓存。
- 基准使用当前 Firefox 小分块 Worker；候选以原始 8×8 workgroup／通常 inner=32 的 Worker 为底，仅在临时 Worker 中拦截匹配的 shader 生成。其他资源来自同一当前构建。两份 Worker 的原始主体均以 SHA 和字节后缀校验。
- 正常计时、额外张量／像素质量诊断、原生 profiler 分开运行。后两者的显示耗时不用于性能结论。GPU 实验串行；下表选用的计时均未与大 CPU oracle 重叠。
- 没有修改用户 Firefox 配置，没有替换 DLL、关闭沙箱或关闭 WebGPU 验证。

## 为什么手工初始化或关闭优化不是现成解法

Firefox 固定版本的 compute pipeline 创建强制开启 `zero_initialize_workgroup_memory`。Naga HLSL writer 对入口使用的 workgroup 全局变量生成默认初始化，不分析 WGSL 是否已经完整覆盖数组。因此手写分布式清零不能关闭这段注入；二维改一维、改 scalar 数组、结构体包装也仍会得到 aggregate 初始化。[固定 writer](https://github.com/gfx-rs/wgpu/blob/9b095f553c0701329b92a347f5ab02ec02e133fc/naga/src/back/hlsl/writer.rs#L1997)、[同步创建选项](https://github.com/gfx-rs/wgpu/blob/9b095f553c0701329b92a347f5ab02ec02e133fc/wgpu-core-remote/src/global/device.rs#L941)。

`WGPU_DEBUG=1` 的环境入口在 release Firefox 也存在，可使本机 NVIDIA DX12 路径传入 DXC `-Zi -Od`。但 `-Od` 仍执行必需的 HLSL lowering、SROA、mem2reg 和 DXIL 合法化，不会跳过 DXC，也不会跳过 NVIDIA 驱动编译。它还是浏览器进程级诊断选项，扩展不能逐 shader 设置。[Firefox flags](https://hg.mozilla.org/releases/mozilla-release/file/8eb25af4acf031ab1e06abf1a912275083c820ed/gfx/wgpu_bindings/src/server.rs#l235)、[DXC 调用条件](https://github.com/gfx-rs/wgpu/blob/9b095f553c0701329b92a347f5ab02ec02e133fc/wgpu-hal/src/dx12/shader_compilation.rs#L388)、[DXC 必需 passes 示例](https://github.com/microsoft/DirectXShaderCompiler/blob/75fba61961026d7c763ef41f600b60d7644e237e/lib/Transforms/IPO/PassManagerBuilder.cpp#L339)。DXC 源码链接解释机制，未据此认定本机 DLL 的具体源码版本。

Firefox 还硬编码 `DynamicDxc`，没有应用 `WGPU_DX12_COMPILER` 的 backend 环境覆盖。因此 `WGPU_DX12_COMPILER=fxc` 不能在这版 Firefox 切换编译器；移走 DLL 只会造成加载失败。[固定选择](https://hg.mozilla.org/releases/mozilla-release/file/8eb25af4acf031ab1e06abf1a912275083c820ed/gfx/wgpu_bindings/src/server.rs#l243)。

## 单 shader 初筛

使用实际 ORT 原始 32×8 vec4 共享数组 shader；保留原始 workgroup 和 tile。每个候选实际 dispatch 一个 32×32×32 矩阵乘法，1024 个输出与 CPU 参考逐个比较，全部最大误差为 0、没有记录到 GPU 验证错误。

| 变换 | 原生 async pipeline 完成耗时 |
| --- | ---: |
| 原始二维共享数组 | 1600 ms |
| 扁平 vec4 数组 | 1450 ms |
| 扁平 scalar 数组 | 1258 ms |
| 拆为独立 vec4 变量、switch 索引 | 7126 ms |
| 原始 shader，`WGPU_DEBUG=1` | 1009 ms |
| 删除共享数组、直接读输入 | **326 ms** |

这是单次方向性初筛，不是多轮中位数；原生 pipeline 完成包含验证、Naga、DXC 与驱动创建，**不是 DXC 单独耗时**。独立变量确实改变了清零形状，但动态索引 switch 使代码膨胀，反而更慢。扁平化仍保留大 aggregate。直接读取则连初始化对应的共享变量都不存在。

原始报告：[常规候选](D:/code/ShinobuTranslator/.tmp/firefox-zero-init-bypass-20261008/shaders-optimized-screen.json)、[`-Od` 候选](D:/code/ShinobuTranslator/.tmp/firefox-zero-init-bypass-20261008/shaders-debug-screen.json)、[直接读取](D:/code/ShinobuTranslator/.tmp/firefox-zero-init-bypass-20261008/shaders-direct-screen.json)。

## 完整流程正常计时

基准四个、候选三个独立 profile，每个 profile 同进程处理两次。大部分交替执行，但并非严格随机配对试验；行号是各构建的样本序号。所有 14 次处理的 detector、bubble、OCR、inpaint 实际 provider 均为 WebGPU；最终 PNG 和浏览器解码 RGBA 均与参考完全一致。

| 组别 | 当前小分块，冷 / 热 | 原始分块直接读取，冷 / 热 |
| --- | ---: | ---: |
| 1 | 8.619 / 2.456 s | 6.417 / 2.601 s |
| 2 | 8.540 / 2.688 s | 6.400 / 2.641 s |
| 3 | 10.549 / 4.017 s | 6.187 / 2.484 s |
| 4（补采） | 9.385 / 3.407 s | — |
| **中位数** | **9.002 / 3.0475 s** | **6.400 / 2.601 s** |

baseline-03 明显较慢，原样保留。中位数冷时间减少 28.90%，但样本少、基准波动较大，不能把这个百分比视为跨机器保证。热运行也不声称获得确定提升。冷运行三个候选均快于四个基准，且下面的原生 CPU 结果提供独立旁证。

其它完整流程初筛：`WGPU_DEBUG=1` 为 **9.133 / 2.677 s**，输出一致，但未观察到整体等待改善；没有据单轮断言普遍变慢。小分块直接读取为 7.210 / 3.384 s，但该轮与 CPU oracle 的一部分工作重叠，**排除出正式性能比较**。

补采 baseline-04 的起因是核对早期基准是否也有 CPU 重叠。随后从执行日志确认 oracle 实际为 `15:14:46.210Z–15:15:13.839Z`，而 baseline-01 在 `15:13:58.348Z` 已结束，早于 oracle 约 48 s，故保留 baseline-01 和补采两者。此前进度中的 8.619 → 6.400 s 为前三次基准的中位数比较；本报告使用全部有效样本。

[汇总及断言结果](D:/code/ShinobuTranslator/.tmp/firefox-zero-init-bypass-20261008/summary.json)。基准 SHA `9725d653441cb3b994a9230bec594cae309b210be1b73e05ced20460e6e389b2`；候选 SHA `b3edd7548733fcaa0cb18e813d565492e8aa565ddf477989b7de5d1430a5081f`。候选主体 SHA `62593352fb5b7e01c7b7902725b0cbeb28bba66260f09874ec619fc84d69ce29`。

## 原生剖析复核

对直接读取候选另采一次完整 Gecko 原生 profile，配置与[此前完整基准采集](D:/code/ShinobuTranslator/benchmark/perf/firefox-native-profile-2026-10-08.md)相同：2 ms，`js,stackwalk,ipcmessages,processcpu`，32M entries、限定相关线程。17 个进程、78 条线程，冷／热 CanvasRenderer CPU 区间覆盖均为 100%，按 Gecko `Shinobu complete run` UserTiming 对齐。

| CanvasRenderer CPU | 此前小分块基准 | 直接读取候选 |
| --- | ---: | ---: |
| 冷线程 CPU 累计 | 6280.645 ms | **4064.400 ms** |
| 冷 DXC 模块 CPU 估计 | 2145.488 ms | **1017.524 ms** |
| 冷 NVIDIA 编译模块 CPU 估计 | 2834.303 ms | **1846.974 ms** |
| 热线程 CPU 累计 | 107.873 ms | 108.899 ms |

模块估计将 CPU delta 归到采样端点的最近原生 DLL，并非单个优化 pass 精确计时。前后各一份采集，也不是重复采样的统计结论。候选采样下显示耗时 8.423 / 2.863 s，仅用于对齐，不混入正常计时。

这支持“已减少实际编译 CPU 工作”，同时证明 DXC 与驱动编译仍有余量：删除病态零初始化不能消除其它 shader 的编译、驱动 pipeline 创建或读回等待。候选热窗口没有 DXC／NVIDIA 编译模块样本。

[完整候选 profile](D:/code/ShinobuTranslator/.tmp/firefox-zero-init-bypass-20261008/direct-native-profile.json)、[冷热结果](D:/code/ShinobuTranslator/.tmp/firefox-zero-init-bypass-20261008/direct-native.json)、[分析](D:/code/ShinobuTranslator/.tmp/firefox-zero-init-bypass-20261008/direct-native-analysis.json)。本次没有新增上传调用栈或符号化请求。

## 质量与适用条件

质量诊断使用主图的冷／热各一次、原始问题 JPG 3071×4096 一次、`translated1.png` 1487×2048 一次。与保存的 Firefox 157 参考逐项对照：检测输入和三个完整输出张量的维度、字节数、SHA，完整 OCR、文本顺序、全部结果记录，以及保存 PNG 和 sharp 独立解码 RGBA，**全部精确一致**。仅移除随机 ID 和耗时字段，不使用数值容差。[质量汇总](D:/code/ShinobuTranslator/.tmp/firefox-zero-init-bypass-20261008/direct-quality-summary.json)。

三个场景分别记录 **28 / 35 / 25 次**矩阵 shader 转换，全部成功，转换后的 `var<workgroup>` 数量均为零。此处是调用次数，不冒称全局唯一 shader 数。

纯 CPU 检查覆盖原始 shader 和 22 个捕获 shader，1,843,200 次实际加载坐标比较，其中 597,504 次涉及负／越界 tile 索引；保留原来的边界限制、乘加顺序、acc、绑定和 batch 坐标。prepared Worker 的函数与后来增加回退保护的源函数对这 23 个输入的生成结果逐字节相同，没有重生成或偷偷替换已测 Worker。[CPU 检查](D:/code/ShinobuTranslator/.tmp/firefox-zero-init-bypass-20261008/direct-cpu-checks.json)、[字节等价核对](D:/code/ShinobuTranslator/.tmp/firefox-zero-init-bypass-20261008/direct-prepared-equivalence.json)。

原型只匹配固定 ORT 的非转置矩阵生成形状；其它 shader 回退原样。输入需要只读且与输出无别名。直接读取增加重复 storage 读取，未来大矩阵、不同 GPU、其它模型可能出现执行退化；本次未覆盖这些情况。CPU 坐标检查不能代替全模型 GPU 质量验证。

## 完全绕过 DXC 的 Vulkan 路径

Firefox 的 `dom.webgpu.wgpu-backend="vulkan"` 可以选择 Naga → SPIR-V → Vulkan 驱动的路径，架构上不经过 DXC。[后端选择](https://hg.mozilla.org/releases/mozilla-release/file/8eb25af4acf031ab1e06abf1a912275083c820ed/gfx/wgpu_bindings/src/server.rs#l217)、[SPIR-V 路径](https://github.com/gfx-rs/wgpu/blob/9b095f553c0701329b92a347f5ab02ec02e133fc/wgpu-hal/src/vulkan/device.rs#L770)。

本机隔离 probe 的 `requestAdapter()` 成功，但 `requestDevice()` 失败：`OperationError: Not enough memory left`。原生日志显示 **208 字节**分配被预算 guard 拒绝，heap 2 已用 224395264 字节、报告预算 **0**。Firefox 写死创建／丢失阈值 95%／99%，两处判断在零预算下都会拒绝或判丢失，没有现成 pref、环境变量或网页参数覆盖。[预算 guard](https://github.com/gfx-rs/wgpu/blob/9b095f553c0701329b92a347f5ab02ec02e133fc/wgpu-hal/src/vulkan/device.rs#L956)、[丢失 guard](https://github.com/gfx-rs/wgpu/blob/9b095f553c0701329b92a347f5ab02ec02e133fc/wgpu-hal/src/vulkan/device.rs#L2995)、[Firefox 阈值](https://hg.mozilla.org/releases/mozilla-release/file/8eb25af4acf031ab1e06abf1a912275083c820ed/gfx/wgpu_bindings/src/server.rs#l264)。

因此 Vulkan 完整流程的 49.844 / 49.558 s 实际四模型全部回退 WASM，**不是 Vulkan 性能样本，也没有通过 WebGPU 质量比较**。没有把它当成“Vulkan 编译更慢”。Vulkan 规范要求有效 heap 的预算非零；异常来自驱动、沙箱还是查询链，尚未定位。[规范](https://docs.vulkan.org/refpages/latest/refpages/source/VkPhysicalDeviceMemoryBudgetPropertiesEXT.html)、[本机原始 probe](D:/code/ShinobuTranslator/.tmp/firefox-zero-init-bypass-20261008/adapter-vulkan.json)。

## 当前结论和复现材料

扩展端可继续推进**原始分块＋直接输入读取**方案；本机已证明可以消除已知大数组清零触发代码，正常冷等待稳定在 6.2–6.4 s。当前仍是隔离研究原型，尚未正式接入生成器或推广至其它 GPU。

更适合保留共享内存性能的长线修复，是 Naga 在 HLSL 端生成分布式元素清零；截至本次查询，相关 [issue #7443](https://github.com/gfx-rs/wgpu/issues/7443) 与 [PR #10314](https://github.com/gfx-rs/wgpu/pull/10314)仍 open、后者未合并。该修复保持合法零初始化，不需要扩展牺牲共享缓存，也不会关闭其它 DXC 优化。

- [直接读取变换源码](D:/code/ShinobuTranslator/.tmp/firefox-zero-init-bypass-20261008/direct-candidates.mjs)、[已测候选元数据](D:/code/ShinobuTranslator/.tmp/firefox-zero-init-bypass-20261008/direct-metadata.json)、[隔离计时驱动](D:/code/ShinobuTranslator/.tmp/firefox-zero-init-bypass-20261008/run-runtime.mjs)。
- [完整源码核对笔记](D:/code/ShinobuTranslator/.tmp/firefox-zero-init-bypass-20261008/source-notes.md)，包含 `-Od` 继承链、FXC 限制、Vulkan 预算和上游状态来源。
- 正式版本和已有小分块改动保持原状态；本次只新增本报告，实验代码和原始证据位于 `.tmp`。
