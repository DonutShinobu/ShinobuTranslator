# Firefox 157 首图冷处理原生剖析

本报告保留当时的实验状态。原始报告、profile 与实验脚本位于本机未提交的 `.tmp/`，普通仓库 clone 不包含这些材料，相关链接仅供保留该目录的本地复核。

已取得覆盖完整冷/热窗口的 Gecko 原生调用栈。主要冷开销集中在 **DXC 编译和 NVIDIA 驱动管线创建/编译**：`CanvasRenderer` 冷运行记录 **6.281 s 线程 CPU**，热运行 **0.108 s**。按采样端点近似分配，`nvgpucomp64.dll` 为 **2.834 s CPU**，`dxcompiler.dll` 为 **2.145 s CPU**，合计约占冷运行该线程 CPU 的 **79%**。两类编译栈在热运行中均未出现。

这不是单纯的 JS 流程变慢，也不能再把全部原生准备成本归为 DXC。Firefox 的管线创建路径在同一 `CanvasRenderer` 线程上同步执行；提前提交多个 JS async promise，没有消除这些原生工作。Naga 转译本身只有少量采样，但它生成的 HLSL 仍会影响后续编译成本。

## 环境与计量范围

- Windows，原生 Firefox **157.0**，BuildID `20260924084938`，SourceStamp `8eb25af4acf031ab1e06abf1a912275083c820ed`；实际栈走 wgpu DX12、DXC、NVIDIA 驱动。
- 正式小矩阵分块构建，原图 `typeset-debug-log-2026-05-23T06-03-39-877Z.png`，2921×4096，original 模式。
- 每组使用独立浏览器 profile，首图为冷、同进程第二图为热。未清除 OS/GPU 驱动缓存。“冷”指首图处理，不是 Firefox 程序启动时间。
- 只在临时扩展副本增加 UserTiming；未启用额外 GPU tensor 读回、结果验证 dispatch 或 shader 预热。正式 Worker SHA 保持 `9725d653441cb3b994a9230bec594cae309b210be1b73e05ced20460e6e389b2`。
- 三组共 **6 次处理全部完成**，四模型实际 provider 均为 WebGPU，PNG SHA 和浏览器解码的 RGBA SHA 均与参考完全一致。PNG SHA `2cd34e7459b9079937bf886cc0e5d2b70e189a9d7c72861b3b2883d4dc02d239`，RGBA SHA `44f04d1ecaf425de0cddea7f329f6f9a13c0bd2df6ea9c061a645ccad888c0eb`。

## 采集完整性

| 采集 | 冷/热显示耗时 | 冷 Canvas CPU 覆盖 | 用途 |
|---|---:|---:|---|
| baseline-01，全线程，16M entries | 10.487 / 3.073 s | 57.68% | 栈、Timer 与 IPC 旁证 |
| targeted-01，仍采全部线程 CPU，16M entries | 11.485 / 3.117 s | 88.93% | 调用链复核 |
| **lean-01，限定线程，32M entries** | **9.959 / 2.791 s** | **100%** | **主要 CPU 与模块归因** |

前两组环形缓冲淘汰了冷运行开头约 4.438 / 1.272 s；线程注册早于冷窗口，缺口并非线程尚未启动或 CPU 数据为空。没有用其部分 CPU 总量冒充完整冷开销。

最终采集 features 为 `js,stackwalk,ipcmessages,processcpu`，过滤 `CanvasRenderer,DOM Worker,GeckoMain,IPC I/O Child`，2 ms。保存活体多进程 profile 后正常关闭浏览器，另保留 shutdown 备份。主要文件包含 17 个进程、78 条被采样线程；GPU Canvas 的首保留样本早于冷窗口，冷热 CPU 覆盖均为 100%，缺失 CPU interval 为 0。

冷/热窗口用 Gecko 自身 `Shinobu complete run` UserTiming 对齐，root clock 分别为 `4260.082–14219.082 ms`、`15952.189–18743.189 ms`。子进程按 `meta.startTime` 偏移校准；没有仅依赖墙钟近似。

**采样器会影响速度。上述 9.959 s 不是新的正常冷启动基准。** 正常计时仍见[小分块验证报告](firefox-workgroup-workaround-2026-10-07.md)及[预热验证报告](firefox-shader-warmup-validation-2026-10-08.md)。本次目的为原生归因，没有同日 Chrome 原生 A/B，不能把 Chrome 与 Firefox 的总差值逐项定量分配。

