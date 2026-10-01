# 冷启动减半预算：多 agent 分阶段实验

后续进展：[最终实验](cold-start-budget-final-2026-10-01.md)达到固定预算；[主分支构建验收](cold-start-main-build-2026-10-02.md)记录默认开启后的正式编译结果。下文是早期探索记录。

2026-10-01。范围：Chromium、现有模型与 float32、完整首次图片处理，排除外部翻译。实验从生产提交 `f26f779` 创建独立工作树 `C:\Users\STONE\.codex\worktrees\cold-start-budget\ShinobuTranslator`。

## 结论

三名子 agent 分别研究入口/字体/Session、首次着色器编译、像素处理/交付；主控补充 GPU CTC 和真实扩展组合实验。**本轮最佳组合首图中位数 3.63 秒，缓存重启 2.65 秒。输出一致，但尚未达到之前确定的 2.85 / 2.33 秒目标。**

| 状态 | 本轮同组 baseline | 最佳组合 | 同组减少 | 原先的绝对目标 | 距目标仍需减少 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 新浏览器、新 profile、新 Worker/Session | 6854.8 ms | **3631.9 ms** | **47.0%** | **2845.5 ms** | **786.4 ms** |
| 保留 profile，重启浏览器/Worker/Session | 4194.7 ms | **2651.7 ms** | **36.8%** | **2332.7 ms** | **319.0 ms** |
| 相同 Worker 再处理一张图 | 3356.8 ms | 2399.0 ms | 28.5% | 不作冷启动验收 | — |

原先生产基线为新 profile 5691.0 ms、缓存重启 4665.3 ms，目标取其 50%。本轮机器负载有波动，不能因新对照变成 6854.8 ms 就把绝对目标提高。即便按本轮新 profile 对照的 50%（3427.4 ms），最佳组合中位数仍差 204.5 ms。

最终两轮首图的原始值：baseline **6312.8 / 7396.8 ms**，最佳组合 **3222.8 / 4040.9 ms**；缓存重启 baseline **3777.3 / 4612.1 ms**，最佳组合 **2632.6 / 2670.7 ms**。另一组组合实验最快首图为 3130.3 ms，也没有达到原先 2845.5 ms 的目标。两轮结果只表明可继续推进，尚不足以保证稳定减半。

## 测量口径与环境

- ORT Web **1.27.0 JSEP WebGPU**，Chromium **145.0.7632.6**，RTX 5070 Ti / NVIDIA 610.74。没有把切换原生 WebGPU EP 算作本轮收益。
- 主图片 **2921×4096**，本地 HTTP 提供原图；模型为本地扩展资源。没有缩小图片、减少 ROI、修改模型权重、使用 FP16/量化或改变 OCR batch 规则。
- 使用真实扩展快捷图片处理，`processMode=original`：识别出的原文参与排版，跳过外部翻译请求。包含取图、传输、宿主、字体、模型、检测、OCR、排序、遮罩、去字、排版、PNG、回传、解码和下一动画帧。
- 计时从用户触发开始；模板预编译和提前加载都在计时窗口内。PNG 解码后的下一 `requestAnimationFrame` 为终点，全图像素哈希在终点之后计算。
- 每个变体采用新的 profile，先首图再同 Worker 第二图；两轮反转变体顺序。缓存重启使用既有生产着色器历史缓存，移除额外模板注入，避免重复预编译。
- 没有清除 OS 文件缓存和 GPU 驱动缓存，结果不代表完全无缓存的首次安装。CPU busy 约 25–60%、剩余内存约 7–8 GB；计时有明显波动，尚未证明所有退化都由系统负载造成。

## 已试的优化

### 1. 入口、字体与模型加载重叠

原路径在取得 File、传完输入、准备字体和图片后才开始 detector Session。候选先建立 Port/offscreen，让 detector 加载与取图、输入传输和解码重叠，复用现有 Session pending promise。

