# Firefox 157 原生 Shader 预编译验证（2026-10-08）

本报告保留当时的实验状态。原始报告、profile 与实验脚本位于本机未提交的 `.tmp/`，普通仓库 clone 不包含这些材料，相关链接仅供保留该目录的本地复核。

预编译没有解决 Firefox 与 Chrome 约 3–4 秒冷启动之间的剩余差距。现有小工作组绕过方案之上，后台单路预编译三轮冷启动中位数从 **8.531 秒降到 7.819 秒，节省 0.712 秒（8.35%）**，但第三轮冷、热运行都更慢。等待预编译全部完成再推理，则把约 5.6–5.8 秒成本移到 preload，总耗时仍为 8.4–8.7 秒。保留现有生产小工作组方案，不集成此次预编译实验。

Chrome 约 3–4 秒来自用户当前观察；本轮未重测 Chrome，不将它作为本次配对性能基线。

## 范围与校验

- 一台 Windows 机器、原生 Firefox 157、同一主图、original 模式；每组使用新的唯一 profile，再运行冷/热各一次。未清除操作系统或 GPU 驱动缓存。
- 首轮筛选 10 次、正式三轮 12 次、等待完成方案筛选 6 次，共 **28 次性能运行**。原生诊断和 shader capture 另计，不混入性能中位数。
- 28 次均完成，无捕获到的错误；detector、bubble、OCR、inpaint 均实际使用 WebGPU，结果均通过 chunked 通道返回。
- 28 次的 PNG SHA-256、浏览器解码 RGBA SHA-256、尺寸、字节数均与 `quality-main.json` 精确一致。矩阵同时校验各候选 Worker 哈希在测试期间不变，四模型和 WASM 资产哈希与 baseline 一致。
- 共用结果：2921×4096，6,535,387 PNG 字节。PNG SHA-256：`2cd34e7459b9079937bf886cc0e5d2b70e189a9d7c72861b3b2883d4dc02d239`；RGBA SHA-256：`44f04d1ecaf425de0cddea7f329f6f9a13c0bd2df6ea9c061a645ccad888c0eb`。
- 参考质量报告此前已通过独立 sharp 解码校验。性能运行只采集最终浏览器图像哈希，不存储另一份 PNG，也不验证中间张量和每个 OCR confidence 字段。严格三图质量比较脚本已准备，但此次未集成候选，因此未执行候选质量运行。

## 后台预编译

捕获到 110 个模板。full1/full4/full8 按原生捕获顺序，以并发 1/4/8 调用 `createComputePipelineAsync`；ocr4 保留全部模板，将 OCR 模板提前、并发 4。设备返回后，预编译与正常推理重叠。

首次筛选每个候选只有一组新 profile，不能据此证明稳定排名：

| 候选 | 冷启动秒 | 热运行秒 |
|---|---:|---:|
| baseline | 8.623 | 2.660 |
| full1 | 7.817 | 2.569 |
| full4 | 8.158 | 2.769 |
| full8 | 8.004 | 2.652 |
| ocr4 | 8.032 | 2.547 |

随后对 baseline/full1 交替执行 AB/BA/AB 三轮，保留全部样本：

| 轮次 | baseline 冷秒 | full1 冷秒 | baseline 热秒 | full1 热秒 |
|---|---:|---:|---:|---:|
| 1，AB | 8.399 | 7.786 | 2.564 | 2.551 |
| 2，BA | 8.604 | 7.819 | 2.666 | 2.572 |
| 3，AB | 8.531 | 8.772 | 2.673 | 3.437 |
| 中位数 | **8.531** | **7.819** | **2.666** | **2.572** |

热运行中位数节省 0.094 秒（3.53%）。第三轮 full1 相对同轮 baseline 冷启动慢 2.82%、热运行慢 28.58%，未删去。三对样本不足以估计稳定性或尾部风险。

| 阶段 | baseline 冷中位 ms | full1 冷中位 ms | baseline 热中位 ms | full1 热中位 ms |
|---|---:|---:|---:|---:|
| preload | 381 | 360 | 79 | 82 |
| detect | 1718 | 1719 | 267 | 257 |
| bubble | 1450 | 1645 | 150 | 148 |
| OCR | 3080 | 2807 | 810 | 809 |
| mask refine | 159 | 161 | 161 | 157 |
| inpaint | 910 | 357 | 350 | 358 |
| parallel 父阶段 | 1067 | 518 | 511 | 515 |
| typeset | 31 | 30 | 17 | 15 |
| finalize | 181 | 181 | 182 | 182 |

parallel 包含 mask/inpaint，不能重复相加；分别取中位数的阶段也不保证总和等于端到端中位数。detect 基本不变，OCR/inpaint 缩短，bubble 变长，符合工作提前、队列等待重新分布的现象，但单凭阶段计时不能证明具体底层原因。

每次均准备 17 个 OCR 区域，冷运行采用原有 first-serial 策略，共 9 次推理，热运行 8 次。冷推理逐次中位数（ms）：baseline 为 `1855,474,101,100,100,100,100,100,100`，full1 为 `1309,589,236,189,31,100,100,100,100`。首个推理变快，随后若干推理变慢；输入维度与每次原始数据均保存在分析 JSON 中。

## 等预编译完成再推理

full1ready/full4ready 在设备初始化期间等待所有捕获模板完成；等待计入冷启动。这一轮筛选未显示总耗时优势：