## 冷开销落在哪

| CanvasRenderer 指标 | 冷 | 热 |
|---|---:|---:|
| 实际线程 CPU 累计 | 6280.645 ms | 107.873 ms |
| 保留窗口内栈样本 | 4698 | 1395 |
| 最近原生模块为 NVIDIA 编译模块 | 1514（32.23%） | 0 |
| 最近原生模块为 DXC | 1150（24.48%） | 0 |
| 栈内含 Naga 函数 | 25 | 0 |

下表将每个 `threadCPUDelta` 归到该间隔末尾采样的最近原生模块。**这是模块 CPU 的采样估计，不是函数入口/出口精确计时，也不是 GPU 执行时间。** 两次采样间调用栈可能改变；未知叶帧可能露出父模块。

| 最近原生模块 | 冷 CPU 估计 | 热 CPU 估计 |
|---|---:|---:|
| `nvgpucomp64.dll` | 2834.303 ms | 0 |
| `dxcompiler.dll` | 2145.488 ms | 0 |
| `nvwgf2umx.dll` | 233.992 ms | 16.642 ms |
| `ntdll.dll` | 578.808 ms | 35.564 ms |
| 其余/未映射 | 488.054 ms | 55.667 ms |

实际线程 CPU 按 ns 单位累计，首个未知区间忽略，边界按重叠比例裁剪。没有用“样本数×2 ms”当 CPU 时间，也没有把睡眠栈占比当计算占比。模块样本占比与 CPU 占比是不同量；inclusive 栈计数会重叠，不能相加。

以下链均来自本次实际冷样本，按调用方向简写：

```text
WebGPUParent::RecvMessages
  → wgpu_bindings::server::process_message
  → wgpu_core::Device::create_compute_pipeline
  → wgpu_hal::dx12::Device::create_compute_pipeline
      ├─ Device::load_shader → dxcompiler.dll
      └─ CDevice::CreateComputePipelineState → CreateShader
          → nvwgf2umx.dll → nvgpucomp64.dll
```

另外观测到 `Device::load_shader → naga::back::hlsl::Writer::write_global/write_type`。这次 Naga writer 没有成为直接 CPU 主热点；不能据此排除其 HLSL 生成方式对 DXC/驱动成本的影响。