另外顺序提前准备 bubble、PaddleOCR 和 inpaint Session，真实推理仍在原阶段执行。最终组合将同样的两套字体注册推迟到检测之后，排版和最终交付仍等待字体，debug 路径在早期绘制前等待。

独立 A/B 的前置耗时中位数 **1863 → 1335 ms**；提前后续 Session 时为 **1203 ms**。但是全程 **5415 → 6255 / 6276 ms**，独立实验没有证明全程加速。可能发生 Session 工作转移或争用，且热态 CPU 阶段也变慢，需要 trace 才能归因。

最终组合中前置为 **1013 ms**，是最大的单个分组。晚注册字体时 bubble 段 **454 ms**，高于立即注册字体组合的约 220–231 ms；字体工作仍需完成，部分成本被移到后面，不能把前置差值全算成收益。

详情：[入口和字体报告](C:/Users/STONE/.codex/worktrees/cold-start-budget/ShinobuTranslator/benchmark/perf/cold-budget-startup-2026-10-01.md)。

### 2. 首图完整着色器模板，四路异步编译

现有生产代码已有历史 WGSL 缓存；新 profile 没有历史源码。本次从相同运行时、模型和设备捕获 **109 个**首图模板，将异步编译与 Session 加载重叠。ORT 仍生成并执行原来的着色器，模板用于提前填充浏览器编译缓存。

独立两轮对照中，全程中位数 **6547 → 5326 ms，减少 18.7%**；检测阶段 **908 → 452 ms**，OCR 阶段 **842 → 453 ms**。只预编译 detector/bubble/inpaint 的 71 个模板时，全程 **6877 ms**，没有收益。达到预算需要覆盖 OCR 的首次编译。

模板绑定实际 ORT 版本、模型 SHA-256、完整 UA、浏览器可见的 GPU 信息及 features/limits。不匹配时跳过模板并保留原流程。当前 Chromium 隐藏了 device/description；可见指纹不能唯一识别物理显卡或驱动。单图模板不能保证覆盖所有 OCR shape 或 GPU。

**这是当前最明确的首图优化证据，但还只是特定设备上的实验。** 主图片捕获的模板在第二张不同尺寸图片上也通过检查，仍需跨形状、跨设备验证。异步编译与加载重叠后，不能再把编译总时长完整扣一次。

详情：[着色器报告](C:/Users/STONE/.codex/worktrees/cold-start-budget/ShinobuTranslator/benchmark/perf/cold-budget-shaders-2026-10-01.md)。

### 3. OCR 在 GPU 上求相同的逐行最大值

当前 Paddle 解码只使用每个时间步的最大类别及其概率。实验保持完整模型输出为 float32，在同一个 GPUDevice 上求 argmax，再回传类别和原始概率；CPU 保留原来的 blank、重复字符、置信度和接受规则。

主图冷态输出回传由 **35,099,960 bytes 降至 3752 bytes**。最终组合的 CPU 解码 **18.3 → 0.3 ms**；OCR 的 `run + 回传` 为 **125.9 ms**。这些数字包含模板/加载组合影响，不能都归因于 CTC。

独立 CTC A/B 全程中位数 **8162 ms**，比同组 baseline **5415 ms**慢，因此没有孤立的全程收益证明。第一组组合中，含 CTC 方案为 **3771 ms**，不含 CTC 的组合为 **4447 ms**；阶段和整图质量相同，但两轮有负载波动，不能将 676 ms 全部视为 CTC 的确定贡献。

实模型另有验证模式：下载完整矩阵，逐行核对 GPU/CPU 的类别与 float32 概率完全相同。此检查不参与性能比较。可运行检查还覆盖类别并列、NaN、Infinity、正负零、多 batch 和完整 CTC 解码。

