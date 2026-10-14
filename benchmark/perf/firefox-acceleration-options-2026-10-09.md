# Firefox 首图继续逼近 3–4 秒：技术栈调查与本机筛选

本报告保留当时的实验状态。原始报告、profile 与实验脚本位于本机未提交的 `.tmp/`，普通仓库 clone 不包含这些材料，相关链接仅供保留该目录的本地复核。

调查日期：2026-10-09。本次完成源码核对、临时候选构建和隔离 Firefox 实测；没有把候选接入正式构建。

## 结论

目前没有验证出能让本项目 Firefox 真正冷首图稳定达到 3–4 秒的新栈。已通过严格质量门的直接读取原型，之前冷中位数为 **6.400 秒**，热中位数 **2.601 秒**；这已经消除了已知共享数组整块清零触发点，但仍需编译其它 shader。

下一步分两条路线：保持纯扩展部署时，先验证原 shape 下合并 OCR 读回，再做 **LiteRT.js 的 detector 单模型**原型；如果可以增加本机程序，**Native Messaging + 原生 ORT / Windows ML**能退出 Firefox 的 Naga/DXC 编译链，值得作为更大收益的独立路线。两者都没有本项目 3–4 秒的实测证据。

仅升级普通 ORT JSEP、换 Vulkan、用 WGSL 资产 cache 代替 GPU pipeline cache、再增加 JavaScript 并发，没有发现足够的新依据。ORT C++ WebGPU EP / JSPI 已做本机筛选，当前候选故障或明显不理想，优先级下降。

## 测量口径

- Windows、RTX 5070 Ti / NVIDIA 610.88、固定 Firefox **157.0**。新 profile / 新 Firefox 进程，四模型均从本地扩展资产加载，主图为 `typeset-debug-log-2026-05-23T06-03-39-877Z.png`，2921×4096，original 模式。
- “冷”是新进程中的第一次图片处理；“热”是在同一进程中再次处理。计时包含处理到结果图完成解码和下一帧确认，**不是 Firefox 程序启动时间**。未清除 OS / NVIDIA 驱动磁盘 cache。
- Chrome 3–4 秒是用户观察的目标，本次没有重做同日 Chrome 对照。不能把它与以下样本组成受控浏览器倍数比较。
- 使用同一个本地 runner；正常性能、额外张量 / 像素质量诊断分开。有效比较只取串行 GPU / 浏览器实验：调度时曾误将 `perf-baseline-2` 与 `perf-baseline-3` 并发启动，两份原始数据保留并标记 invalid，全部排除，不能选择性保留其中看起来正常的部分。没有修改用户 Firefox、系统 Vulkan 配置、沙箱或验证开关。
- 除单独标注的 CPU bubble 混合候选，其它正常测量要求 detector、bubble、OCR、inpaint 四个模型选中的 provider 都为 WebGPU。这并不证明 C++ EP 内部每一个节点都没有 CPU fallback。
- 最终显示确认有波动。若只收到 completed 元数据而没有图像完成和哈希，按失败保留，不把 pipeline 诊断耗时冒充完整可见耗时。

## 新候选的实际筛选

基底是此前 `direct-original`：去掉匹配矩阵 shader 的共享数组，保留原 8×8 workgroup、通常 inner=32、fp32 乘加顺序。其严格质量与原生 profile 见[直接读取研究](firefox-dxc-bypass-research-2026-10-08.md)。

| 候选 | 本次首轮结果 | 判断 |
| --- | --- | --- |
| direct-original 对照 | 冷 6.898 / 热 3.002 s | 本次方向筛选基准；不替代此前三次中位数 |
| 仅关闭 OCR cold-first-serial | 冷 6.152 / 热 3.127 s | 首条 confidence 改变，不属于无损替代；单对不能认定稳定节省 746 ms |
| 每线程矩阵 accumulator 减少，`row1` | 冷 6.113 / 热 2.454 s | 主图完整 record 和像素一致；独立复测未确认改善，停止扩展质量门；首轮可能与资源准备重叠，不用于正式收益统计 |
| row1 + 关闭 cold-first-serial | pipeline 诊断 6.277 s；最终图像确认超时 | 无合格端到端样本，且同样改变 confidence，停止按保真方案推进 |
| direct-original + 仅 bubble WASM | pipeline 诊断 6.611 s；最终图像确认超时 | bubble 阶段降低，但未形成合格可见耗时或净加速证据 |
| ORT 1.27 C++ WebGPU EP / Asyncify | 检测阶段 WASM `RuntimeError: index out of bounds`；120 s 超时 | 未完成，120 s 不是性能点 |
| ORT 1.27 C++ WebGPU EP / JSPI | pipeline 诊断 44.335 s；最终图像确认超时 | 已收到 completed 元数据，但没有合格显示 / 像素质量结果；不能记作正常首图 44.335 s |
| ORT **1.30.0** C++ WebGPU EP / JSPI | 检测阶段 90 s 超时，未记录到明确 WASM / WebGPU 错误 | 阻塞原因未知；不是“1.30 修复失败”的定位结论 |