Firefox 157 的 async 创建分支仍直接调用 `device_create_compute_pipeline_or_error`，完成后回传结果；该分支未转交独立管线编译线程池。[固定版本源码](https://hg.mozilla.org/releases/mozilla-release/file/8eb25af4acf031ab1e06abf1a912275083c820ed/gfx/wgpu_bindings/src/server.rs#l2425)。原生栈确认创建工作确实在 `CanvasRenderer` 上发生。驱动内部可以另起线程，本次没有把未采到的驱动线程称为“不存在”。

Chrome 的 WebGPU 使用 Dawn，WGSL 转译器为 Tint；相似的 JS/ORT 调用不保证相同的后端生成结果和原生成本。[Dawn 官方说明](https://dawn.googlesource.com/dawn/+/refs/heads/main/README.md)。这次只直接测量了 Firefox，不声称已证明 Chrome 的某个编译阶段恰好快多少倍。

## 模型阶段与 100 ms 读回节奏

主要采集的应用阶段耗时如下，均包含 profiler 影响。去字与其它阶段存在并行，不能将所有 UI 阶段简单相加。

| 阶段 | 冷 | 热 |
|---|---:|---:|
| 文本检测 | 2078 ms | 277 ms |
| 气泡检测 | 1608 ms | 241 ms |
| OCR | 3430 ms | 808 ms |
| 去字 | 997 ms | 343 ms |
| 生成结果图片 | 211 ms | 200 ms |

另一条剩余开销是完成通知/读回等待：

- 全线程采集的热窗口出现 30 次面向 CanvasRenderer 的 100 ms timer 投递，间隔中位数 **100.346 ms**，29 个间隔中 28 个在 99–102 ms。
- 完整 lean 原生栈实际出现 `BaseTimer<WebGPUParent>::TimerTask::Run → wgpu_server_poll_all_devices → Device::maintain`。固定源码的 `POLL_TIME_MS=100` 与此吻合。[Firefox 157 设备维护源码](https://hg.mozilla.org/releases/mozilla-release/file/8eb25af4acf031ab1e06abf1a912275083c820ed/dom/webgpu/ipc/WebGPUParent.cpp#l37)。
- 热 OCR 的 8 次 output-readback 为 **57、91、95、94、95、94、93、93 ms**，完成点呈约 100 ms 间隔；若干相邻 `PWebGPU::ServerMessage` 间隔也在 99–102 ms。热窗口读回终点与最近回复相差约 **−0.22 至 1.31 ms**，没有显示出另一个约 100 ms 的 IPC 尾部延迟。小负值来自 UserTiming 整毫秒量化及“最近回复”的相关匹配。
- 还观测到 `QueueSubmit → Queue::submit_inner → Device::maintain`，timer 并非唯一维护触发。

这支持“完成唤醒/维护节奏值得优化”，但**没有 GPU fence 的实际完成时刻，不能证明这约 90 ms 全部是 GPU 已完成后等待下一次 poll**。output-readback 还包含提交、reduction、copy 和此前工作完成等待；通用 ServerMessage 也没有逐条解码为 buffer-map 回复。lean 的 Timer 线程未采样，其投递节奏用第一组补充，两个 capture 的事件没有互相拼成同一条因果时间线。

## 可据此决定的优化方向

1. 保留已验证的小矩阵分块。原生证据支持继续减少昂贵 shader/管线的生成和编译工作，或减少不同管线数量；不能仅因 Naga writer 的 CPU 低就恢复大共享数组。
2. 不将提高 shader warmup JS 并发作为主要提速方案。它主要调整编译发生时机，同一原生创建路径上的 DXC/驱动工作仍然存在；此前等待全部预编译的试验也未缩短用户总等待。
3. 读回优化需要单独验证 GPU 完成→维护→map 回调的时间，或做明确的维护唤醒 A/B，再决定扩展端绕过方式。当前不据相关节奏直接加入额外空提交、轮询或设备同步。

## 原始材料与复核

- [完整原生 profile](../../.tmp/firefox-native-profile-20261008/lean-01-profile.json)；[对应冷热结果](../../.tmp/firefox-native-profile-20261008/lean-01.json)。原生 JSON 可在 Firefox Profiler 中从本地导入。
- [原生栈、CPU 与模块分析](../../.tmp/firefox-native-profile-20261008/lean-01-profile-analysis.json)，含 `nativeBoundaryExamples`；[精简汇总及六次结果核对](../../.tmp/firefox-native-profile-20261008/native-summary.json)。
- [读回与维护节奏分析](../../.tmp/firefox-native-profile-20261008/lean-01-poll-cadence.json)；[全线程 Timer 旁证](../../.tmp/firefox-native-profile-20261008/baseline-01-poll-cadence.json)。
- [采集控制](../../.tmp/firefox-native-profile-20261008/profiling-controller.mjs)、[离线分析与说明](../../.tmp/firefox-native-profile-20261008/README.md)。控制器、时钟、CPU 裁剪、模块分配守恒、符号 unknown 保留及汇总断言均通过可运行检查。

符号查询使用 Mozilla 官方 v5 服务，精确匹配 `debugName+breakpadId`，只发送模块标识和独立地址偏移；没有上传原始 profile、完整栈、URL、时间戳或进程身份。[官方接口说明](https://mozilla-eliot.readthedocs.io/en/latest/symbolication.html)。完整 lean 的 14470 个地址中，7380 个有实际函数名，4240 个为 unknown 占位，2850 个无函数名。xul 与 D3D12 公共调用边界可读；DXC 内部符号缺失，NVIDIA 编译模块也有大量未知内部帧，因此不声称已定位某个 LLVM/驱动优化 pass。

第一组曾因数字 `meta.processType=5` 被临时校验器误判为无 GPU；保存的原始文件实际完整包含 GPU 进程。校验器已修复、文件已重新验证，报告保留 `captureValidationRecovery.originalError` 及恢复原因。三组的原始文件和 shutdown 备份均保留，正式扩展及生产运行时未因本次剖析改变。
