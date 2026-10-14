# Firefox Vulkan 零预算与冷启动对照

本报告保留当时的实验状态。原始报告、profile 与实验脚本位于本机未提交的 `.tmp/`，普通仓库 clone 不包含这些材料，相关链接仅供保留该目录的本地复核。

2026-10-09，Windows 11 / NVIDIA RTX 5070 Ti / 驱动 610.88。实验自 10 月 8 日晚开始。

**结论：零预算的阻断可以绕过，但当前 Firefox 157 仍有独立的 Windows Vulkan 崩溃；隔离 Firefox 156.0.1 的同版本对照没有观察到 Vulkan 比移除共享数组更快。** 三组冷首次推理中位数分别为 7.088 s 与 7.001 s，差 1.24%，组间波动大于差值。继续采用 DX12 shader 绕过方向更合适。

本次没有修改正式构建、用户浏览器、驱动、注册表或全局环境。新增的 native layer 和实验脚本均留在 `.tmp/firefox-vulkan-budget-20261008/`。现有代码改动属于此前研究，本次未覆盖。

## 1. 零预算来自一个不可分配的小堆

独立 `vulkaninfo` 在 Firefox 之外复现同样结果；排除全部隐式 Vulkan layers 后，适配器和堆数据也不变。因此零预算不依赖 Firefox GPU 沙箱，也不是现有 overlay layer 才产生的现象。

| Vulkan heap | 大小 | 预算 | 查询使用量 | 主要 memory type |
| --- | ---: | ---: | ---: | --- |
| 0，主 device-local | 15.62 GiB | 14.87 GiB | 0 B | type 1，DEVICE_LOCAL |
| 1，系统内存 | 15.92 GiB | 15.17 GiB | 272 KiB | type 2，HOST_VISIBLE / HOST_COHERENT |
| 2，小型 CPU 可见 device-local | 214 MiB | **0 B** | **214 MiB** | type 4，DEVICE_LOCAL / HOST_VISIBLE / HOST_COHERENT |

heap 2 的 size/usage 都为 `224395264` B。原生 probe 显式使用 Vulkan 1.1，启用 `VK_EXT_memory_budget`，device 创建前、创建后和销毁后的查询一致；系统 `vulkaninfo` 使用的更高 API 版本也得到相同结果。

直接调用 `vkAllocateMemory` 得到：

| 请求大小 | type 4 / heap 2 | type 2 / heap 1 |
| --- | --- | --- |
| 208 B | `VK_ERROR_OUT_OF_DEVICE_MEMORY (-2)` | `VK_SUCCESS (0)` |
| 4096 B | `VK_ERROR_OUT_OF_DEVICE_MEMORY (-2)` | `VK_SUCCESS (0)` |

所以小堆在采样时确实不可分配，不能只称为“一个实际可用堆被预算误报为零”。但是系统内存路径可用，整块 GPU 也没有耗尽：同时间段 `nvidia-smi` 显示 framebuffer 空闲 10474 MiB，BAR1 总计 256 MiB、已用 227 MiB、空闲 29 MiB。