原始报告：[筛选汇总](../../.tmp/firefox-acceleration-research-20261009/research-summary.json)、[C++ / JSPI 失败证据](../../.tmp/firefox-acceleration-research-20261009/native-screen-failures.json)。JSPI 1.27 和 row1 早期筛选期间可能有候选准备 CPU 工作，均不据此给出精确跨栈倍率。故障只能降低本项目当前迁移优先级，不能证明 C++ EP 在所有浏览器 / 模型都慢。

C++ EP 候选从当前正式 Worker 重新 bundle，保留应用 GPU 预处理 / CTC / serial queue，使用版本配对的官方 WASM / mjs；**没有继承 JSEP 的 direct-read shader 改写**，因为 shader generator 已更换。没有进一步采新栈原生 profile 或逐节点分区，因此不能把其长等待归因于 DXC、GPU 算力或 JSPI 自身，也不能据此排除修正适配后重新验证的价值。

### 保持原分批的 kernel 重复筛选

保持原 OCR 分批的 `row1` 独立复测两次，冷 pipeline 为 **6.764 / 7.080 s**，最终显示 **9.041 / 15.105 s**；热 pipeline 为 **3.060 / 3.078 s**，显示 **7.202 / 7.134 s**。对照 `perf-baseline-1` 为冷 pipeline **6.582 s**、显示 **6.775 s**，热 pipeline **4.629 s**、显示 **5.066 s**。显示确认额外等待显著且不稳定，不能据此精确估计 kernel 回退幅度；冷 pipeline 本身也没有显示秒级改善。原样保留所有波动，不挑首轮 6.113 s 宣称稳定收益。

这些样本主图完整 OCR / record 与最终 PNG / RGBA 均一致，但没有 detector 中间张量 SHA 的完整新质量门。因未形成值得推进的性能结果，停止扩展 row1 三图质量检查，不将其列为已验收替代，也没有接入正式构建。原始报告见 `perf-row1-1.json`、`perf-row1-2.json` 和汇总。

`row1` 把每线程处理从 `[4,4,1]` 改成 `[4,1,1]`，accumulator 由 16 个 f32 减为 4 个；保留原 workgroup、inner tile、存储读法和乘加次序。工作组 Y 数可能增至四倍，所以不能预设热态一定更快。实际改动进入 MatMul / Conv2D 两个生成器；旧 ConvTranspose 生成器未被 bundle 引用。对真实 row1 生成体做了 **1,041,408 次**坐标比较，其中 **377,856 次**涉及负数 / 越界，全部通过；CPU oracle 不代替 GPU 质量门。

关闭 cold-first-serial 的主图完整 record 仅有一处数值变化：`ocr[0].confidence` 从 **0.9715989500793399 → 0.9039181892717819**。文字、顺序、几何、最终 PNG / RGBA 一致，但该 confidence 变动仍须保留为失败。关闭后的冷 record 恰好与原热 record 相同；不能以“热态本来如此”豁免冷对冷比较。

## 为什么剩余约两秒多难消掉