实现：[gpuPaddleCtc.ts](C:/Users/STONE/.codex/worktrees/cold-start-budget/ShinobuTranslator/packages/model-runtime/src/workers/gpuPaddleCtc.ts)；检查：[check-gpu-paddle-ctc.ts](C:/Users/STONE/.codex/worktrees/cold-start-budget/ShinobuTranslator/benchmark/perf/src/check-gpu-paddle-ctc.ts)。这属于输出搬运/解码优化，模型的数值计算精度不变。

### 4. 像素处理、Canvas 和 PNG 交付

实验跳过完整非 debug 流程中未使用的检测/OCR 预览，复用 PNG 已生成的 Base64，减少 mask/阅读顺序循环开销，并移除多余的全图 typedarray 复制。二值 CPU mask 改为 Uint8，取值仍是 0/1，模型输入仍是 float32。

最终候选在尺寸匹配时直接读取原图和 mask Canvas，复用独立的 ImageData 做合成。保留浏览器原有缩放、颜色、alpha 和阈值规则，源 Canvas 不被修改。

主图每次少分配约 **126.5 MiB** 临时 typedarray；这是静态分配量，并非实测峰值内存。独立 pixels/inpaint A/B 没有证明稳定全程提速，不能将 CPU 微基准收益直接扣入预算。

最终组合 inpaint 段 **245 ms**，其中真实模型调用约 **45–53 ms**，其余主要是像素读取、放大和合成。直接读取前，readOriginal/readMask 约 **50–65 / 69–94 ms**；最后两轮约 **19–20 / 26–40 ms**。仍有约 **48–95 ms** resize 和 **29–50 ms** compose，继续修改需保留原有 Canvas 插值结果。

详情：[像素与交付报告](C:/Users/STONE/.codex/worktrees/cold-start-budget/ShinobuTranslator/benchmark/perf/cold-budget-pixels-2026-10-01.md)。

## 最终组合对照

所有候选默认关闭，实验 runner 临时注入开关并在退出时恢复构建产物。

| 变体 | 新 profile 首图中位数 | 缓存重启中位数 |
| --- | ---: | ---: |
| baseline | 6854.8 ms | 4194.7 ms |
| `all`：入口/Session/字体重叠 + 完整模板 + GPU CTC + 像素优化 | 4376.8 ms | 2683.2 ms |
| `all-direct`：再直接读取 Canvas | 3970.8 ms | 2677.4 ms |
| `all-direct-latefonts`：再推迟字体注册 | **3631.9 ms** | **2651.7 ms** |

这些是组合的端到端表现，不是各项独立贡献。不同实验组不应交叉相减；前置、编译、Session 和 GPU readback 的收益也不能重复计算。

### 新 profile 的墙钟分账

下面四个连续分组从进度时间边界得到，可相加到全程。每组两轮的中位数是两值平均。

| 连续分组 | 同组 baseline | 最佳组合 | 占最佳组合 |
| --- | ---: | ---: | ---: |
| 用户触发至检测开始：入口、准备、解码与 detector 初始化 | 2149.1 ms | **1013.4 ms** | 27.9% |
| 检测 + 气泡 + OCR | 2719.1 ms | **1308.6 ms** | 36.0% |
| OCR 结束至 finalize：合并/过滤/排序、遮罩/去字、排版及状态开销 | 1245.0 ms | **691.4 ms** | 19.0% |
| PNG 编码、结果交付、解码和下一帧 | 741.7 ms | **618.6 ms** | 17.0% |
| **全程** | **6854.8 ms** | **3631.9 ms** | **100%** |

最佳组合模型阶段：detect **612.1 ms**、bubble **454.2 ms**、OCR **242.3 ms**。它们包含 Session 等待、预处理、编译、回传和后处理，并非纯 GPU 计算。

其余子阶段参考：order **110.0 ms**、mask **281.8 ms**、inpaint **245.5 ms**、typeset **39.8 ms**、交付 **353.7 ms**、显示尾部 **264.9 ms**。PNG **197.0 ms 已包含在交付中**；mask/inpaint 处于父级并行调度中。这些内部时长用于找瓶颈，不能再次叠加到四组墙钟分账。