这些特征与小型 BAR 可见窗口压力吻合，但统计范围不同；**尚未确定小堆的具体占用者，也没有证明 Resizable BAR 关闭**。Vulkan 规范要求有效堆的 `heapBudget` 非零，当前查询不满足该要求；真实分配也失败，不能通过伪造大预算来假定该堆可用。[预算规范](https://docs.vulkan.org/refpages/latest/refpages/source/VkPhysicalDeviceMemoryBudgetPropertiesEXT.html)

原始证据：[默认查询](../../.tmp/firefox-vulkan-budget-20261008/vulkaninfo-default.txt)、[排除隐式层](../../.tmp/firefox-vulkan-budget-20261008/vulkaninfo-no-implicit.txt)、[type 4 分配](../../.tmp/firefox-vulkan-budget-20261008/native-budget-enabled-alloc.json)、[type 2 分配](../../.tmp/firefox-vulkan-budget-20261008/native-budget-system-alloc.json)、[NVIDIA 内存统计](../../.tmp/firefox-vulkan-budget-20261008/nvidia-memory.txt)。

## 2. wgpu 阻断了 allocator 本来可尝试的回退

Firefox 157 原生日志中的内部请求只有 208 B，`memory_type_bits=31` 允许本机五种 memory type。CpuToGpu 优先选择 DEVICE_LOCAL / HOST_VISIBLE / HOST_COHERENT，因此预算预测选中 type 4 / heap 2，然后用 `usage + requested_size < budget / 100 * threshold` 检查；预算为零使它在真实 allocator 尝试之前就返回 OOM。

gpu-allocator 可以在该类分配失败后尝试非 device-local 系统内存；wgpu 的预测没有模拟这次回退。上游 [wgpu #9745](https://github.com/gfx-rs/wgpu/issues/9745) 记录了这个机制缺口，与本机 type 4 失败、type 2 成功相符；该 issue 并没有确诊本机驱动为什么使小堆不可用。

另有 device-loss guard 遍历全部堆，用 `usage >= budget / 100 * threshold` 判断。只改变这次请求的首选 type 仍不充分，零预算小堆还能触发 device loss。Firefox 的阈值固定为 95% / 99%，未找到可关闭这两处检查的 Firefox pref 或通用 loader device-extension blacklist。

固定 wgpu revision：`9b095f553c0701329b92a347f5ab02ec02e133fc`。[预算查询和创建 guard](https://github.com/gfx-rs/wgpu/blob/9b095f553c0701329b92a347f5ab02ec02e133fc/wgpu-hal/src/vulkan/device.rs#L846)、[device-loss guard](https://github.com/gfx-rs/wgpu/blob/9b095f553c0701329b92a347f5ab02ec02e133fc/wgpu-hal/src/vulkan/device.rs#L2995)。

## 3. 临时绕过已完成真实计算与完整应用验证

本地 layer 只从 device-extension 枚举移除可选的 `VK_EXT_memory_budget`。wgpu 因而不启用它，预算查询返回 None，两处预测 guard 都跳过，实际 allocator/driver 的分配与错误处理继续执行。wgpu 已对 RADV 使用过同型 workaround，但 RADV 的具体 accounting bug 不能套用到本机 NVIDIA。[扩展选择](https://github.com/gfx-rs/wgpu/blob/9b095f553c0701329b92a347f5ab02ec02e133fc/wgpu-hal/src/vulkan/adapter.rs#L1360)、[RADV 先例](https://github.com/gfx-rs/wgpu/blob/9b095f553c0701329b92a347f5ab02ec02e133fc/wgpu-hal/src/vulkan/adapter.rs#L2000)

layer 不伪造预算，不拦截 buffer 分配、shader、命令、提交、mapping 或 fence。变量只传给测试子进程及其拥有的 Firefox 树，沙箱保留，未关闭 WebGPU 验证。CPU 自检覆盖枚举 count/fill/partial、错误传播、协商、转发和多 instance 清理。冻结 DLL SHA256：`122ecd15601478116dac7c3a3880facabf7411fd0629b31114b65477085ec5db`。[layer 源码与说明](../../.tmp/firefox-vulkan-budget-20261008/layer/README.md)

使用官方 Firefox 156.0.1 隔离副本验证，安装包 Authenticode 为 Valid / Mozilla Corporation；Build ID `20260921121718`，Hg revision `6f2c158dfc7e9693f880fad2510ceb51a158c069`。安装包仅解压，没有运行安装程序或替换用户浏览器。[来源与签名记录](../../.tmp/firefox-vulkan-budget-20261008/firefox-156-signature.json)

| 同一 Firefox 156.0.1 Vulkan probe | requestDevice | compute / readback |
| --- | --- | --- |
| 不隐藏预算扩展 | `OperationError: Not enough memory left` | 未执行 |
| 隐藏预算扩展 | 成功 | **读回 42，validationError=null** |

扩展数确实从 280 变为 279。四模型完整流程也成功，全部使用 WebGPU。layer 未记录每个 buffer 的 memory type，不能声称所有 buffer 都落在系统内存。[负对照](../../.tmp/firefox-vulkan-budget-20261008/adapter-156-unfiltered.json)、[成功 probe](../../.tmp/firefox-vulkan-budget-20261008/adapter-156-filtered.json)

## 4. Firefox 157 还有独立的后端断言回归

同一 layer 在 Firefox 157.0 解除预算阻断后，GPU 进程退出。crash metadata 明确写着 `MozCrashReason="D3D12 backend device on windows"`、ProcessType=`gpu`、GpuSandboxLevel=`2`。网页端 `AbortError: Buffer unmapped` 是后果，不能由它直接归因 driver/layer 崩溃。[probe](../../.tmp/firefox-vulkan-budget-20261008/adapter-filtered.json)、[crash metadata](../../.tmp/firefox-vulkan-budget-20261008/filtered-gpu-crash.extra)

成功创建设备后，Windows 回调无条件获取 D3D12 fence。Vulkan device 的 `as_hal::<Dx12>()` 返回 None，随后 `expect` 与 crash 原因完全对应。这个 hook 没有禁用 pref，compute-only 同样会触发。

156.0.1 的代码遇到非 DX12 后端会安全返回空 handle。回归由 2026-09-04 / Bug 2066780 的 wgpu 更新引入；本次核对的 main 固定快照 `23fd2ecbdb459f63606a188fdea2d4dbee05507c` 仍保留断言。[156 安全分支](https://github.com/mozilla-firefox/firefox/blob/19a90052d7869f7b194ff27d316520366ad1d592/gfx/wgpu_bindings/src/server.rs#L1072)、[回归 commit](https://github.com/mozilla-firefox/firefox/commit/81ee9d2ca84f07cf9ad3d90afa4e80f79e6e4c8f)、[main 断言](https://github.com/mozilla-firefox/firefox/blob/23fd2ecbdb459f63606a188fdea2d4dbee05507c/gfx/wgpu_bindings/src/server.rs#L1227)、[main 无条件 hook](https://github.com/mozilla-firefox/firefox/blob/23fd2ecbdb459f63606a188fdea2d4dbee05507c/dom/webgpu/ipc/WebGPUParent.cpp#L457)

冻结 layer 的只读审计未发现解释这条断言的 dispatch 缺陷，Firefox 自身断言已足以解释该失败。[完整审计](../../.tmp/firefox-vulkan-budget-20261008/layer-audit.md)

## 5. 同版本性能：未观察到稳定优势

由于 157 的第二个阻断，使用 **同一 Firefox 156.0.1** 比较两条能运行的路径，避免拿 156 Vulkan 与 157 DX12 混比：

- Vulkan：原版大共享数组 worker + 临时预算扩展过滤。
- DX12：移除共享数组的 direct-original worker；没有注入 layer。
- 同一 2921×4096 fixture，`processMode=original`，同一完整原文排版流程，四模型均为 WebGPU。
- 每组使用新 Firefox 进程和 UUID profile，初始 CacheStorage 均为空；随后在同进程运行一次热任务。执行顺序为 V1、D1、D2、V2、V3、D3，GPU 串行。
- 冷指新进程/profile 首次推理至结果图片确认显示，**不含 Firefox 启动时间**，没有清除 OS / NVIDIA 磁盘缓存。性能组没有额外 detector readback/hash 诊断。
- 非 worker 文件来源一致，小资源已逐字哈希；大模型/字体/wasm 同尺寸且来自复制。Direct worker 完整后缀等于 original worker，差异是 shader 转换 prefix。单值 backend pref 与固定 156 后端选择源码限定实际后端，provider 记录排除了 WASM 回退。

| 路径 | 冷 1 | 冷 2 | 冷 3 | 冷中位数 | 热 1 | 热 2 | 热 3 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Vulkan + 原版共享数组 | 8.071 s | 6.784 s | 7.088 s | **7.088 s** | 2.797 s | **108.933 s** | 2.946 s |
| DX12 + 移除共享数组 | 7.403 s | 6.913 s | 7.001 s | **7.001 s** | 2.952 s | 2.688 s | 3.300 s |

中位差为 +87 ms / +1.24%，范围明显重叠，不能据此说 Vulkan 显著更慢，也没有证据称其更快。12 次性能输出 PNG/RGBA 哈希均相同。本机这条绕过方案包含 layer 初始化和真实 allocator 回退，不代表物理预算问题彻底修复后的理论最优 Vulkan，也不代表未来修复后 157 的性能。

Vulkan 热 2 的异常保留在表中，未静默剔除。其 jank 总流水线耗时为 3035 ms，模型与图片生成阶段正常；相对页面计时，完整 pipeline 在约 3.2 s 已完成，至少 105.8 s 位于 pipeline 完成到最终显示确认之间。rAF 采样中断与结果投影/图片展示等待吻合，但现有探针没有 load/decode/rAF 各边界，不能将整段延迟精确归于 rAF，也不能称 Vulkan 模型计算卡了 108 s。这一异常限制了热展示稳定性结论。[时间界定及源码核对](../../.tmp/firefox-vulkan-budget-20261008/display-delay-audit.md)

原始性能报告：[V1](../../.tmp/firefox-vulkan-budget-20261008/perf-156-vulkan-original-1.json)、[V2](../../.tmp/firefox-vulkan-budget-20261008/perf-156-vulkan-original-2.json)、[V3](../../.tmp/firefox-vulkan-budget-20261008/perf-156-vulkan-original-3.json)、[D1](../../.tmp/firefox-vulkan-budget-20261008/perf-156-dx12-direct-1.json)、[D2](../../.tmp/firefox-vulkan-budget-20261008/perf-156-dx12-direct-2.json)、[D3](../../.tmp/firefox-vulkan-budget-20261008/perf-156-dx12-direct-3.json)。

Worker SHA256：original `62593352fb5b7e01c7b7902725b0cbeb28bba66260f09874ec619fc84d69ce29`；direct `b3edd7548733fcaa0cb18e813d565492e8aa565ddf477989b7de5d1430a5081f`。此前 157 direct 的 6.19–6.42 s 结果另见[DXC 绕过研究](firefox-dxc-bypass-research-2026-10-08.md)，不纳入本表比较。

## 6. 三图质量：最终结果相同，内部张量未逐位一致

另外单独运行三张图的质量探针，不把其额外 GPU 读回、哈希开销纳入上述性能数据：主 fixture 2921×4096、原始问题 JPEG 3071×4096、translated1 1487×2048。

三图的 OCR 文本、阅读顺序、区域、CTC 解码与接受状态一致；保存 PNG 编码和独立 sharp 解码的 RGBA 逐位相同，像素差均为 0。但是 detector 输入/输出张量哈希及部分置信度不同，**严格比较为 FAIL**，不能称内部计算等价。哈希不能量化浮点误差，也不能凭最终像素相同忽略内部差异。

| 图片 | confidence 最大绝对差 | confidence 最大相对差 | 非 confidence 的记录数值/语义差异 |
| --- | ---: | ---: | ---: |
| main | 2.708e-7 | 2.965e-7 | 0 |
| original | 3.636e-6 | 7.989e-6 | 0 |
| small | 6.706e-7 | 3.304e-6 | 0 |

这些是可见 confidence 字段的误差，不是原始张量误差。张量比较中的 phase/model/name/dims/bytes 完全相同，每图四个 SHA256 差异都真实存在；输入差异在模型推理之前已出现，不能唯一归因于矩阵 shader 或 FMA。相同数值输入的前提未满足，若要隔离判断 detector 内核本身，需另做固定输入张量的实验。当前质量脚本 FAIL 的直接触发项是三图 `detectorInputExact=false`，有限 confidence 和输出哈希差异本身只是另列的证据。

比较只归一化随机 ID/时间字段，单独列出有限 confidence 数值差异；所有文本、几何字段、顺序和接受状态保留。原探针没有独立 bubble、原始 CTC logits、inpaint tensor 哈希。[比较脚本](../../.tmp/firefox-vulkan-budget-20261008/compare-quality-156.mjs)的自检通过，[完整质量结果](../../.tmp/firefox-vulkan-budget-20261008/quality-156-comparison.json)保留所有哈希、数值差异和离线像素检查。

## 7. 可行修复与本项目选择

浏览器层面可以解决，但需处理两个根因：

1. wgpu 对不可用小堆/无效预算的处理应允许满足 requirements 的 allocator 回退，同时修正 device-loss 判断；保留真实 OOM 错误传播。临时隐藏可选扩展证明绕过入口，尚不是生产级预算策略。
2. Firefox Windows 只应对实际 DX12 device 导出 D3D12 fence，其他后端走安全返回或受支持实现。恢复 156 的非 DX12 分支是最小方向，仍需浏览器构建及展示/共享资源/设备丢失测试。

普通扩展不能直接修改这些 native 策略、选择浏览器 WebGPU 后端或安装 native layer。实验没有提供可直接分发给扩展用户的 Vulkan 修复。鉴于没有稳定速度收益、157 另有崩溃及内部数值差异，**本项目继续优先 DX12 移除共享数组方案，保留 Vulkan 作为上游修复研究路径**。

尚未重编译修复后的 Firefox 157，也未改变驱动、Resizable BAR 或查明小堆占用者；本机三组和三图结果不能保证其他 GPU/驱动及长期运行行为。
