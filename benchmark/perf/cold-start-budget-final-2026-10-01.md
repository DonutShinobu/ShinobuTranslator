# 冷启动减半：最终实验验收

2026-10-02 更新：本组合已接入 `master` 的正常 Chromium 构建并默认开启。正式编译产物的重新计时见 [主分支构建验收](cold-start-main-build-2026-10-02.md)。下文保留当时的实验配置与数据。

2026-10-01。三个子 agent 分别检查启动重叠、GPU 推理/编译和像素/PNG 路径，主控串行运行完整扩展实验。

## 结果

**实验组合达到此前固定的两个预算。** 最后五轮交替对照中，新 profile 的完整首图中位数 **2431.2 ms**，保留缓存但重建浏览器、Worker 和 Session 的中位数 **2042.7 ms**。这两个状态各五轮均低于对应预算。

| 状态 | 此前固定预算 | 最终候选五轮中位数 | 候选五轮范围 | 预算验收 |
| --- | ---: | ---: | ---: | --- |
| 新进程、新 profile，无扩展 shader 历史 | 2845.5 ms | **2431.2 ms** | 2405.7–2783.9 ms | 5/5 通过 |
| 保留 profile 缓存，新进程/Worker/Session | 2332.7 ms | **2042.7 ms** | 1830.3–2142.5 ms | 5/5 通过 |
| 同 Worker 第二次处理，供参考 | 无冷启动预算 | 1732.9 ms | 1728.7–1757.9 ms | 不作为冷启动验收 |

预算沿用早先 Chromium 145 的 5691.0 / 4665.3 ms 基线的 50%，没有因后续慢样本提高目标。最终实验使用 Chromium **151.0.7922.34**、ORT Web **1.27.0 JSEP**、RTX 5070 Ti / NVIDIA 610.74。

为避免把浏览器版本、机器负载或测量时段的变化都算成优化收益，最终五轮也包含同一 Chromium、同一实验构建关闭优化后的同期对照：

| 状态 | 同期基线中位数 | 候选中位数 | 同期降幅 |
| --- | ---: | ---: | ---: |
| 新 profile | 5345.5 ms | 2431.2 ms | **54.5%** |
| 保留缓存、新进程 | 3731.3 ms | 2042.7 ms | **45.3%** |
| 同 Worker 第二次 | 2214.0 ms | 1732.9 ms | 21.7% |

因此，保留缓存场景达到了原定 2.33 秒的绝对预算；相对于本轮较快的同期缓存基线，降幅是 45.3%，不能把它表述为本轮也降低了 50%。

### 最后五轮完整样本

顺序按实验 round，奇数 round 反转两个候选的执行顺序。每次新 profile 使用独立浏览器目录，随后测同 Worker 第二次，关闭浏览器后再测该 profile 的缓存重启。

| 状态 | Round 1 | Round 2 | Round 3 | Round 4 | Round 5 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 新 profile 基线 | 5792.4 | 5345.5 | 5198.1 | 5495.7 | 5129.5 |
| 新 profile 候选 | **2783.9** | **2405.7** | **2431.2** | **2480.5** | **2424.8** |
| 缓存重启基线 | 3748.3 | 3731.3 | 3730.1 | 3723.4 | 3735.4 |
| 缓存重启候选 | **1830.3** | **1980.3** | **2142.5** | **2042.7** | **2062.7** |

单位均为 ms。计时从同一次用户触发开始，到完整 PNG 在内容页解码完毕并进入下一次 requestAnimationFrame。保留取图、OCR、细化遮罩、去字、原文排版、PNG 编码和结果显示；`processMode=original` 跳过外部翻译。图片由本机 HTTP 服务提供，系统文件缓存和 GPU 驱动缓存未清空。

## 分阶段耗时

下面每列取该状态全程中位数对应的真实单次运行，不拼接各阶段独立中位数。使用进度边界进行连续分账，PNG 已包含在编码/交付中，mask/inpaint 已包含在并行分支中，不重复相加。

| 阶段 | 新 profile 基线 | 新 profile 候选 | 缓存重启基线 | 缓存重启候选 |
| --- | ---: | ---: | ---: | ---: |
| 配置、取图、传输、宿主启动 | 604.5 | 180.1 | 569.1 | 166.5 |
| 宿主准备、字体等待、图片解码 | 295.8 | 93.4 | 296.6 | 6.9 |
| 检测加载剩余等待 | 888.4 | 287.8 | 610.8 | 249.1 |
| 文本检测 | 823.5 | 394.9 | 347.0 | 240.9 |
| 气泡检测 | 539.7 | 241.1 | 304.2 | 173.6 |
| OCR | 920.0 | 454.8 | 451.6 | 420.2 |
| 合并、过滤、阅读顺序 | 133.2 | 9.3 | 130.2 | 9.0 |
| 遮罩细化 | 212.3 | 135.1 | 210.0 | 151.7 |
| 去字 | 473.1 | 268.1 | 339.5 | 255.5 |
| 排版 | 24.3 | 25.9 | 25.6 | 25.4 |
| 完整 PNG 编码与交付 | 251.8 | 159.9 | 258.5 | 162.4 |
| 内容页解码与下一帧 | 176.5 | 178.5 | 185.9 | 179.2 |
| 进度切换等剩余开销 | 2.4 | 2.3 | 2.3 | 2.3 |
| **全程** | **5345.5** | **2431.2** | **3731.3** | **2042.7** |