## 达到原预算还要做什么

以下是下一轮的预算分配示例，**不是已证实的节省承诺**。保留原验收终点和输出质量。

| 连续分组 | 新 profile 当前 | 2.8455 秒目标分配 | 仍需减少 |
| --- | ---: | ---: | ---: |
| 入口与 detector 初始化 | 1013.4 ms | 900.0 ms | 113.4 ms |
| 检测 + 气泡 + OCR | 1308.6 ms | 900.0 ms | **408.6 ms** |
| OCR 后至 finalize | 691.4 ms | 645.5 ms | 45.9 ms |
| 编码、交付、显示 | 618.6 ms | 400.0 ms | **218.6 ms** |
| **总计** | **3631.9 ms** | **2845.5 ms** | **786.4 ms** |

缓存重启当前四组为 **677.5 / 924.5 / 564.6 / 485.1 ms**。可分配 **750 / 600 / 582.7 / 400 ms** 达到 **2332.7 ms**；前置和 CPU 已有余量，主要压力同样在模型阶段和交付，净缺口 **319.0 ms**。

### 下一轮优先级

1. **先拆清初始化和字体/Session 争用。** 为 Worker 启动、WASM 编译/实例化、模型读取、图初始化、GPU 上传、字体注册分别记录真实起止。当前 1013 ms 前置及 454 ms bubble 中有可调度的工作，先确认关键路径再调整 early Session 顺序/字体开始点。只移动等待位置无法保证全程减少。
2. **实验裁剪同版本 ORT 运行时。** 当前 `.jsep.wasm` 为 26,827,543 bytes，约 25.6 MiB。保留四个模型、shape 运算和必要 CPU fallback，只构建需要的算子，不改变模型文件。官方允许按模型算子定制 Web 构建；这可能减少加载和初始化，但本项目尚未测量收益。JS/WASM 必须配套，不宜直接使用要求 ORT-only 模型的 minimal build。[Web 部署文档](https://onnxruntime.ai/docs/tutorials/web/deploy.html#custom-build)、[定制构建文档](https://onnxruntime.ai/docs/build/custom.html)。
3. **将模板收益覆盖到更多设备与 shape。** 当前模板方案可用于验证上限；如果要通用部署，应在实际设备上提前生成/异步准备所需管线，或提供经过验证的模板集合。修改 ORT ProgramManager 来异步准备并复用 Artifact 有机会减少重复创建，但完整模板已经隐藏了大量编译；不能再预算同一份约 1.22 秒收益。Session 创建时没有所有实际 tensor shape，单改同步方法为 Async 不够。[ORT 1.27 ProgramManager 源码](https://github.com/microsoft/onnxruntime/blob/v1.27.0/js/web/lib/wasm/jsep/webgpu/program-manager.ts)。
4. **削减剩余数据搬运和交付。** 优先看检测/遮罩输出的下载和像素转换，以及约 157 ms 的编码之外交付、265 ms 的解码/下一帧。ORT 支持 GPU buffer 输入输出；GPU 后处理须保持阈值、坐标和数值规则。Chrome 扩展 Port 使用 JSON 序列化，不能简单加一个 ArrayBuffer transfer list；协议调整须包含实际 PNG 交付并保持导出能力。[ORT WebGPU I/O](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)、[Chrome 消息序列化](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#serialization)。

普通 GPU graph capture 要先执行捕获，主要服务重复执行，不能作为真正首图的编译消除方案。模型数学运算不变后，大部分下一步空间在初始化、编译、调度及搬运；目前没有证据证明再加一个开关就能稳定补齐 786 ms。

建议先推进第 1、2 项和交付细分，再选择有实际收益的改动。停止将像素循环微基准、单次最快值或两项重叠工作之和视为全程节省。

## 输出质量核对

汇总 **5 组、76 份**真实扩展报告，包含冷态、同 Worker 热态和缓存重启；不是 76 个独立冷启动样本。每组相同图片、相同缓存状态严格比较：

- 最终全图 RGBA SHA-256；OCR 文本、置信度、接受状态、区域几何、归一化和输入形状。
- detector、bubble、OCR、inpaint 的 provider；模型选择、原始输入规模和推理输入尺寸。
- 进度末端与总耗时的边界一致性。

主图各变体最终像素 hash 均为 `d3bd5084867c64501ac615d6baacb8cb31ee38f6b93af28cb7ce78f2d1d8ba97`。冷/热 OCR 分组因已有 coldFirstSerial 规则不同，按缓存状态比较，没有误把正常分桶差异判为质量变化。

第二张现有图片 `assets/readme/translated1.png`，**1487×2048**，冷态 **4730.5 → 2645.4 ms**，热态 **1588.5 → 1457.7 ms**。输出 hash 均为 `f179a8512570511708c8439972f7dfe19a0786db707ce6323ca1ff95e8e42fc3`，OCR/置信度/区域/输入/provider 完全一致。它检验不同尺寸与 ROI 的复用，不是 OCR 质量标注集，且只测一轮。

额外通过：入口/宿主相关 **35 个测试**、orchestrator **13 个测试**；Gaussian/连通分量/二值 mask/PNG Base64 字节检查；实 WebGPU CTC 边界及实矩阵逐行核对；原生 Canvas **8 种组合**（GPU/CPU Canvas × 不透明/半透明 × fast 开关）中读取、阈值、合成及源图保持一致。Chromium 构建、相关 TypeScript 和 `git diff --check` 通过。

这些证据表明已测样本和边界条件没有输出变化；仍需更多图片和 GPU 的回归后才能将候选默认开启。

## 产物与复跑

生产源码尚未合入主工作区；候选和检查留在独立工作树，开关默认 false。主工作区仅保存本报告和数据摘要，便于查看。

- [汇总 JSON](D:/code/ShinobuTranslator/benchmark/perf/cold-start-budget-multi-agent-2026-10-01.json)：包含分组中位数、76 份报告逐行摘要和原始报告路径。
- [组合实验 runner](C:/Users/STONE/.codex/worktrees/cold-start-budget/ShinobuTranslator/benchmark/perf/src/run-cold-budget-experiments.mjs)。
- [摘要与质量核对脚本](C:/Users/STONE/.codex/worktrees/cold-start-budget/ShinobuTranslator/benchmark/perf/src/summarize-cold-budget-experiments.mjs)。

在上述工作树复跑，浏览器/GPU 测试和构建须串行：

```powershell
Set-Location -LiteralPath 'C:\Users\STONE\.codex\worktrees\cold-start-budget\ShinobuTranslator'
npm run build:extension:chromium

# 为当前设备/模型重新捕获；capture 不参与性能比较。
node benchmark/perf/src/run-cold-start-experiments.mjs --variants=capture --process-mode=original

# 最终主图对照：两轮反转顺序，另测保留 profile 的浏览器重启。
node benchmark/perf/src/run-cold-budget-experiments.mjs --variants=baseline,all,all-direct,all-direct-latefonts --rounds=2 --restart --inpaint-profile

# 第二张图片仅作形状与输出复核。
node benchmark/perf/src/run-cold-budget-experiments.mjs --variants=baseline,all-direct-latefonts --rounds=1 --image=assets/readme/translated1.png

npx tsx benchmark/perf/src/check-gpu-paddle-ctc.ts
npx tsx benchmark/perf/src/check-inpaint-direct-pixels-browser.ts
npx tsx benchmark/perf/src/check-cold-budget-pixels.ts
```

已完成原始对照分组：着色器 `.tmp/cold-start-experiments/1790844865670-results.json`；独立候选 `.tmp/cold-budget/1790845479924-results.json`；第一组组合 `1790845882449-results.json`；最终组合/重启 `1790846615987-results.json`；第二张图片 `1790847042806-results.json`。捕获、基础检查和完整 CTC 核对不混入性能对照。