| 候选 | 冷秒 | 热秒 | preload ms | detect ms | bubble ms | OCR ms | inpaint ms |
|---|---:|---:|---:|---:|---:|---:|---:|
| baseline | 8.379 | 2.586 | 359 | 1685 | 1433 | 3060 | 901 |
| full1ready | 8.655 | 2.614 | 5840 | 253 | 285 | 910 | 345 |
| full4ready | 8.456 | 2.570 | 5629 | 260 | 174 | 911 | 362 |

推理阶段已经接近热运行，预编译成本仍须在首次启动承担，主要移到了 preload。增加并发或等待完成并没有把本图冷启动降至 3–4 秒。

## 原生 API 与等待边界

单独的 baseline/full1/full4ready 冷热诊断计数如下，不用于替代无诊断性能报告：

| 指标 | baseline | full1 | full4ready |
|---|---:|---:|---:|
| native shader module 调用 | 123 | 110 | 110 |
| native 同步 pipeline 调用 | 123 | 100 | 0 |
| native async 调用 / 完成 / 失败 / 最终 pending | 0 / 0 / 0 / 0 | 110 / 110 / 0 / 0 | 110 / 110 / 0 / 0 |
| 已 ready pipeline 命中 / 未命中 | 未记录 | 23 / 100 | 123 / 0 |
| module 缓存命中 | 未记录 | 123 | 123 |
| 同步 pipeline JS 调用实测合计 | 0 ms | 0 ms | 0 ms |
| async native JS 调用返回实测合计 | 0 ms | 1 ms | 3 ms |
| 首个 async 发起至最后完成跨度 | 不适用 | 5607 ms | 5492 ms |

观察到计时精度为 1 ms，0 ms 只说明低于该精度。**剩余数秒不能描述为 JavaScript 同步卡在 `createComputePipeline` 内。** 原生调用可先入队，完成等待出现在后续推理或输出读回边界。110 个 async 全部完成，也不等于正常推理命中了 110 个 ready pipeline；实测只有 23 次，另外 100 次仍走原生创建。

full4ready 已全部完成预编译，123 次 pipeline 请求全部命中，无额外 native 同步创建，证明这些模板和缓存键能覆盖本图请求；后台 full1 的未命中主要发生在 pipeline 尚未 ready 时。full4ready 的四路 async 时长合计 21,713 ms，但发起至完成墙钟跨度为 5,492 ms，不能把并行 promise 时长合计当启动成本。

诊断报告端到端冷/热耗时也完整保留：baseline 8.878/2.553 秒，full1 7.788/2.519 秒，full4ready 10.594/3.621 秒。它们可能包含探针扰动和环境波动，不与无诊断样本混算，也未删去较慢结果；图像哈希仍一致。

| 诊断冷运行边界 | baseline ms | full1 ms |
|---|---:|---:|
| detector `ort-run` | 31 | 29 |
| detector 三路 output-readback 区间并集 | 1561 | 1573 |
| bubble `ort-run` | 1399 | 1613 |
| OCR 9 次 `ort-run` 实测合计 | 64 | 63 |
| OCR 9 次串行 output-readback 实测合计 | 2905 | 2657 |
| 首次 OCR output-readback | 1792 | 1280 |
| inpaint `ort-run` | 758 | 204 |

detector 三路读回重叠，不能相加。OCR output-readback 含 reduction pipeline、dispatch、copy 和此前原生/GPU 工作完成等待，不是单独 `mapAsync`、拷贝带宽或编译器基准。并发 async promise 时长也不能相加当编译墙钟时间。native 事件上的活跃 Comlink 请求标签不保证 shader 的所属模型。

证据支持剩余等待主要体现于原生/GPU 完成边界。预编译的提前量不足、队列竞争是合理推断；具体有多少来自 Naga、DXC、IPC 或 GPU 执行，需 Gecko/backend profile，当前探针没有分离这些成本。

## 原始资料与复现

临时验证目录：[.tmp/firefox-shader-warmup-20261008](../../.tmp/firefox-shader-warmup-20261008/)。筛选、正式三轮、ready 筛选分别保存在 `screen-summary.json`、`async-summary.json`、`ready-screen-summary.json`，报告分别使用 `screen-performance-*`、`async-performance-*`、`ready-screen-performance-*` 前缀，防止后续矩阵覆盖。模板及 Worker 哈希见 `candidate-metadata.json`；模型/WASM 哈希见各矩阵 summary 的 `sharedAssets`。

原生计数见 `native-baseline.json`、`native-full1.json`、`native-full4ready.json`；逐阶段、逐次 OCR、原生时间线见对应 `*-summary-analysis.json`。离线重新分析：

```powershell
node .tmp/firefox-shader-warmup-20261008/analyze.mjs --summary=screen-summary.json --report-prefix=screen- --diagnostics=
node .tmp/firefox-shader-warmup-20261008/analyze.mjs --summary=async-summary.json --report-prefix=async- --diagnostics=native-baseline.json,native-full1.json
node .tmp/firefox-shader-warmup-20261008/analyze.mjs --summary=ready-screen-summary.json --report-prefix=ready-screen- --diagnostics=native-full4ready.json
```

`run-matrix.mjs` 是顺序执行浏览器验证的驱动，`compare.mjs` 是严格三图质量比较器。此次实验文件均留在临时目录；生产 Worker 未加入预编译，保留已验证的小工作组绕过方案。