当前候选的新 profile 剩余大头是启动/加载的串行关键路径约 **561 ms**、OCR **455 ms**、检测 **395 ms**。完整 PNG 交付与显示仍约 **338 ms**。检测阶段包含预处理、Worker 等待、GPU 执行/读回和 CPU 后处理，不能把整段当成纯 GPU 推理。

阅读面板准备仍使用原算法、原尺寸和参数，提前与检测 Session 加载重叠并复用结果；排序阶段 125 → 0.7 ms 不代表这部分工作被删除。遮罩采用原生 filter 后也有栅格化/同步工作落在后续 bubble 和 inpaint 阶段，阶段下降不等于等额端到端收益。

## 达标组合的改动

1. **启动与资源加载重叠。** 从同一次触发开始提前启动宿主/检测 Session，检测模型读取与 ORT/WASM/adapter 初始化重叠；提前加载 bubble 和 OCR，inpaint 使用当前较晚的预载时机。字体按实际使用选择并在排版前等待，图片/字体使用 Blob URL。
2. **首次编译重叠。** 对与模型、ORT、浏览器、GPU 特征和 limits 匹配的 110 份 WGSL 模板执行异步预编译并复用完成的管线，新 profile 八路、历史缓存保留四路。未命中仍走原生创建。JSEP JS 独立构建缩小 Worker，配对 WASM 完全相同。
3. **保持 FP32 的 GPU 预处理与输出处理。** 保留 GPU 队列顺序，省去多余的预处理等待；OCR 在 GPU 上提取原有 CTC 所需的最大概率与索引，继续原有解码/并列值/置信度规则。本图 OCR 回传 35,099,960 → 3752 bytes，模型、输入尺寸和批次策略保持一致。
4. **减少图像转换。** 输入下载、Port 传输和结果采用经过真实握手验证的 structured clone/Blob 路径；保留 JSON/Base64 fallback。复用二值遮罩/灰度数据、按需生成预览、直接传去字输入像素，避免未使用的全图绘制和字符串转换。
5. **完整 PNG 在 Worker 原生编码。** 最终仍返回完整 PNG，内容页正常解码显示，维持原显示样式。
6. **本轮新增的候选。** 检测的三个不同 GPU FP32 输出并行 `getData()`，等全部读回结束后按原顺序处理/释放；遮罩用已校验的原生阈值处理并请求 GPU Canvas 目标上下文。后者的 `willReadFrequently:false` 是浏览器提示，不能仅凭该设置断言所有绘制都物理运行在 GPU。

本轮筛选阶段的三轮普通实验：

| 组合 | 新 profile 中位数 | 缓存重启中位数 |
| --- | ---: | ---: |
| 上一候选，含 downloadblob/lateinpaint | 2829.7 | 2111.5 |
| 加并行检测读回 | 3193.2 | 1969.3 |
| 再加原生 GPU 目标遮罩 | **2392.5** | **2042.6** |

仅并行读回没有稳定首图收益；最终验收的是完整组合，不能将各个实验中最好的阶段数字相加。最终没有采用 displayinstant、sourcecpu、writeupload、dispatch64、hist、preread 或额外 GPU fence。

## 输出质量与正确性

最终质量汇总跨 **67 次处理**，按图片和缓存状态分别比较：最终 RGBA、OCR 文字/原始置信度/框/方向/接受过滤、模型输入尺寸/字节数、provider 和计时终点一致。同 Worker 自适应批次与冷态的既有区别没有被误当成候选变化。

六个本轮完整 QA 记录额外检查检测输入和三个原始输出的四组 SHA-256。主图包含独立原流程 raw QA；第二图包含原流程与新组合对照。各图四组哈希完全一致。主图哈希如下：

| 数据 | 维度 | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| detector input | [1,3,1024,1024] | 12,582,912 | `74a1604ddb29953a37f41646f50be1e856ae64cee6f50d506f75e99428862d87` |
| blk | [1,64512,7] | 1,806,336 | `92c48c1ff39b040d3f0c8952b0f2eba910d68796681637c8928e873b9adf48e1` |
| seg | [1,1,1024,1024] | 4,194,304 | `1c09dd1ffe00135583ccb6fd943907ab435634e21c455d41968aed054dd6505f` |
| det | [1,2,1024,1024] | 8,388,608 | `5b1e1a14284fc72a5a27ec84a3de19ee3efdd047cdde11d3f5db5803471281e4` |

| 图片 | 尺寸 | 最终 RGBA SHA-256 |
| --- | --- | --- |
| `benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png` | 2921×4096 | `d3bd5084867c64501ac615d6baacb8cb31ee38f6b93af28cb7ce78f2d1d8ba97` |
| `assets/readme/translated1.png` | 1487×2048 | `06007f59966f605e51fc0ceab3f8aa13b5b5282218b77be762a6c9abdf1bfda0` |

