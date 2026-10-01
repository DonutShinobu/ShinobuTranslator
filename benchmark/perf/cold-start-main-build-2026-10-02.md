# 主分支冷启动优化：正式构建验收

2026-10-02。已把最终实验的优化、测试和研究记录接入 `master`，Chromium 的正常构建默认开启这组优化。

## 编译与安装

- 正常编译命令：`npm run build:extension:chromium`。
- 解压目录：`apps/extension/dist-chromium`。在扩展管理页启用开发者模式，加载该目录，或解压安装包后加载。
- 安装包：`artifacts/cold-start-2026-10-02/ShinobuTranslator-chromium-v0.8.3.zip`；同目录提供源码包和 `SHA256SUMS.txt`。
- 扩展、模型运行时、图像流水线、测试与基准的类型检查，以及发布边界检查、16 个测试文件的 162 项测试、模型预取的 28 个检查以及 shader 预热/复用检查通过。
- 最终重新编译产物的所有 JS 哈希均与下面普通计时使用的正式产物一致，未注入实验预编译器或计时探针。

## 五轮普通计时

使用 Chromium **151.0.7922.34**、RTX 5070 Ti / NVIDIA 610.74，主测试图为 2921×4096。`processMode=original` 排除外部翻译；保留检测、气泡、OCR、阅读顺序、掩膜、修复、排版、完整 PNG 编码与跨页交付，终点为内容页解码后的下一帧。每轮新 profile、第二次处理、关闭进程后缓存重启，按轮次交替执行对照与正式配置。

| 状态 | 同期关闭优化 ms | 正式配置中位数 ms | 正式配置范围 ms | 同期降幅 | 固定预算 ms |
| --- | ---: | ---: | ---: | ---: | --- |
| 新 profile、新进程/Worker/Session | 4985.0 | **2378.7** | 2335.7–2447.6 | 52.3% | 2845.5；5/5 通过 |
| 保留缓存，新进程/Worker/Session | 3567.3 | **1805.4** | 1798.3–1818.0 | 49.4% | 2332.7；5/5 通过 |
| 同 Worker 第二次，供参考 | 2036.7 | **1451.3** | 1428.9–1493.8 | 28.7% | 无冷启动预算 |

固定预算继续沿用早先 5691.0 / 4665.3 ms 的 50%，没有调整目标。本次对照是同一正式构建中显式关闭优化开关，ONNX Worker 的精简 JSEP JS 两组共有，因此它不是旧提交的完整重建。缓存重启相对于本次同期对照下降 49.4%，达到了原定的绝对预算。

普通计时未启用原始张量哈希、GPU 内存记录、启动追踪、图片生命周期关闭测试。完整样本、源产物哈希和中位数见 [数据](cold-start-main-build-2026-10-02.json)。

## 分阶段中位数

单位 ms。这些行是每个阶段各自的中位数；Session 与 shader 编译可重叠，行值不用于相加重建总耗时。

| 阶段 | 新 profile 对照 | 新 profile 正式 | 缓存重启对照 | 缓存重启正式 |
| --- | ---: | ---: | ---: | ---: |
| 入口/准备/等待模型就绪 | 1620.5 | 582.2 | 1500.8 | 439.3 |
| 检测 | 826.9 | 591.6 | 341.2 | 234.3 |
| 气泡 | 548.0 | 177.5 | 311.9 | 169.6 |
| OCR | 757.5 | 270.9 | 260.4 | 208.5 |
| 阅读顺序 | 123.7 | 0.7 | 123.7 | 0.7 |
| 掩膜细化 | 217.0 | 151.5 | 205.0 | 145.8 |
| 修复 | 465.0 | 260.8 | 322.9 | 227.7 |
| 排版 | 26.4 | 26.1 | 25.5 | 25.3 |
| PNG 编码/交付 | 269.0 | 162.2 | 270.8 | 162.8 |
| 内容页解码/显示 | 107.2 | 176.3 | 183.5 | 174.7 |

## 正式接入

- 构建预设统一开启已验收开关，普通主脚本、内容脚本和模型 Worker 都使用相同默认值；显式关闭仍可用于实验。
- 首个检测模型在 ORT 初始化前启动读取，与 WASM/GPU 初始化重叠。只复用 ORT 的一次标准 GET，错误、流式大文件、其他请求参数和 provider 回退保留原来的处理。
- 捆绑 110 个已验证 shader 模板，历史缓存以 4 路预热，兼容的首次模板以 8 路预热。只复用完整匹配且异步编译成功的 WGSL/入口/常量/auto layout 管线；未命中走原生创建。模板匹配 ORT 和 GPU 能力，浏览器 UA 可不同。
- 同版本 ORT 1.27.0 的 JS 去掉未使用的 WebGL 和 native WebGPU 分支，保留 JSEP WebGPU/WebNN/WASM；模型权重、FP32、分辨率和 WASM 不变。正式 Worker 约 401 KB。
- 初始化重叠、按需字体、GPU CTC、检测输出并行回读、像素与掩膜处理、Blob 消息传递和 Worker PNG 编码均使用最后验收组合。PNG 完整编码后才交付。
- 正常构建检查模板/ORT/全部模型的版本和哈希，以及部署 WASM 与安装包的一致性；模型或 ORT 升级必须重新验证模板。

## 质量与兼容性

独立诊断检查覆盖 **12 个结果**：Chromium 151 的两张图（2921×4096、1487×2048）以及本机 Edge 154.0.4258.48 的主图，新 profile 和缓存重启分别比较对照与正式配置。检测输入、三个原始输出、OCR 文本/置信度/框/输入、provider、最终 RGBA 和 PNG 完全一致。宿主关闭后内容页 PNG 仍可读取；GPU 未捕获错误为 0，device lost 为 false。详细哈希与 OCR 记录见 [质量记录](cold-start-main-build-2026-10-02-quality.json)。Edge 检查带诊断，不作为五轮普通计时的一部分；Firefox 未纳入本轮验证。

shader 模板的首轮收益已在上述 GPU 上验证；其他 GPU 能力未匹配时保留正常创建路径，其耗时需另行实测。

## 复现与中间记录

普通计时：`node benchmark/perf/src/run-cold-budget-experiments.mjs --variants=baseline,production --rounds=5 --runs=2 --restart --browser-executable=<Chromium151路径>`。`production` 使用正常构建的开关与模板，未使用实验注入的预热逻辑；结束后恢复所有构建 JS 和 manifest。

质量检查使用 `baseline-verifydet-verifyinput,production-verifydet-verifyinput`，并加上 `--init-profile --gpu-memory-profile --blob-lifetime-check`；第二张图加 `--image=assets/readme/translated1.png`。汇总使用 `benchmark/perf/src/summarize-cold-budget-experiments.mjs`。

- [最终实验验收与失败样本](cold-start-budget-final-2026-10-01.md)
- [早期多 agent 分阶段探索](cold-start-budget-multi-agent-2026-10-01.md)
- [入口与初始化](cold-budget-startup-2026-10-01.md)、[shader 编译](cold-budget-shaders-2026-10-01.md)、[像素与 PNG](cold-budget-pixels-2026-10-01.md)
- [GPU 调度](cold-budget-gpu-scheduling-2026-10-01.md)、[阅读顺序](cold-budget-reading-panels-2026-10-01.md)

原始普通计时：`.tmp/cold-budget/1790871453744-results.json`。原始质量诊断：`.tmp/cold-budget/1790871294571-results.json`、`.tmp/cold-budget/1790871373658-results.json`、`.tmp/cold-budget/1790871781537-results.json`。上述研究和可运行检查已保留在本分支。
