# Firefox 首次 WebGPU shader / pipeline 编译慢于 Chromium 的原因（2026-08-03）

## 结论

本项目在 Windows 上的 Firefox 冷启动差距，与 Firefox WebGPU 上游当前仍未关闭的一条 wgpu/Naga 性能问题高度吻合：Firefox 使用 Naga 把 WGSL 转成 HLSL；对于卷积、矩阵乘等包含多维 `var<workgroup>` 数组的 compute shader，Naga 会生成大型 groupshared 数组整体赋零。DXC 会在这种 HLSL 上花数秒做 alias analysis。Chromium 使用 Dawn/Tint，生成的是循环清零，能避开该病态编译路径。

这解释的是冷启动中首次模型 `run()` 的主要差距。热路径中 Firefox 每次 GPU→CPU 回读约 80–112 ms 的固定等待是另一个独立问题，不能混为同一原因。

## 上游直接证据

- wgpu 的未关闭问题 [#7443](https://github.com/gfx-rs/wgpu/issues/7443) 专门跟踪 Windows DX12 shader 编译偶发极慢。Mozilla/wgpu 维护者引用的两个 Firefox profile 都把大段时间定位到 `dxcompiler.dll`，同时 Chrome 明显更快。
- 2026-04-11 的 [Conv2D 复现](https://github.com/gfx-rs/wgpu/issues/7443#issuecomment-4229283074) 报告 Chrome 约 20 ms。
- 随后的 [根因缩减](https://github.com/gfx-rs/wgpu/issues/7443#issuecomment-4229409644) 显示，Naga 生成类似 `inp = (float4[4][18][18])0` 的整体赋零，DXC alias analysis 在作者机器上约需 3 秒；Chrome 使用循环。去掉这段 Naga HLSL 后，编译时间与 Chrome 接近。
- Mozilla 的另一个 Windows 案例曾观察到 Firefox 在 `dxcompiler.dll` 内约 10 秒，而 Chrome 编译约 135 ms，并明确怀疑 Firefox 生成了低效 HLSL或调用 DXC 的方式不同：[Bug 1951219](https://bugzilla.mozilla.org/show_bug.cgi?id=1951219#c5)。另一个案例记录约 2 秒对 150 ms：[Bug 1941977](https://bugzilla.mozilla.org/show_bug.cgi?id=1941977#c0)。

## 本机最小复现

复现代码位于 `benchmark/perf/repros/naga-workgroup-zeroing/`。它把上游最小 WGSL、Naga 当前生成的 HLSL 形态、循环清零 HLSL 和无清零对照拆开测量。

### 独立 DXC：只隔离 HLSL 形态

使用 DXC `1.9.2602.17`、`cs_6_0`、`-O3`，每次启动独立 `dxc.exe` 进程：

| HLSL | 中位数 | 相对循环清零 |
|---|---:|---:|
| Naga 风格：`inp = (float4[4][18][18])0` | 2.409 s | 102.8× |
| 循环清零 | 0.023 s | 1.0× |
| 去掉注入清零 | 0.022 s | 0.9× |

这在本机直接复现了上游所说的“移除 Naga 整体清零后与 Chrome 约 20 ms 接近”。每种写法连续测五次，整体清零除首轮 2.612 秒外均稳定在 2.402–2.410 秒，因此不是一次性进程或文件缓存噪声。

另外两个对照：

- 将三维数组摊平成一维后，`-O3` 中位数仍为 1.658 秒；降低数组维度不是充分修复。
- 对原三维整体清零使用 `-Od` 后，中位数降到 0.066 秒，而循环清零为 0.022 秒。这证明主要成本位于 DXC 优化/alias analysis，但关闭优化不是扩展可控制的选项，也会牺牲生成 shader 的运行性能。

### 浏览器端：验证相同 WGSL 确实只在 Firefox 命中慢路径

在同一台 NVIDIA GPU 上，先创建一个空 compute pipeline 排除设备和驱动首次初始化，再创建上游最小 WGSL 的 pipeline：

| 浏览器 | 设备预热 | 目标 pipeline |
|---|---:|---:|
| 项目锁定 Playwright Chromium | 0.018 s | 0.005 s |
| 项目锁定 Playwright Firefox 146 | 0.870 s | 3.519 s |
| 正式版 Firefox 153（3 次） | 0.008–0.009 s | 9.153–9.440 s |

Chromium 的目标 pipeline 在毫秒量级，Firefox 在设备已预热后仍稳定需要数秒。正式版 Firefox 的结果说明这不是 Playwright Firefox 旧版本特例；不同 Firefox 构建之间的绝对值不能据此推断版本回退，因为其 DXC 构建、配置、缓存和 IPC 环境并未做严格配对。

浏览器端墙钟比独立 DXC 更长，包含 WGSL→Naga→HLSL、Firefox GPU 进程通信、DXC 和 D3D12 PSO 创建。独立 DXC A/B 则只证明其中可控的 HLSL 形态本身足以造成约 2.4 秒差距。因此准确归因是：**Naga 生成整体数组清零，触发 DXC 的病态 alias analysis；Firefox/wgpu 采用这条生成与编译路径，所以在 Firefox 中暴露。** 不能把 Firefox 端每一秒都归给 Naga 本身，也不能把根因泛化为 Firefox IPC。

当前 Firefox vendored wgpu/Naga 源码仍明确执行这条路径：`write_workgroup_variables_initialization()` 对 workgroup 变量调用 `write_default_init()`，数组最终写成类型转换后的整体零值；尚未改为 Tint 风格的并行循环。

## 为什么与本项目高度相关

本项目锁定的 ONNX Runtime Web 1.24.1 不是预先编译少量固定 pipeline，而是在首次执行具体 shape 时按算子生成 WGSL：

- ORT 的 [`ProgramManager`](https://github.com/microsoft/onnxruntime/blob/v1.24.1/js/web/lib/wasm/jsep/webgpu/program-manager.ts#L22-L33) 只用进程内 `Map` 保存 artifact；构建时调用同步的 [`createComputePipeline()`](https://github.com/microsoft/onnxruntime/blob/v1.24.1/js/web/lib/wasm/jsep/webgpu/program-manager.ts#L109-L122)。
- ORT Conv 会转到 MatMul/Conv2D MatMul 实现：[conv.ts](https://github.com/microsoft/onnxruntime/blob/v1.24.1/js/web/lib/wasm/jsep/webgpu/ops/conv.ts#L250-L337)。
- 该 MatMul shader 明确声明多维 workgroup 数组 `mm_Asub`、`mm_Bsub`：[matmul_packed_webgpu.ts](https://github.com/microsoft/onnxruntime/blob/v1.24.1/js/web/lib/wasm/jsep/webgpu/ops/3rd-party/matmul_packed_webgpu.ts#L118-L119)。这与上游 Conv2D 最小复现触发的 Naga 清零模式属于同一类结构。

因此 detector、bubble、OCR 和 inpaint 首次运行不是各编译一个 shader，而是首次遇到多个算子/shape 时创建多个 pipeline。只要其中若干 workgroup shader 各触发一次数秒级 DXC alias analysis，就会累积成本项目观察到的每模型数秒。

本机数据也支持这一归因：Firefox 冷启动约 19.45 秒，Chromium 约 4.56 秒；两端 GPU kernel timestamp 仍只有几十毫秒，而 Firefox 首次 `run()` 增加到数秒。耗时发生在编译/设备时间线等待，不是 GPU kernel 执行本身。

## 两个浏览器即使都用 DXC，结果仍会不同

两条路径不是同一编译栈：

| 层 | Chromium | Firefox |
|---|---|---|
| WebGPU 实现 | Dawn | wgpu-core / wgpu-hal |
| WGSL 前端与 HLSL 生成 | Tint | Naga |
| Windows shader 编译器 | DXC | DXC |
| D3D12 pipeline | Dawn D3D12 | wgpu-hal D3D12 |

Firefox 从 136 起已默认启用 DXC，[Bug 1940700](https://bugzilla.mozilla.org/show_bug.cgi?id=1940700) 已完成；Firefox 149 又把内置 DXC 更新到 1.9.2602，[Bug 2016234](https://bugzilla.mozilla.org/show_bug.cgi?id=2016234) 已完成。因此把当前 Firefox 153 的问题归因于仍在使用 FXC是不正确的。相同 DXC 接收到不同的 HLSL，编译复杂度可以相差几个数量级。

## 缓存差异会放大重复冷启动

Chromium/Dawn 还有更完整的浏览器级缓存链：

- Dawn 的 D3D12 compute pipeline 会读取缓存 blob，传给 `CachedPSO`；miss 后调用 `GetCachedBlob()` 并保存：[ComputePipelineD3D12.cpp](https://dawn.googlesource.com/dawn/+/refs/heads/chromium/6594/src/dawn/native/d3d12/ComputePipelineD3D12.cpp)。
- Chromium 的 [`DawnCachingInterface`](https://chromium.googlesource.com/chromium/src/+/HEAD/gpu/command_buffer/service/dawn_caching_interface.cc) 把 Dawn 缓存接到内存后端，并通过 callback 接到主进程持久缓存。
- Firefox 当前 vendored wgpu DX12 实现有 GPUDevice 生命周期内的 shader `Map`，但创建 compute PSO 时传入空 `CachedPSO`，且 `create_pipeline_cache()` 是空实现：[device.rs](https://github.com/gfx-rs/wgpu/blob/fd2fa777b259520e090790d9b5ce5296e4ce7bb7/wgpu-hal/src/dx12/device.rs#L2184-L2238)。

WebGPU 规范也明确预计浏览器为昂贵的 shader/pipeline 编译提供缓存，以改善再次访问的加载时间：[WebGPU User Agent State](https://gpuweb.github.io/gpuweb/#user-agent-state)。

这部分更适合解释“为什么 Firefox 新 Worker/GPUDevice 后又重新付费，以及为什么 Chromium 更容易复用结果”。它不能单独解释完全干净环境下单个新 shader 的首次编译差距；后者由 Naga HLSL 形态与 DXC alias analysis 的证据更直接。

## `mapAsync()` 为什么看起来像耗时点

ORT 1.24.1 使用立即式 `createComputePipeline()`。WebGPU 允许立即式 pipeline 的实际创建延迟到创建、首次 `setPipeline()`、encoder `finish()` 或首次 `submit()` 之间。最终输出的 `mapAsync()` 必须等此前队列工作完成，所以冷启动时它会把尚未完成的 pipeline 编译时间一起暴露出来。

这意味着：

- 冷启动中，`mapAsync()` 的数秒等待不等于 GPU→CPU copy 本身用了数秒；主要是在等此前的 shader/pipeline 准备完成。
- 热启动中，pipeline 已存在，Firefox 仍有约 80–112 ms/次的固定回读等待；这是单独的队列完成/IPC/调度问题。
- 改成 `createComputePipelineAsync()` 可以避免阻塞设备时间线并改善调度，但不会消除 Naga 生成的病态 HLSL，也不会从根本上把数秒编译变成毫秒。

相关规范说明见 [`createComputePipelineAsync()`](https://www.w3.org/TR/2026/CRD-webgpu-20260512/#dom-gpudevice-createcomputepipelineasync)：异步 API 在 promise resolve 时保证 pipeline 已可无额外延迟使用，并被推荐用于避免 pipeline 编译阻塞 queue timeline。

## 解决方案边界

按改动层级排序：

1. **正确且效果确定：修复 Naga HLSL workgroup 清零。** 将单线程整体数组赋零改成按 local invocation index 分摊的循环。本机最小复现从 2.409 秒降到 0.023 秒，且保留 WebGPU 要求的清零语义。该修复需要进入 Naga/wgpu 并由 Firefox 更新，WebExtension 无法替换浏览器内部的 WGSL→HLSL 编译器。
2. **浏览器侧临时诊断方案：DXC `-Od`。** 本机从 2.442 秒降到 0.066 秒，但 Firefox 没有向网页或扩展暴露该编译开关，未优化 DXIL 也可能降低模型热运行速度，不适合作为产品方案。
3. **项目侧可做但有明显取舍：Firefox 对特定冷启动重模型使用 WASM。** 它绕过 WebGPU shader 编译，却可能使热运行更慢；必须以完整模型的冷/热总时长实测后决定，不能从最小 shader 结果直接采用。
4. **项目侧不算根治：保持 GPUDevice/session 或预热。** 只能避免重复支付，不能缩短用户要求优先解决的第一次冷启动。

仅把 ORT 的多维 workgroup 数组摊平成一维不是有效的简单修复，本机仍需 1.658 秒。由应用在 WGSL 中自行提前清零也不能阻止 Firefox/Naga 为满足 WebGPU 安全语义再次注入默认清零。若不等待上游，只能深入改 ORT shader，使算子不再依赖大型 workgroup 数组或换用其他存储策略；这会影响热性能和维护成本，不属于低风险改动。

## 证据强度与下一步

可以确认：

1. 这是一类 Firefox/wgpu 已知且仍未关闭的 Windows DX12 编译性能问题，不是本扩展独有。
2. 上游已有 Conv2D shader 的 20 ms 对数秒复现，并定位到 Naga workgroup 清零 HLSL导致的 DXC alias analysis。
3. ORT 1.24.1 的 Conv/MatMul shader 正好使用多维 workgroup 数组，结构上直接命中该问题类别。
4. 本机首次 `run()` 墙钟数秒但 GPU kernel 只有毫秒级，与编译等待完全一致。

尚未逐 shader 证明的是：本项目四个模型具体有哪些生成 WGSL分别消耗了多少 DXC 时间。若要把“高度吻合”升级为逐 shader 的确定归因，下一步应在 Firefox 上导出 WGPU trace/生成的 WGSL，并在 Gecko Profiler 中按 `dxcompiler.dll`、Naga HLSL writer、`CreateComputePipelineState` 分段；不需要先改公共 pipeline 流程。