已有 capture 为 **123 次 pipeline 创建请求、110 个唯一 WGSL / entrypoint / constants 组合**；并非仅 22 个被直接读取改写的矩阵 shader。热窗口没有新 pipeline。固定 wgpu 的 DX12 层已有进程内 DXIL cache，所以 13 次重复请求不能简单算成 13 次重复 DXC 编译。[固定 HAL 源码](https://github.com/gfx-rs/wgpu/blob/9b095f553c0701329b92a347f5ab02ec02e133fc/wgpu-hal/src/dx12/device.rs#L366)

直接读取候选原生 profile 的冷 CanvasRenderer 中，DXC 约 **1.018 s CPU**，NVIDIA 编译模块约 **1.847 s CPU**。这些是采样归属，不能相加后从 6.4 s 端到端时间直接扣除；但说明真正的剩余编译工作仍大。若目标为 4 s，还需实质节约约 2.4 s，单一读回小改动不够。

Firefox 157 的 WebGPU service 每 **100 ms**轮询完成状态，最新 main 仍是该结构。[Mozilla 源码](https://github.com/mozilla-firefox/firefox/blob/main/dom/webgpu/ipc/WebGPUParent.cpp#L33) 本项目已有 GPU CTC，把每轮 OCR 输出由大 logits 缩到 96–1280 字节，后七轮冷 readback 仍合计约 634 ms；热八轮约 696 ms。这里的后续约 90 ms 档有源码对应；首次较长等待还含编译 / GPU 执行，不能全部归到 timer。

因此纯扩展的两个实质方向是：**减少独立 shader 数或 shader 编译复杂度**，以及**避免每组 OCR 都等待一个完成轮询周期**。再压缩小输出或增加外层 `Promise.all` 不足以实现这些。

## 可继续验证的路线

| 路线 | 价值与限制 | 下一步最小实验 |
| --- | --- | --- |
| 仅 bubble 使用 CPU / WASM | 小模型 CPU 执行成本可能低于 GPU 冷编译，可省 bubble 专有 shader；不能将整个流程迁 CPU | manifest 仅将 bubble.runtime 改为 wasm，其他三模型保持 WebGPU，完整冷 / 热与质量对照 |
| 保持原 shape，延后 OCR 读回 | 不改模型 / padding，有机会减少多轮约 100 ms 等待；既有等待窗口支持约 0.5–0.7 s 的乐观量级，**未实测端到端收益**，执行与等待重叠可能缩小节省 | 在单个 serial Worker 任务中顺序运行各组并提交 CTC / copy，最后统一 map；保留原冷首轮、顺序、错误清理和 fallback |
| **LiteRT.js / ML Drift WebGPU** | 新的图优化、融合、kernel 家族可能减少 110 个 shader；仍走 Firefox Naga/DXC，可能复杂 shader 反而更慢 | 仅迁移固定 shape detector，fp32，测 `loadAndCompile + first run + readback` 与真实 GPU / CPU 分配；通过后才扩展其它模型 |
| FP16 / mixed precision | 本机实际有 `shader-f16`；有带宽 / 权重 / 寄存器收益潜力，仍需编译，数值会变 | 单模型转换、保持 fp32 I/O；验检测 recall / OCR 错字 / 阈值翻转与去字边缘，不能沿用逐位无损结论 |
| **Native Messaging + 原生 ORT / Windows ML** | 从架构上退出 Firefox Naga/DXC；需额外 native host 安装、跨进程图像传输、平台和 EP 维护 | 先复用 ONNX 资产测 detector；分别计 host 无 cache 冷启动、磁盘 cache 命中、常驻 session 三种状态 |

### 小模型混用 CPU 与全量 CPU 不同

既有 Firefox 157 正确 WASM 全流程为 50.290 s，但主要是 detector；不能用这个总数排除 bubble 混合方案。[原始记录](../../.tmp/firefox-optimization/postfix-cpu157.json)

| 模型 | WASM 阶段 / run 耗时 |
| --- | ---: |
| detector | 41.061 / 40.887 s |
| bubble | **0.351 / 0.257 s**，session load 0.069 s |
| OCR，17 次串行 | 2.984 / 2.807 s（run 合计） |
| inpaint | 4.677 / 4.531 s |

此前 direct-normal 三次冷 bubble 阶段为 0.817 / 0.824 / 0.816 s，热为 0.240 / 0.237 / 0.148 s。活跃请求标签下 bubble 有 19 种专有 shader，另两种与其它模型共享，有减少冷编译的结构依据。CPU bubble 会同步占用同一 Worker，可能延后 OCR 初始化；跨报告的阶段差不是可承诺端到端收益。CPU inpaint 的约 4.5 s 已明显不适合优先尝试。

本次混合候选只修改 `models/models.json` 的 bubble.runtime，不改 Worker、模型或其它代码；其它 41 个资源文件 SHA 完全一致。首轮实际 provider 为 detector / OCR / inpaint WebGPU、bubble WASM。bubble 阶段 **464 ms**，对照 `perf-baseline-1` 为 **844 ms**；但 OCR 为 **2399 vs 2170 ms**，parallel 为 **1004 vs 818 ms**，pipeline 合计 **6.611 vs 6.582 s**，没有净收益证据。图像确认超时，没有 PNG / RGBA 质量样本，也不能把它记成 6.611 s 正常首图。[候选与资源校验](../../.tmp/firefox-acceleration-research-20261009/bubble-wasm-candidate.json)、[原始筛选](../../.tmp/firefox-acceleration-research-20261009/bubble-wasm-screen.json)

该轮 completed 元数据的完整 record 与原 `postfix-main` 冷参考、本次 `perf-baseline-1` 冷记录均为 **0 个差异**：17 条 OCR 的 confidence、几何、顺序保留比较。这支持已记录业务输出一致，不能替代尚缺的最终图片和中间张量质量门。

为区分图像加载 / decode / rAF 及测试脚本的一次性等待门闩问题，另用 v2 runner 检查；不同 runner 的样本不混成收益统计。v2 仍要求当前结果图解码成功和真实 rAF，没有超时成功回退。最终未形成新的有效配对，原因如下。

第一份 v2 对照给出了额外显示等待的直接证据：测试页开始可见，冷过程 **2942 ms** 时变为 hidden；pipeline **6832 ms** 完成，decode 在 **6944 ms** 完成，image-ready **7574 ms** 后请求 rAF，直到 **11070 ms** 才回调，显示确认 **11071 ms**。约 **3496 ms** 是已经请求 rAF 后的等待，不能归因 DXC / 推理。热轮又暴露了过早 decode 的测试脚本竞态：`src` 已更新但 `currentSrc` 尚是原图，decode 拒绝，8 ms 后当前图已 ready。[分段记录](../../.tmp/firefox-acceleration-research-20261009/v2-baseline-1.json)

该份数据标记 invalid；新版先等待当前图片 ready 再 decode，并核对全程可见性。小型 mock 还复现旧 observer 在图片被移除且不再发 load 时会被 `finishing` 门闩锁死；正式 UI 当前主 img 节点稳定，因此没有据此断言旧超时均由节点替换导致。旧样本没有这些阶段记录，不能把 v2 的具体原因追溯到每一个旧异常。

修正后的最后一次对照，测前通过扩展 API 将自有窗口从 minimized 恢复 normal，测试页确认 visible；**268 ms** 后又变 hidden。失败时 tabs 列表显示 fixture 仍是 active tab，但窗口为 **minimized**，图片 complete、src/currentSrc 匹配、正尺寸，decode 已成功，等待位置明确为 **rAF**。这是本轮窗口最小化 / 后台帧等待的证据，不推测是谁触发最小化，也不将此异常归到 GPU 编译。[最后一次可见性诊断](../../.tmp/firefox-acceleration-research-20261009/v2-baseline-2.json)

该样本同样标 invalid，随后停止可见性能测试，没有启动 v2 bubble 候选，因而没有可以报告的最后一对收益。没有修改后台节流偏好或用隐藏页的低计时冒充可见结果。v2 的 **9 项**小型自检通过，覆盖旧节点不再 load 的等待锁死、src 更新、currentSrc 滞后、decode 错误、隐藏页拒绝成功及真实 rAF 必需；这些是测试脚本正确性证据，不是模型性能 / 三图质量验收。

### OCR 集中读回的实现范围

现有 `runInference` 将 `session.run` 和 readback 都放在同一个 serial queue 内，直接同时调用多个 run 仍会排队。不可随意删 queue：ORT JSEP 共享当前 session / encoder / buffer pool 状态，异步重入可能破坏资源归属。

实现需要连到 Paddle provider 分组、ModelRuntime / browser API、Worker bridge / Worker API、`onnx-worker` 和 GPU CTC；Node 路径保留现有兼容回退。CTC 编码与 map 应拆开，输出不能提前释放，错误 / 取消 / 部分失败要全部清理。若保留九组原 logits，主图可能增加约 **35 MiB**峰值存活数据（不是实测 VRAM）；可在归约已提交后释放 ORT 输出，只保留小读回，须验证资源生命周期。这是后续完整实现任务，本次没有添加跨层 API。

### LiteRT.js：最值得试的新纯浏览器栈

Google 于 **2026-07-09**发布 LiteRT.js，包含 ML Drift WebGPU、XNNPACK CPU 和实验 WebNN；这是区别于当前 JSEP 的实际新栈。[发布说明](https://developers.googleblog.com/en/litertjs-googles-high-performance-web-ai-inference/)

官方示例加载 `.tflite`，现有 `.ort` 不能直接替换 import；需从上游源模型转换。固定 `[1,3,1024,1024]` detector 是较小的迁移入口。应核实 delegate 实际中间计算精度，不能只用 fp32 模型 / I/O 证明全程 fp32；先核对输出布局、完整输出、检测框和最终流水线，未支持 op 的 CPU fallback 与 GPU / CPU 拷贝必须计入。官方“最高 3 倍”来自 M4 MacBook Pro 上其它视觉 / 音频模型，不是本机冷启动，也不能拿来推算 6.4 / 3 秒。[API 文档](https://developers.google.com/edge/litert/web)

融合能减少 kernels，但也可能增加单个 shader 编译成本。因此退出条件应是：无法转换 / 算子缺失，质量不达标，或包含首次编译后的 detector 总时间没有稳定改善；不要只凭热 inference 快就迁移全部四模型。

### 原生 helper：更大收益与部署代价

[Windows ML](https://learn.microsoft.com/en-us/windows/ai/new-windows-ml/overview) 是基于 ORT 的 Windows 本地推理栈，可使用硬件 EP，绕开 Firefox shader 管线。本项目已有 Node runtime bridge，可复用边界设计，但当前 CUDA / CPU 支持不等于已具备 DirectML / Windows ML。硬件专用 EP 的 OS 要求另需核对；文档要求 Windows 11 24H2 以上，通用 CPU / DirectML GPU 的支持范围更广。

本机 RTX 5070 Ti 还可试 [TensorRT RTX EP](https://onnxruntime.ai/docs/execution-providers/TensorRTRTX-ExecutionProvider.html)。它有离线 EP context 和运行时 kernel cache，但首次设备 JIT 并未消失；不能把 cache 后或常驻 host 的时间当作全新安装冷启动。普通 TensorRT 的长 build 也不该放在点击图片的路径。

Firefox 扩展通过 [Native Messaging](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging) 调用 host，host / manifest 由 OS 安装，扩展不能独自完成安装。此路线收益来自改变执行位置，不是向浏览器关闭安全检查。本次没有安装 host、转换模型或验证 3–4 s。

## 没有优先采用的方案

- **普通 ORT 升级**：v1.30.0 已于 2026-09-10 发布，但当前 JSEP 的 program-manager、MatMul / Conv / Softmax 等 **8 个核心文件与 1.27.0 逐字节相同**。[对照与 SHA](../../.tmp/firefox-acceleration-research-20261009/ort-1.27-1.30-comparison.json)、[固定 v1.30 源码](https://github.com/microsoft/onnxruntime/blob/v1.30.0/js/web/lib/wasm/jsep/webgpu/ops/3rd-party/matmul_packed_webgpu.ts)。不能推广为整个 ORT 无变化；只是已知瓶颈代码没有新优化。
- **C++ WebGPU EP / JSPI**：ORT 将新性能工作转向该 EP，JSEP 只维护 bug / security。浏览器中的“native EP”是 C++ 编成 WASM，仍提交 WGSL，仍过 Firefox Naga/DXC；不等于本机程序。新 Conv 融合 / activation uniform 有潜力，但本轮可用性 / 性能筛选不足以迁移。[官方迁移政策](https://github.com/microsoft/onnxruntime/blob/main/docs/JSEP_Deprecation.md)、[迁移设计](https://github.com/microsoft/onnxruntime/blob/main/docs/design/onnxruntime_web_jsep_to_webgpu_ep_migration.md)
- **Vulkan**：此前同 Firefox 156 三对比较，中位数 Vulkan 原始 shader 7.088 s、DX12 直接读取 7.001 s，没有稳定优势；Firefox 157 还有独立 fence 回归。零 budget 可隔离绕过不代表值得上线。[本机调查](firefox-vulkan-budget-investigation-2026-10-09.md)
- **WebNN**：Mozilla 标准立场已 positive，Firefox 当前 `navigator.ml` 仍未实现；不是可部署的开关。[Mozilla 立场](https://github.com/mozilla/standards-positions/issues/1215)、[兼容数据](https://github.com/mdn/browser-compat-data/blob/main/api/Navigator.json)
- **Firefox trial.ml / onnx-native**：原生 AI 架构值得跟踪，但扩展当前是受限 trial / Transformers task 接口，不是任意四模型的普通 session API；文档中的非 LLM ONNX 硬件进程方向不能当作已交付能力。[扩展文档](https://firefox-source-docs.mozilla.org/toolkit/components/ml/extensions.html)、[硬件推理](https://firefox-source-docs.mozilla.org/toolkit/components/ml/HWInference.html)
- **IREE / TVM AOT**：可提前图优化、融合、生成 WGSL，但浏览器 / 驱动 pipeline 仍现场创建；IREE WebGPU 仍 experimental，ONNX 导入也在发展中，WebLLM 不是四个现有视觉模型的直接替代。[IREE 部署](https://iree.dev/guides/deployment-configurations/)、[TVM WebGPU runtime](https://github.com/apache/tvm/blob/main/web/src/webgpu.ts)
- **compiled pipeline 持久化**：普通 WebGPU / 扩展没有受支持的 DXIL / PSO 二进制导入导出接口。WGSL / 模型 cache 只是资产 cache。wgpu DX12 native PipelineCache 仍 dummy，相关 [#8526](https://github.com/gfx-rs/wgpu/issues/8526) 未完成；这不排除驱动自身隐式 cache。
- **subgroups / Tensor Core / graph capture**：本机 Firefox 157 未暴露 subgroups，`shader-f16` 不会把现有 fp32 模型自动转 fp16。Graph capture 先要运行和编译，主要省重复 replay，不消除首次编译。
- **WebGL / CPU 全量替换 / 后台 warmup**：前者转换 / 算子与维护方向不合适，全量 CPU 已有慢回退记录；小 bubble 单独混用是上文另一项实验。背景预编译此前只观察到约 0.7 s 不稳定收益，等待全部 ready 只是搬移成本，未把真实总首图降到 4 s。[warmup 验证](firefox-shader-warmup-validation-2026-10-08.md)

## 复现与证据

临时目录中保存 `prepare-ocr.mjs`、`prepare-row1.mjs`、`prepare-native.mjs`、`prepare-jspi130.mjs`、`run-ocr.mjs`、原始报告和质量比较器。`run-ocr.mjs` 启动前断言 Worker SHA，使用随机独立 profile、固定浏览器、子进程环境，结束由 driver 清理自有进程。

| Worker | SHA-256 |
| --- | --- |
| direct-original / noserial | `b3edd7548733fcaa0cb18e813d565492e8aa565ddf477989b7de5d1430a5081f` |
| direct-row1 / combined | `7736955c78075ae984eb3b77b9488613fa437f2c4a75d7003e0aeef4a17a145c` |
| C++ Asyncify 1.27 | `19bc6101810d43b5a11deaa2170d2e5e1e95c91011f94b9ad983a3001adbe60c` |
| C++ JSPI 1.27 | `14716d61bacc228d010d63c317a3c3f6f05ac0901c0b84a2b0bb2917fcf16a65` |
| C++ JSPI 1.30 | `3ef28d6f6c8bd71e57ed9e3bc768a64b2e041f2c379eb5f3b79e9df4427dcc73` |

JSPI 1.30 官方 npm tarball 按 metadata 的完整 SHA-512 integrity 校验，WASM / mjs 配对和源 Worker 哈希另存 `jspi130-candidate.json`；没有修改安装依赖或 lockfile。

收尾复核：`perf-baseline-1`、`perf-row1-1`、`perf-row1-2` 各自冷 / 热的完整 record、PNG / RGBA 哈希逐项精确等于原参考；v2 最小化 / rAF 诊断与 invalid 标记有断言检查。报告的 11 个本地证据链接存在，无占位内容或尾随空白。正式 `onnx-worker.ts` SHA 保持 `dcad354b4dcc1a832d44fe52e38586a3253e9aa5e4c4a3a1d3e91a08c709fa12`；本轮自有诊断 Firefox / runner 剩余进程数为 **0**。

本次未转换 LiteRT / FP16 模型、实现 bulk OCR 或安装原生 host，也未验证其它 GPU。三图逐位检查只能支持已测模型 / 场景；新运行时、精度或 padding 改动必须重新验收，不能预支质量与秒数。