GPU QA 均 `deviceLost=false`、`uncapturedErrors=0`。两图关闭宿主后，已交付的 PNG、字节数、URL、尺寸和解码 RGBA 保持可用且一致。GPU buffer 计数峰值约主图 1.144 GB、第二图 1.223 GB，未证明峰值降低；计数不包括 Canvas 纹理、WASM 内存和驱动保留内存。并行读回理论上同时持有更多 MAP_READ staging bytes，保留完整输出而未更改公共协议。

原生阈值的 **28 个精确像素场景 + 2 个 P3 fallback 场景**通过，覆盖 CPU/GPU source 与 target 组合、0–255 灰阶和实际放大尺寸。同一个 source 内的目标后端切换通过；更换 source 后端曾改变缩放像素，已排除该方案。并行读回的 **14 个检查**覆盖输出顺序、异步/同步失败、全部读取落定后释放和 Session dispose 排队。扩展 build、扩展与 benchmark TypeScript 检查通过。

## 排除的方案与剩余边界

- **原图 source Canvas 改 CPU：**真实浏览器 18/28 用例像素不同；二值小图 source 改 CPU 在 4/6 放大尺寸改变阈值结果。产品改动已撤回。
- **延迟整份 OCR prepare：**当前多数建图尾段已被 Host 后处理覆盖；再推迟会丢失约 208–268 ms 的早期模型读取重叠，没有净收益证据。
- **删除整个 det 输出：**det 是 CTD 首选输入，不是仅供 fallback。只少读 blk/第二通道的证据收益很小，还会改变公共输出/读回失败 fallback/完整张量验证；未实施。
- **GPU uniforms/submit/upload 等参数：**已有普通全流程实验没有稳定收益，不采用局部 API 次数下降替代最终计时。
- **PNG 变换和显示 transition：**原生 opaque export、无 filter PNG 与 displayinstant 没有足够完整流程收益，保留原显示/编码路径。

此前未加入本轮组合时，独立确认曾得到 3340.6 ms 首图中位数，未达固定预算。本轮三轮筛选也有一次 **3156.3 ms** 长尾；最后五轮通过不保证每种机器负载都在 2.85 秒内。保留这些失败记录，不用最优 QA 样本或重设基线宣布通过。

这次验证覆盖指定 Chromium/GPU 和两张图片。110 模板由固定 fixture 的模型代码生成，具有匹配边界；不同 GPU、浏览器或 OCR shape 可能不命中并走正常路径。Firefox 不在本次范围。没有把触发之前的预热移出计时。

## 文件与复现

实验代码保留在独立 worktree，优化开关默认关闭。runner 结束后构建 JS 和 manifest 已按源 SHA 恢复，未把实验组合默认启用到主项目。

- 最终结构化结论、全部五轮报告路径和模型/WASM/Worker/模板指纹：[cold-start-budget-final-2026-10-01.json](cold-start-budget-final-2026-10-01.json)。
- 67 次质量和时序核对：[cold-start-budget-final-quality-2026-10-01.json](cold-start-budget-final-quality-2026-10-01.json)。
- 保存的 110 模板：[cold-start-budget-templates-2026-10-01.json](cold-start-budget-templates-2026-10-01.json)。
- 三轮普通筛选：`.tmp/cold-budget/1790866767884-results.json`。
- 最后五轮普通对照：`.tmp/cold-budget/1790867286516-results.json`。
- 主图 raw QA：`.tmp/cold-budget/1790867907841-results.json`、`1790866046598-results.json`。
- 第二图 raw/PNG/lifetime QA：`.tmp/cold-budget/1790867139694-results.json`。
- 子 agent 细节：[启动](cold-budget-startup-2026-10-01.md)、[GPU 调度](cold-budget-gpu-scheduling-2026-10-01.md)、[像素/PNG](cold-budget-pixels-2026-10-01.md)。

PowerShell，工作目录为该 worktree，使用现有依赖与模型资源：

```powershell
npm run build:extension:chromium
node benchmark/perf/src/build-cold-start-jsep-js.mjs
$budgetCandidate='all-direct-latefonts-binary-prefetch-nofence-reuse-selectedfonts-deviceprobe-jsepjs-basic-async8-history4-adapteroverlap-workerpng-autolayout-paneloverlap-fontblob-imgblob-maskpack-ctcseed-downloadblob-lateinpaint-readparallel-threshold-thresholdgpu'
$budgetVariants='baseline,'+$budgetCandidate
node benchmark/perf/src/run-cold-budget-experiments.mjs --variants=$budgetVariants --rounds=5 --restart --ctc-templates=benchmark/perf/cold-start-budget-templates-2026-10-01.json --browser-executable=C:\Users\STONE\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe
```

普通计时不要添加 init/mask/inpaint/display/memory profile 或 verifydet/verifyinput。这些只用于独立 QA，会额外读取、哈希或记录。
