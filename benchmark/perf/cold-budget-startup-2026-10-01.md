# 冷启动预算：入口、字体与检测加载重叠

2026-10-01。实验工作树 `cold-start-budget`，Chromium；模型、Session 配置、输入尺寸、float32、两套 Source Han Sans 字体均保留。

## 发现

当前实际顺序为：设置快照 → 取图成为 File → 内容页连接 Port → broker 创建 offscreen → 内容页输入 Base64 分块 → broker 收齐全部输入 → host.prepare → imageRuntime.prepare 等两套字体 → 解码图片 → detector.getSession → 检测。

`broker.prepareJob()` 没有把 prepare 立即转交给宿主。它只确保宿主存在并给内容页 ready；`pumpAdmissionQueue()` 等输入完整后才一起转发 prepare/start/chunks。因此只改 `PipelineHost.prepare()` 的加载时机，无法覆盖取图或内容页输入传输。

`drawTypeset()` 在字体测量/渲染之前已有 `waitForFonts()`。字体无需阻塞检测、气泡、OCR 或去字。模型注册的 `getSession()` 已按模型、provider、Session 选项复用 pending promise；`dispose()` 已等待 pending Session。

## 可运行候选

统一实验开关：`globalThis.__shinobuColdStartOverlap = true`。默认 false，仅在实验产物的 content 与 offscreen 入口启用，ONNX Worker 无需这个开关。

1. 本地执行设置验证后，提前调用 `runLocalPipeline(Promise<File>, …)`。Port 和 offscreen 建立可与取图并行，输入仍使用相同 File 元数据与 Base64 协议。
2. offscreen 创建 `PipelineHost` 时即调用生产相同的 `getSession('detector')`。它与字体和输入传输重叠，不执行任何预热推理。
3. `createImagePipeline` 创建即注册相同两份字体，等待后移。真实排版仍等待字体；无排版/无文字路径在 finalize 等待，字体失败仍阻止结果交付。

计时仍从同一次用户触发开始，所有额外加载工作位于计时窗口内。未更改模型、字体、图像、排序或算法。

## 生命周期与质量检查

提前加载字体的 rejection 立即被观察，之后在 typeset/finalize 传播。将额外字体等待放在 finalize，确保字体失败时运行时已经拥有并能释放产物；放在 execute 返回产物之前会有丢失所有权的风险。

输入 Promise 被立即观察：取图失败时关闭 Port，后台仍用现有断开流程取消/释放 job；已取消后即使 File 晚到也不发送输入。设置无效或 whole-image 执行不会提前打开本地 Port。

已通过：

```powershell
npm run typecheck:extension
npm run typecheck:tests
npx vitest run tests/content/core/imageTranslationExecution.test.ts tests/content/core/localPipelineClient.test.ts tests/offscreen/pipelineHost.test.ts
```

截至最后字体候选，共 35 测试通过，覆盖提前连接、源失败、取消后的晚到输入、字体延迟/失败与画布释放、早 Session 顺序和关闭等待，以及跳过 bubble 的 typeset/无排版兜底和三个 debug 门控。两轮独立浏览器实验的质量结果见下文。

## 额外 Session 早加载

独立实验开关 `globalThis.__shinobuColdStartEarlySessions = true`，只需 offscreen 启用。建议对照 overlap-only 与 overlap+early-sessions，避免把 detector 早加载算两次。

后台顺序为 `detector 创建完成 → bubble → PaddleOCR prepare（含字典）→ inpaint`。推理仍在真实图像原有阶段执行；不运行零输入或其他 warmup。

- bubble 为 11.6 MB，首先准备这个紧接 detector 的阶段，尝试把其 Session 装载隐藏在检测首推理期间。
- OCR 为 76.6 MB，复用现有 `preparePaddleOcrRuntime()`，保持运行时模型选择、provider、SessionOptions、字典及输入规则。原流程已经在 detect 后发起 OCR 准备，本次只能主张进一步提前的差值。
- inpaint 为 22.7 MB，使用实际推理相同的 `['webgpu', 'webnn', 'wasm']` provider 顺序，在 OCR 准备之后加载。

仅进行顺序加载，没有新增 lock。这样仍可能与 Worker 实际推理争用 WASM/内存；同时加载三份模型不是默认候选。Session 创建不能消除各模型首次 run 的着色器编译。

宿主保留早加载 Promise：关闭/idle 释放时停止尚未开始的后续步骤，等当前步骤完成后再 dispose。早加载失败立即被观察；必要阶段仍按原流程调用同一个 getSession 并处理失败。

## 最后一个字体调度候选

`globalThis.__shinobuColdStartFontsAfterDetect = true`，需和 overlap 一起启用：避免在 offscreen 构造时让两份共约 13 MB 的 WOFF2/FontFace 工作与首个 Worker/WASM/Session 争用。首次 bubble 进度开始注册相同两字体，利用后面的 bubble/OCR/mask/inpaint 窗口。

typeset 进度也会先注册字体，再让既有 `drawTypeset.waitForFonts()` 等待；无文字、erase 或其他提前结果在 finalize 兜底注册并等待。typesetDebug/eraseDebug/collectDebugLog 在 execute 首步即注册并等待，任何早期 debug 绘制之前字体已就绪。当前 createImagePipeline 不提供 stopAfterOrder；直接调用 runPipeline 的 benchmark 路径不受 index 的字体候选影响。预检测复用路径仍经过 bubble。

这只是 CPU/加载争用的调度验证，未更改字体文件、字重或任何输入。

## 预算约束

当前代表样本前置合计 2033.4 ms = 882.3（入口/取图/传输/宿主）+273.5（准备/字体）+34.6（图片加载）+843.0（detector 加载）。

字体 273.5 ms 有机会隐藏在模型计算之前。detector 加载 843 ms 本身仍需要完成，只有落在取图、传输、图片解码窗口内的部分可以隐藏；offscreen 建立之前无法开始它。不能把 882 和 843 两项全部当作节省。

简化关键路径：旧路径 `设置 + 取图 + 宿主建立 + 传输入 + 字体 + 解码 + detector`；候选路径约为 `设置 + max(max(取图, 宿主建立) + 传输入 + 解码, 宿主建立 + detector)`，字体仍在排版前完成。

前置 0.90 秒预算需实测拆清宿主建立与 detector 初始化，可能需要同时缩短 Worker/WASM/Session 或编译成本。该候选单独不能保证全程 5.69 → 2.85 秒，组合时不可重复计算已隐藏的字体/编译时间。

## 两轮独立 A/B 实测：尚未证实全程提速

原始文件 `.tmp/cold-budget/1790845479924-results.json`。每个 variant 使用新 profile，先冷首图，再相同 Worker 的第二图；第二轮反转 variant 顺序。所有 variant 复用同一组编译产物，只有实验 flag 不同。

前置终点采用各份原始 `report.jank.stages` 中第一次 `detect.startMs`，即用户触发到检测开始的墙钟时间，包括真实取图、宿主、字体/图片和 Session 路径。这里不能把内部阶段时长相加替代进度终点，异步 Port 进度到达可能有偏移。

| Variant | 冷首图 visible，两轮 | 冷前置，两轮 | 冷前置中位数 | 同 Worker 第二图 visible |
| --- | ---: | ---: | ---: | ---: |
| baseline | 5261.2 / 5568.2 ms | 1816.1 / 1910.0 ms | 1863.1 ms | 2125.8 / 2384.9 ms |
| overlap | 6689.3 / 5821.5 ms | 1380.5 / 1289.8 ms | 1335.2 ms | 3291.7 / 3243.0 ms |
| overlap + early sessions | 6006.6 / 6545.8 ms | 1049.5 / 1357.4 ms | 1203.5 ms | 3410.8 / 3217.6 ms |

前置确有缩短：overlap 相对 baseline 中位数约少 **528 ms**，再提前后续 Session 的前置约少 **660 ms**。但全程中位数分别是 5414.7 / 6255.4 / 6276.2 ms，本组候选全程反而变慢；不能以局部耗时缩短宣称达成速度目标。

相比前置 900 ms 预算，overlap 尚差约 435 ms，early-sessions 尚差约 303 ms。这些数字仅是阶段实测缺口，不是可以直接扣减的全程收益。

### 质量与 Session 核对

12 份冷/热样本分别按冷/热状态比对，最终 RGBA SHA256 都为 `d3bd5084867c64501ac615d6baacb8cb31ee38f6b93af28cb7ce78f2d1d8ba97`。OCR 文本/置信度/接受状态、区域几何、预处理输入形状均完全一致。detector/bubble/OCR/inpaint 的 runtimeStages 全部为 webgpu；没有 provider 回退差异。冷 OCR 9 次调用、热 8 次，与生产宽度分桶/首项串行相同，没有额外 warmup。

源码核对显示，early detector、bubble 与必要阶段使用相同 getSession 参数；OCR 复用原 prepare 函数；inpaint 的显式 provider 列表与 manifest/实际推理一致。注册层用相同 cache key/pending promise，Worker bridge 用同一个 workerPromise。热 OCR sessionLoad 为 0～0.2 ms、coldFirstSerial=false，符合会话重用。

该组 raw report 的 workerCalls 为空，不能据此宣称实际 createSession 次数已经逐条审计。当前是源码去重、提供器/输入/输出、热态会话行为的交叉证据。

### 对变慢的具体判断

- early-sessions 首轮 detector 1335 ms、bubble 566 ms；overlap-only 对应 1238 / 865 ms。第二轮为 1476 / 596 ms 对 934 / 863 ms。提前 bubble/OCR Session 的图优化、分配和上传与检测首次执行共享 Worker/WASM/内存，可能把原来 bubble 的装载工作转移到 detect，并造成额外争用；这是待 trace 验证的程序机制，不是已确认原因。
- overlap-only 第二图字体/Session 早加载已经完成，但 order 192/195 ms 对 baseline 120/119 ms，mask 313/300 对 213/203 ms，PNG 298/337 对 200/199 ms。持续的 CPU 阶段变慢不能全部归因于一次性的字体加载或额外 Session 准备，也不能只靠全机 cpuBusyPercent 排除单核调度/GC/内存带宽影响。
- harness 已带 disable-background-timer-throttling、disable-renderer-backgrounding、disable-backgrounding-occluded-windows 与关闭 NativeWinOcclusion 的参数。本组阶段没有稳定的整秒等待形状；标准后台 timer 节流证据不足。参数并不能证明 GPU/扩展 offscreen/Worker 的所有调度优先级相同，因此也不能把后台页面节流宣称为已排除或已确认根因。
- 单独的两种入口候选暂不应按收益方案落入默认生产。字体后置候选用于进一步区分字体初始化争用，着色器/像素组合结果由 root 汇总；组合节省时间不能与这里的约 528/660 ms 再相加。

## 后续初始化诊断与小候选

本轮继续研究时，上一轮最佳组合仍为新 profile **3631.9 ms**、缓存重启 **2651.7 ms**，距离原定 **2845.5 / 2332.7 ms** 目标仍缺 **786.4 / 319.0 ms**。以下新增候选尚未有本子任务的端到端性能验收，不改变这个结论。

### 诊断口径与实际时线

新增 `benchmark/perf/src/cold-start-host-init-probe.js`，只在诊断组由 runner 注入。`__shinobuColdStartInitProbe={probeUrl,realm?}` 安装可选 `__shinobuColdStartInitMark`，分别记录 Worker 构造/Comlink 初始化与 Session 往返、Port 边界、设置/下载消息、宿主建立、字体 fetch/body/FontFace.load/add，以及主 realm longtask。每个 realm 记录 `performance.timeOrigin` 与本 realm 的 `performance.now()`，可以按绝对时间对齐；终端消息之后批量发送，不复制图片、模型或 Base64 内容。

Worker 内的 WASM/fetch/GPU marks 由主控另行实现。本 probe 不重复 wrap WASM/fetch。**诊断和 SHA 验证组包含观察成本，不能用来认领速度 A/B 收益。**

主控提供三份 Chromium 151 诊断：`.tmp/cold-budget/1790850111750-results.json`。它们是 baseline/nofence/directprep 的单轮质量诊断，不是同负载初始化对照。

| 诊断边界 | baseline | nofence | directprep |
| --- | ---: | ---: | ---: |
| 设置快照消息 | 313.8 ms | 6.3 ms | 3.4 ms |
| 图片下载消息 | 702.4 ms | 478.1 ms | 460.9 ms |
| offscreen.createDocument | 153.8 ms | 26.9 ms | 25.2 ms |
| Worker `init` 往返 | 1112.6 ms | 27.4 ms | 42.7 ms |
| detector createSession 往返 | 3824.0 ms | 826.9 ms | 1041.0 ms |
| 其中 availability requestAdapter | 1342.8 ms | 212.5 ms | 165.7 ms |
| 其中 ORT create | 2476.1 ms | 613.1 ms | 873.5 ms |
| ORT create 内 WASM instantiateStreaming | 133.1 ms | 50.5 ms | 59.9 ms |

这些嵌套边界不能相加。Worker `init` 仅保存 ORT 资源路径并返回，WASM/EP 初始化仍在第一次 createSession；因此 `worker-bootstrap-complete` 不能被视为 ORT 已就绪。ORT 1.27 的创建路径先初始化 backend/WASM/EP，再读取模型；主控负责模型预取复用候选。

三份样本每模型实际各 **1 次 createSession**，detector 均使用 `extended + useOrtModelBytesForInitializers`，全部 provider=webgpu；这次 Comlink trace 已能逐条审计，补足此前 workerCalls 为空的证据缺口。本组没有提前后续 Session，不能据此证明 early-sessions 组合的实际调度；等组合 trace 再核对。

所有 offscreen 的 `crossOriginIsolated=false`，同时 `document.visibilityState='visible'`。它虽然没有可见窗口，但不能从 DOM hidden 状态推断后台节流。没有证据将巨大波动全部归为机器负载或固定 timer 节流。

### 字体的同步争用

三份诊断的两字体注册墙钟窗口分别约 **819 / 261 / 383 ms**。font headers 一般 2–9 ms；第二套字体 body await 却可能为 **115 / 218 / 665 ms**，其区间横跨另一套 FontFace 的同 realm longtask。具体 100–568 ms 的 longtask 与 FontFace 解析/注册吻合，说明 body 的墙钟等待包含主线程延迟，不能全归为磁盘读取。

baseline 的 CN `face-load=335.5 ms`，但 `register` 还多约 232 ms；对应同步 longtask 合计 568 ms。新增 `font.add` 已放在 `document.fonts.add` 原同步边界以区分，不能在尚无该 marker 的旧样本里将这 232 ms 确认为 add 本身。

### 候选：同版本 JSEP JS 排除未使用 WebGL

`node benchmark/perf/src/build-cold-start-jsep-js.mjs` 从安装的 **1.27.0** 源码生成 JS-only 候选，再复用现有 Vite Worker 构建流程，只写 `.tmp/cold-budget-jsepjs`。不开启原生 WebGPU EP，不改 node_modules、dist、模型、Session/provider、`.jsep.mjs` 或 `.jsep.wasm`。

构建定义保持 JSEP/WebNN/WASM 与现有 API，仅 `DISABLE_WEBGL=true`。CPU 检查确认 JSEP GPU/WebNN/WASM 输入保留，WebGL/native EP 输入排除，build definitions 全部消解，版本与 Tensor float32/输入所有权一致，已部署 WASM 两资源 SHA 与安装包匹配。metadata 记录源码哈希，主控应以相同 Worker 源码构建对照。

ORT JS **811447 → 361511 bytes**；此刻 Worker **836988 → 394200 bytes**，约小 53%。后续 Worker 源码改动应重新生成。**缩包量不等于耗时节省**：有机会减少 Worker 读取/解析/eval，无法消除 Session 图初始化或 WASM 成本。正式 A/B 与全输出检查由主控串行执行。

完整 reduced-WASM 构建仍需同版本 CMake/Ninja/Emscripten，并保留四模型及运行时图优化所需 kernel/CPU fallback。当前 PATH 没有该工具链，Python ORT 为 1.20.1，不能用于替代 1.27 的配套构建。普通 `--include_ops_by_config` 可以减少 kernel；直接 minimal build 要求 ORT 模型，现有三个 ONNX 模型不适用。本轮没有构建或认领它的收益。[官方定制构建](https://onnxruntime.ai/docs/build/custom.html)、[Web 构建](https://onnxruntime.ai/docs/build/web.html)、[Web 部署](https://onnxruntime.ai/docs/tutorials/web/deploy.html#custom-build)。

### 候选：只注册本次排版实际引用的字体

默认关闭 `__shinobuColdStartSelectedFonts=true`。真实选择规则仍是 `targetLang==='zh-CHT'` 使用 TW，否则使用 CN；`original` 模式和日文原文也仍按 targetLang 选择，没有改按 sourceLang。字体文件、variable weight **200 900**、绘制 **700**、字号、glyph、fallback 链、度量和排版算法完全不变。

排版 CN 的 fallback 链不含 TW，排版 TW 的链不含 CN。debug overlay 固定 CN，所以 typesetDebug/eraseDebug/collectDebugLog 三条仍先注册两套并等待。content UI CSS 的确同时声明 CN/TW，但属于另一个 document，本候选不改变它的 @font-face。

构造时配置未知，先等真实 config 再选择；与 latefonts 组合时在原 bubble/typeset 边界开始。无排版分支仍在 finalize 注册本次 family 并等待。一个宿主后续改目标语言会补注册另一套，并复用 platform 既有 pending map。原文字/必需字体失败仍传播，不用系统字体替代；未请求字体的失败自然不再阻塞本次 job，等真正需要该 family 才下载。

收益假设为少做未使用的 FontFace 解析/add 及其造成的回调阻塞。诊断的未选字体 face-load 约 100–156 ms，某异常样本更高；其中是否处于关键路径仍需组合 trace。不能承诺将注册窗口整体扣除，也没有证据单独补齐 786 ms 总缺口。

CPU 检查新增 family 选择、同宿主目标变化/去重、配置未知、三个 debug 早等待和字体 observer 异常/失败。相关 **37 测试**、extension/tests/benchmark typecheck 通过。

编写但未在本子任务运行的 native 质量检查：

```powershell
npx tsx benchmark/perf/src/check-cold-start-selected-fonts-browser.ts --browser-executable=<主控选定的Chromium路径>
node benchmark/perf/src/check-cold-start-host-init-probe.mjs
```

该检查在独立页面比较 both/selected，使用相同两套字体及实际 drawTypeset，覆盖 CN/TW/ja、横竖排、CJK/假名/拉丁、括号/省略号/全角符号、稀有字/emoji fallback，debug 两套。核对整画布 RGBA SHA、measureText 字宽/边界/字体边界，必须逐项一致。真正扩展还须核对原图全 RGBA、文本/置信度/区域/shape/provider 与原终点计时；模板/CTC/传输收益均不能与本项重复扣账。

主控随后串行运行该原生字体 gate：Chromium 151，`zh-CN/zh-CHT/ja × 普通/debug` 共 6 组全部通过，横竖排整画布 RGBA SHA 和 measureText 度量完全一致；普通只注册 1 个 MTX family，debug 2 个。本子任务没有自行运行浏览器或 GPU。

### 组合初始化 trace：关键路径已找到两个调度阻塞

主控提供 `.tmp/cold-budget/1790850878014-results.json` 两份带 probe 组合诊断。`all-direct-latefonts` visible **6068.8 ms**，`all-direct-latefonts-binary-prefetch-nofence-reuse` visible **4294.9 ms**，最终 RGBA SHA 相同。它们是单轮诊断，包含 marker/网络观察成本和不同组合，**不是正常性能 A/B**；不能认领 1774 ms 改善，也不替换此前 3631.9 / 2651.7 ms 的正式中位数。

以下只拆较快样本，起点为用户触发；各 realm 用 `performance.timeOrigin + startedAt` 对齐，四 Session 实际各创建 **1 次**，全部 webgpu，参数与必要阶段同 key：

| 项目 | 实际起止（触发后 ms） | 解释 |
| --- | ---: | --- |
| offscreen 建立 | 15.7 → 50.7 | 与取图 8.3 → 456.3 重叠 |
| Worker init | 52.4 → 106.8 | 54.4 ms，只保存路径、JS 初始化，尚未 WASM ready |
| detector 模型预取 | 107.1 → 267.7 | 94,863,096 B；Session t798.9 真正取模型时 headers/body 为 0 ms，缓存已复用 |
| detector availability | 109.8 → 429.6 | 319.8 ms，预取全隐藏在这个窗口 |
| detector ORT create | 429.6 → 1157.3 | 727.7 ms，嵌套含 WASM/device/graph，不可与它们相加 |
| WASM instantiateStreaming | 444.5 → 503.8 | 59.3 ms |
| instantiate 后到 ORT adapter | 503.8 → 742.9 | 239.1 ms，包含 Emscripten/ORT runtime 初始化等尚未单独标记的工作 |
| ORT adapter / device | 742.9 → 763.6 / 774.3 → 797.9 | 20.7 / 23.6 ms；随后约 358 ms 模型复制、建图等 |
| bubble Session 往返 | 1158.9 → 1398.0 | 239.1 ms；body 22.6 ms，其后的同步创建占用同 Worker |
| detector RPC 已 post → GPU preprocess 开始 | 1271.1 → 1400.1 | **129.0 ms** 位于 bubble 图创建窗口内；不是 detector 计算或取图 |
| detector 首次 readback | 1500.8 → 1796.3 | 295.5 ms；实际执行也包含未完成 GPU 工作，不等于纯 1.8 MB 拷贝 |
| OCR availability | 1506.1 → 1794.6 | 288.5 ms，与首 readback 几乎同终点；支持测试既有 device 复用，不能只凭重合断定 Chromium 内部机制 |
| OCR Session 往返 | 1398.7 → 2502.3 | Worker ORT create t2143 已结束，host 延迟了约 **359 ms** 处理回复 |
| TW face-load / CN face-load | 2135.3 → 2291.0 / 2291.3 → 2502.2 | 156 / 211 ms 两个连续 host longtask；同步解析把 OCR 和 bubble 回调一起延迟 |
| bubble run 实际结束 → host 回复 | 2181.4 → 2502.9 | 321.5 ms，主要是同一字体阻塞，不能再与 OCR 延迟相加 |
| inpaint Session 往返 | 2553.6 → 2714.2 | 160.6 ms，已创建同 Session；首 OCR RPC t2628.7 已发，但 Worker ORT run t2714.3 才开始，约 **86 ms** 等候 |

字体 CN 的 body 等待 t2117.8→2291.3（173.5 ms）中横跨 TW 的 face-load。这再次说明 body await 包含同线程回调排队，不能把全段当磁盘成本。font fetch 126 ms 也横跨已有 307 ms host longtask 的尾部，不能直接计为网络变慢。这个冻结产物还没有新增 `font.add` marker，不能把 residual 推定为 add。

该样本检测开始前 1158.5 ms，detect/bubble/OCR 共 1767.9 ms，之后到排版完成约 840 ms，PNG/回传/display 约 528 ms；这些才可作为按进度划分的互不重叠关键路径组。Session、字体、readback、precompile 内部墙钟区间彼此重叠，不能用它们的简单总和编造减半预算。

这两条程序争用都在普通 visible offscreen 中发生，当前 COI=false，WASM 单线程；没有稳定整秒等待或 hidden 页面证据。全机 CPU/内存仍存在波动，但它不足以解释或否定上述明确的 RPC/同步任务边界。

### 候选：真实检测 RPC 先提交，再早加载后续 Session

默认关闭 `__shinobuColdStartSessionsAfterSubmit=true`，仅与 `__shinobuColdStartEarlySessions=true` 一起生效。host 仍立即 `getSession('detector')`；取得 WebGPU detector Session 后，后台 bubble→OCR→inpaint 链先等真实 detector 图像 RPC 已成功 post，再按旧顺序创建。没有额外推理，也没有新 Session key、锁或 provider 参数。

只添加 `ModelRuntime.runImage(..., onSubmitted?)` 可选参数和 bridge 的对应回调，旧调用兼容。桥内只在传入回调时临时观察它拥有的 Worker 本次同步 post：原 postMessage 成功返回才标记，finally 立即恢复，随后回调并 await 同一真实 pending。Comlink 会将 postMessage 抛错转为 rejected Promise，因此不能仅根据远端方法返回 Promise 就假定发送成功。观察回调抛错被忽略，仍 await RPC，避免遗留未观察的拒绝。

非 WebGPU detector 无 runImage，继续原早加载行为。任务未提交便完成（预检测复用/无排版等）、失败、取消、断连、idle 或 dispose 都会解 gate 并停止尚未启动的后续预加载；已经在创建的 Session 仍按旧 Promise 释放流程等待。必要阶段仍可正常 getSession/retry，不依赖后台预加载成功。

收益假设：避免 bubble 同步图创建抢在首检测的 Worker message 前面。本诊断约 **129 ms** 是可测试的等候窗口；延后创建可能与后续 GPU/CPU 工作争用，不能承诺全部变成最终节省。inpaint 也存在约 86 ms 首 OCR 等候，但它是另一个调度点，本候选未改 OCR/inpaint 顺序，先看测量结果。首 adapter 319.8 ms 不能全部计为跳过 preflight 的收益，ORT 自身仍需冷 GPU/驱动初始化；首 adapter 与 WASM 重叠需要新的内部初始化入口，本轮没有实现。

最小 CPU gate 已运行：

```powershell
npx vitest run tests/runtime/onnxWorkerSubmitted.test.ts tests/runtime/onnxWorkerBridge.test.ts tests/offscreen/pipelineHost.test.ts
npm run typecheck:extension
npm run typecheck:tests
```

**42 测试通过**，包括真实 Comlink endpoint 发送/相同 ImageBitmap transfer、post 错误不触发回调、观察器抛错后 RPC 拒绝仍正常处理，以及 host 顺序、不等待推理输出、无提交完成/失败/取消/idle、CPU provider 兼容。类型检查通过。浏览器 A/B 与完整输出验收由主控统一执行；目前没有本候选性能结论。

### 候选：首次 GPU adapter 请求与 ORT WASM 初始化重叠

随后主控授权对 `onnx-worker.ts` 的 probe/init 区域添加受限实验 `__shinobuColdStartAdapterOverlap=true`，默认关闭。没有调用内部 WASM API，没有修改 ORT 包或自行 requestDevice。

核对安装的 ORT **1.27.0**：`onnxruntime-common/lib/env.ts` 仍声明首次 WebGPU Session 前可设置 `env.webgpu.adapter`（该 API 标记 deprecated，但本版本仍实现）；`wasm-core-impl.initEp` 在 WASM/Emscripten/_OrtInit 完成之后才读取它。JSEP `backend-webgpu.initialize` 使用给定 adapter 的相同 limits/features 描述请求自己的 GPUDevice，之后把 `env.adapter` 改为不可写、不可配置。模型、SessionOptions、float32 运算、device descriptor/feature 选择仍由原 ORT 决定。

flag 启用时，WebGPU probe 只检查 navigator.gpu API 存在：启动一份不等待的 adapter Promise，然后立即允许真实 ORT.createSession 继续初始化 WASM。请求完全使用原 ORT 当前的 `powerPreference='high-performance'` 和 `forceFallbackAdapter`。同一 Worker 并发创建 Session 共享这份 first Promise；有既定 adapter/device 时直接复用。

Promise 得到非 null adapter 后，只在同一个 env 当前仍无 adapter/device、属性允许写入时赋值。拒绝、同步异常、null、已选定/锁定或过晚均不覆盖原状态；真实 ORT initEp 仍可自行请求 adapter，原 provider fallback 仍处理创建失败。观察异常也被捕获，不形成未观察的 Promise 拒绝。此候选的“available”只是让真实创建尝试推进，不能视为提前证明 WebGPU 创建必定成功。

收益假设是让首次 GPU 服务准备与约 300 ms 的本样本 WASM/runtime 初始化重叠，而不是直接删除 GPU 冷初始化。Worker 同步初始化期间即使 GPU 服务已完成，adapter Promise continuation 也可能来不及赶在 initEp 读取 env 之前；此时 ORT 仍会请求第二个同策略 adapter。应同时查看 `adapter-overlap-assigned/unused/failed`、GPU requests 和首次 create 终点，不能只用少了一次 request 推断收益。截止本节仍未有正常浏览器 A/B 结果。

CPU gate 运行实际 Worker `createSession/probe`，只把 GPU 和 ORT 的 WASM/backend 变成受控 deferred mock：

```powershell
node benchmark/perf/src/check-cold-adapter-overlap.mjs
node benchmark/perf/src/check-cold-gpu-availability.mjs
npm run typecheck --workspace=@shinobu/model-runtime
```

全部通过。覆盖默认路径仍等待旧 preflight、并发两个模型只一份提前请求、真实 ORT 创建在该请求 pending 时已开始、相同模型 URL/SessionOptions、forceFallbackAdapter undefined/false/true、没有自建 device、后续 Session 共用 ORT device、null/拒绝/同步抛错后真实 ORT 请求和 WASM fallback、late/readonly adapter、不支持 GPU API、observer 异常。仅主控负责下一次统一 build、同版本 JSEP JS 变体重建、原始输出 SHA/provider/OCR/整图验收和正常性能测量。

### 新 profile 剩余预算：最新正常慢/快样本

主控正常串行结果 `.tmp/cold-budget/1790854168545-results.json` 中，`core-async8-history4-adapteroverlap-workerpng` 新 profile 为 **3505.2 / 3604.5 / 2708.4 ms**，中位 **3505.2 ms**，距原绝对目标 2845.5 ms 还差 **659.7 ms**。缓存新进程中位 **2266.9 ms** 已小于 2332.7 ms 目标。单个 2708.4 ms 样本不能代替新 profile 中位数。三轮整图 RGBA SHA 均与此前基线相同。

比较同一 combo 的 11:30:14 和 11:32:01 正常 raw report，以下互不重叠组以用户触发为起点：

| 关键路径组 | 较慢 ms | 较快 ms | 多出的 ms |
| --- | ---: | ---: | ---: |
| 入口到 detect 开始 | 860.3 | 642.7 | 217.6 |
| detect | 642.6 | 580.1 | 62.5 |
| bubble | 403.7 | 270.4 | 133.3 |
| OCR | 309.5 | 226.4 | 83.1 |
| merge + OCR filter | 13.7 | 9.2 | 4.5 |
| order | 135.9 | 78.6 | 57.3 |
| mask + inpaint 及之间报告 | 589.4 | 431.0 | 158.4 |
| typeset | 40.2 | 25.5 | 14.7 |
| finalize | 244.7 | 160.4 | 84.3 |
| 显示尾段 | 263.3 | 282.1 | -18.8 |

入口差 217.6 ms 中，首 pipeline 事件前 **607.2→364.6 ms**；load **73.9→98.0 ms**，剩余 detector preload **171.8→164.0 ms**。所以入口差主要在首 pipeline 事件之前，不能把全部差认领为 ORT create 节省。正常报告没有 host/runtime init trace，无法进一步把入口拆成 settings/取图/offscreen/Session。

同两轮的 same-worker visible **2310.4→1640.7 ms**，差 669.7 ms，CPU 图像/order/PNG 等阶段也同时变化。已有相同算法、输入、输出证据支持这不是模型/ROI质量或额外全图推理差异；但这些计时并不能确认 Windows CPU 频率、调度/资源负载，或某段初始化造成了全部波动。不能把这些因素当作已查明原因，也不能把快样本当作可稳定获得的预算。实际可删/可重叠工作要从代码和更细 trace 找。

### Adapter 交接：确实出现第二次请求，但本 trace 只占数 ms

质量诊断 `ui-jank-2026-10-01T11-25-05-106Z.json`（visible 2682.6 ms，含 input/output SHA 检查，不作为正常速度样本）对齐后：

- 提前 adapter 请求 **82.9→289.6 ms**，记录 `adapter-overlap-assigned`。
- ORT 自己第二次同 high-performance 请求 **288.6→292.3 ms**，之后 requestDevice **296.9→321.4 ms**。
- WASM instantiate **89.1→146.8 ms**；detector ORT create **83.0→662.1 ms**。

首 Promise continuation 仅迟于 initEp 读取 env 约 1 ms。成功 marker 不代表 ORT 没有先读取空 adapter；这是代码和 trace 一致的具体 race。即使第二个请求完全复用首 Promise，这个样本理论仅省 **292.3−289.6≈2.7 ms**，不能补齐 660 ms。`env.webgpu.adapter` 接受实际 GPUAdapter，不接受 Promise；可靠共享 pending 请求需要短暂拦截同策略 navigator.gpu.requestAdapter。当前没有加该全局 hook，优先验证更大的 host CPU 窗口。

### 候选：版面识别移入已提交 detector Session 的等待窗口

默认关闭 `__shinobuColdStartPanelOverlap`。`detectPanels(originalCanvas)` 仅依赖原画布，独立于检测/OCR regions；原图在 order 之前保持不变。本候选提取 `prepareReadingPanels()`，原 scale、灰度、Gaussian、阈值、连通域、panel 过滤全部原样执行。

在 runPipeline preload 先发起同一 `probeRuntime('detector')` Promise，再同步预计算 panels，最后 await 同一 Promise。order 消费这个准确数组，保留 sortPanelsFill、assignPanelIndex、smartSortWithinGroup/simpleSort 全部算法与顺序规则，没有重复读图或新 Worker。undefined 表示未预计算，null 表示原 simple-sort fallback；<=1 region 仍走 sort 原早返回。precomputedDetection 没有 Session 等待可重叠，保留原路径。图像读取错误在 helper 转为原 fallback，不升格为 detector 错误；仍观察已发 probe，并保留原取消检查位置。

最新正常 remaining preload **164–174 ms**，order **79–136 ms**，具备遮盖 order 的墙钟窗口。若 host/Worker CPU 争用明显，收益会缩小或反向；无文本/仅一 region 原先不会 detectPanels，提前计算将增加工作，已明确留作实验风险。计时仍从用户触发，总墙钟必须下降才能认领收益，不能只因 order 栏变短就成功。

CPU gate 已运行，**21/21 tests** 与 image-pipeline typecheck 通过：

```powershell
npx vitest run tests/pipeline/orchestrator.test.ts tests/pipeline/readingOrder.prepared.test.ts
npm run typecheck --workspace=@shinobu/image-pipeline
```

覆盖真实 panel/region 顺序一致、输入未修改、不再读图、图像异常 null 缓存、<=1 region、默认不提前、getSession 先调用且只复用同 probe、失败模型仍观察、取消、预检测路径。本子任务未运行浏览器/GPU；实际输出与正常 A/B 由主控执行。

异步边界需单独限定：registry.getSession 在查 pending/cache 之前先 await readModel，bridge.createSession 又 await getProxy。因此仅调用 probeRuntime 不能保证 Comlink RPC 已提交。当前 core/all 有 overlap/earlySessions，PipelineHost 构造就提前 getSession；QA 实际 t81.6 ms 已 post detector create，t83.0 ms Worker 开始，runPipeline preload t约381 ms 时已有相同 cacheKey 的创建在 flight。该组合有真实窗口；单开 paneloverlap 可能反而让 CPU prep 抢在 createSession post 之前，延后启动。

trace 应核对 host 的唯一 `worker.rpc-start(createSession, detector)` 早于 preload/prep 同步段，Worker 的 ort-create/model-prefetch/WASM/device 在这段推进，prep 是否延迟 host Session reply 或 detector run RPC。现有 host `port.send(progress, preload)` 后 longtask 可以界定较粗的窗口，与同一 turn 内 imageToCanvas 等同步工作不能完全分开；content jank 的进度起点又包含 Port 延迟。要精确证明遮盖 100 ms，需要独立 prep marker 或 CPU call stack，以及对应正常 visible 总时间下降。已缓存 same-worker Session 没有模型加载窗口，提前计算通常只能移账；不能把 order 栏减少直接称作提速。

### 候选：相同字体字节经 Blob URL，允许 Chromium 后台解析

同一 QA trace 中，CN 字体 body **1368.4→1383.7 ms**，face-load **1383.7→1524.1 ms** 与 host longtask **1383.6→1523.6 ms** 重合，font.add **0 ms**。bubble Worker 实际结束 **1404.8 ms**，host RPC 回复 **1524.3 ms**：约 119.5 ms 等候与这一字体同步任务重合。它是明确 host 阻塞证据，不能与 OCR/inpaint 相同回调阻塞再重复扣账。

核对精确 Chromium **151.0.7922.34** 源码：binary FontFace 构造调用 InitCSSFontFace(data)→BinaryDataFontFaceSource→FontCustomPlatformData::Create，解析发生在调用线程。[FontFace 入口](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/renderer/core/css/font_face.cc)、[binary 字体源](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/renderer/core/css/binary_data_font_face_source.cc)。

URL 字体走 FontResource，BackgroundFontProcessor 的 OnDataComplete 将 DecodeFont 交给专门的后台字体线程，完成后主线程接收已解码对象；后台 response processor 默认启用。[FontResource 实现](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/renderer/core/loader/resource/font_resource.cc)、[feature 默认值](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/common/features.cc)。

关键限制是 BackgroundURLLoader 仅接受 GET HTTP/HTTPS/Blob URL，直接 chrome-extension 字体 URL 不进入该路径。因此本候选保持原 fetch/arrayBuffer，改成同字节 Blob URL 后再 FontFace.load。[精确版本 URLLoader 条件](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/renderer/platform/loader/fetch/url_loader/background_url_loader.cc)。这是允许走后台路径的源码依据，是否在真实 offscreen 确实采用后台解码还须 host trace 验证。

默认关闭 `__shinobuColdStartFontBlobUrl`，仅改 browserPipelinePlatform.registerFont 的 FontFace 构造位置。字体路径、字节、family、variable descriptors、字体权重/度量/glyph/fallback 链不变，仍 await Face.load 后 add，pending 去重不变；finally revoke Blob URL。URL/CSP/API/构造或加载失败时，退回同一 ArrayBuffer 的原 FontFace，不改用系统字体，原二进制错误继续传播。注册原来就属于宿主全局 pendingFonts，job 取消不取消 shared font load；本候选沿用这一生命周期，异步加载无论成功或失败均释放新 URL。

源码和实际产物 manifest CSP 均仅有 script-src/worker-src/object-src，没有 font-src/default-src 限制。本轮不修改 CSP。新增的原生 gate 使用 actual browserPipelinePlatform、built manifest 原 CSP header 和 self 模块脚本，`--font-blob-url` 时比较 selected/binary 与 selected/blob 的六组横竖排 RGBA SHA/measureText，并要求真实 blob loads=1/2、fallbacks=0。真正 extension 路径仍须主控实际 trace 与整图验收，不能以普通 HTTP 页面替代。

待测潜在窗口是 **0–140 ms** 左右的 host 阻塞，而非消除字体解析的总 CPU 成本。Blob 封装及加载有额外瞬时字节存储和调度成本；后台解码也会争用 CPU。正常速度只能以组合 A/B 的 visible 中位判断，不能预先认领该窗口。

主控随后串行运行 `--font-blob-url` native gate：精确 Chromium 151，CN/TW/ja × 普通/debug **6/6 全部 RGBA SHA 和 measureText 度量一致**；真实 Blob loads 普通 1/debug 2，binary fallback 0，使用实际 manifest CSP 的页面加载通过。这仍是原生字体质量验证，实际扩展 host 是否消除同步任务及正常速度须继续测量。

本子任务 CPU font gate **7/7** 全过，涵盖默认 source/descriptors/去重/observer/404、相同 Blob 字节与 family/descriptors、pending 时不早 revoke、URL load/构造失败 finally 清理并回原 binary、原 binary 错误传播和 Blob URL API 缺失。最初 4 个新 mock 因替换全局 URL 为普通对象而使 Vitest 的 new URL 失败，已改成保留原构造器的 subclass，仅覆盖 Blob URL statics；没有因此修改产品代码。extension/tests/benchmark typecheck 全过。

```powershell
npx vitest run tests/shared/browserPipelinePlatform.test.ts
npx tsx benchmark/perf/src/check-cold-start-selected-fonts-browser.ts --font-blob-url --browser-executable=<主控Chromium151路径>
```

### 真实扩展 QA：panel 和 Blob 字体的等待窗口已验证

主控随后提供 `.tmp/cold-budget/1790857001697-results.json`，实际 Chromium **151.0.7922.34** 扩展、全新 profile 的两条质量诊断。两者均启用 core、adapteroverlap、workerpng、autolayout、paneloverlap、fontblob、imgblob、maskpack、ctcseed 及 detector/input SHA gate，只有第二条额外启用 writeupload；本组 variant **没有 hist**。原始报告分别是 `ui-jank-2026-10-01T12-16-57-330Z.json`、`ui-jank-2026-10-01T12-17-07-545Z.json`。

| 项目 | 12:16:57，无 writeupload | 12:17:07，有 writeupload |
| --- | ---: | ---: |
| visible，用户触发至显示结果 | 3479.3 ms | 2419.7 ms |
| total，用户触发至 pipeline complete | 3227.5 ms | 2238.6 ms |
| detector create RPC 实际 post | 69.1 ms | 57.6 ms |
| Worker detector ORT create 起止 | 71.3 → 945.6 ms | 59.6 → 654.2 ms |
| host preload progress 实际发送 | 501.6 ms | 381.5 ms |
| 包含预计算的 host longtask | 470.6 → 835.6 ms | 380.6 → 616.6 ms |
| host detector create 回复 | 945.7 ms | 654.3 ms |
| 后续 order 阶段 | 0.6 ms | 0.3 ms |
| Blob FontFace 构造 | 0.2 ms | 0.2 ms |
| Blob FontFace load 起止 | 1789.7 → 2010.3 ms | 1342.9 → 1519.4 ms |
| bubble Worker readback 完成 → host RPC 回复 | 1817.3 → 1817.8 ms | 1356.3 → 1356.5 ms |
| host typeset progress 实际发送 | 2925.6 ms | 2049.3 ms |

所有时点均按用户触发对齐：host 用 `absoluteStartMs`，Worker 用该记录的 `timeOrigin + startedAt`。没有把 content 收到 progress 的时点当宿主计算起点。

**Panel 的调度成立。** 两条 detector create 都在 preload 之前数百 ms 已真正 post，同一 Worker 仍在创建 Session。源代码在 host preload progress 之后同步执行 prepareReadingPanels，返回后才 await detectorProbe；所在 task 分别在 t835.6 / t616.6 已结束，距 Session 回复还有 **110.1 / 37.7 ms**，回复又只比 Worker 完成晚约 0.1 ms。这证明本组合中的预计算没有挡住 Session 回复，后续 order 消费缓存结果。没有单独 panel marker，365 / 236 ms longtask 还包括之前同 turn 的图片和其它同步工作，不能把整段全部计为 panel；也不能直接把 order 降到 0.6 / 0.3 ms 就认领最终 visible 收益。无 earlySessions 时可能延后实际 post、同 Worker Session 已缓存时只有阶段转移、无文本/单 region 的额外开销等原风险仍成立。

**字体阻塞已经移出这条 bubble 回复路径。** Blob 构造仅 0.2 ms，load 异步窗口为 220.6 / 176.5 ms，binary fallback 均为 0。bubble 的 Worker 回读完成后 **0.5 / 0.2 ms** host 就收到回复，此时字体还没有加载好；旧 ArrayBuffer 样本中的约 119.5 ms 同步字体等待在这里消失。加载期间 inpaint 创建与 OCR 也能推进：第一条 OCR run t1989.8 开始，字体 t2010.4 add；第二条 OCR run t1462.4 开始、第二次 run t1514.4 开始，字体 t1519.4 add。字体注册完成距排版还有 **915 / 530 ms**，本组不产生排版前字体等待。现有 host trace 无 Chromium 内部线程栈，足以确认没有旧连续 FontFace 同步阻塞，但不单独证明 Chromium 实际后台线程名称或删除总字体 CPU 成本。

仍有明确的其它 host CPU 回调等待。OCR Worker Session 完成 t1642.9 / t1264.0，host 回复到 t1775.0 / t1328.6，差 **132.1 / 64.6 ms**；与 detector 后处理、bubble 输入准备所在 longtask t1462.6→1774.6 / t1114.6→1327.6 重合。该段发生在 Blob FontFace 构造之前，不能归因字体。第一条 inpaint Session Worker 完成 t1966.8、host 回复 t1990.2，约 23.4 ms 差也在 bubble 后处理/OCR 准备 longtask 内。它们是同一 CPU 任务阻塞异步回调的证据，回复延迟与该任务持续时间不能重复相加作优化预算。

四模型的 host createSession 和 Worker ort-create-session 均各 **1 次**；detector key 为 basic + useOrtModelBytesForInitializers=true，其余 default；preferred 都是 webgpu/webnn/wasm，最终 provider 全 webgpu，与该冻结组合的必要阶段一致。第一条 adapter 提前请求 t71.1→237.3 后赋值，未出现第二请求；第二条 t59.4→267.3，ORT 仍在 t266.3→267.3 发出约 1 ms 的第二请求。这再次确认 race 存在，当前数据没有显示它能贡献数百 ms。

两条最终输出都是 2921×4096，完整 RGBA SHA 为 `d3bd5084867c64501ac615d6baacb8cb31ee38f6b93af28cb7ce78f2d1d8ba97`；输入 `[1,3,1024,1024]` 的 SHA 及 detector 的 blk/seg/det 三个 FP32 输出 SHA 逐项完全一致，shape/字节数一致。它们验证当前组合保持本样本的输入、检测原始输出和最终图像。

**速度仍待正常多轮 A/B。** 2419.7 ms 这个 QA 单样本低于 2845.5 ms 绝对目标，但另一个 3479.3 ms 仍高于目标，且两条均包含验证与 init probe。detector create 874.3→594.6 ms、bubble 214.3→132 ms、OCR 348.7→244.7 ms、mask 319.5→214.9 ms、inpaint 356.3→193.9 ms、finalize 234.5→150.6 ms 都一起变化，差别早于以及跨越 writeupload 所改的 buffer 上传点；不能把约 1059.6 ms visible 差归因该开关，也不能宣称全新冷启动中位已减半。本次仅只读分析与报告更新，没有增加 source、构建或运行新的 CPU/GPU 检查；最终预算以主控随后同冻结产物的 3 轮正常 visible 中位为准。

### 后续预算：检测遮罩的 48 MB 读写往返

主控随后完成正常 18 报告，汇总 `.tmp/cold-budget/1790857271448-results.json`：全组合无 writeupload 首次 visible 为 **3152.896 / 3285.333 / 2481.144 ms**，中位 **3152.896 ms**，距绝对目标 2845.5 ms 还有 **307.396 ms**；缓存重启中位 **2159.56 ms** 已低于 2332.7 ms。writeupload 首次中位 3205.325 ms、缓存重启 2110.81 ms，这组不能证明 writeupload 带来首次提速。以下新候选尚未经过正常速度 A/B，预算不重复认领已重叠的字体/panel 工作。

上述两条实际 init QA 把检测 RPC 回复后至 bubble progress 的同步后处理约束为 **193.8 / 139.4 ms**，随后 bubble progress 至 runInference 真正 post 为 **116.5 / 73.0 ms**。OCR Session 回复的 132 / 65 ms 延迟被这些相同 CPU 段覆盖，不能另加一次。源码明确存在一个原尺寸检测遮罩的全图往返：`scaleMaskToOriginal` 先按原 imageSmoothing 放大灰阶画布，再 getImageData 读约 **47.9 MB**，遍历 **11,964,416 px** 按 `data[p] > 127` 二值化，最后 putImageData 写约 47.9 MB。先前 maskpack 只压缩了 JS store 数量，仍保留这次读回和写回。当前无子阶段时线，不能把全部 139–194 ms 都当此往返成本。

新增默认关闭 `__shinobuColdStartMaskNativeThreshold`。`pipeline/image.ts` 的小 helper `tryNativeOpaqueMaskThreshold(source, platform): Canvas | null` 只处理调用者已生成的 **opaque、R=G=B、sRGB、unorm8** 画布；不读取原彩图、不融合插值、不改灰阶或缩放。source/target 的 getContextAttributes 必须明确为 sRGB/unorm8；未知/P3/float16 回原路径。target 使用 willReadFrequently=true，与原 CPU Canvas 选择一致，在新画布 1:1 draw 原已量化画布并用 contrast(100000%)，随后恢复绘图状态。原 source 保留，filter 不支持、拒绝赋值、创建/绘制失败都清理新 target 并返回 null，继续原 packed threshold；新 helper 不运行模型。

对于每个整数灰阶 v，原生 contrast 的函数是 `1000 × (v/255 − 0.5) + 0.5`，v≤127 裁到 0，v≥128 裁到 1，alpha 不变；滤镜函数在 sRGB 运算。[Filter Effects contrast 定义与 sRGB 规定](https://drafts.csswg.org/filter-effects/#contrastEquivalent)、[Canvas filter 与 backing-store 属性](https://html.spec.whatwg.org/multipage/canvas.html#dom-context-2d-filter)。此等价限定于已有 8-bit 量化结果；直接对放大 draw 加 filter 会改变插值前后的处理顺序，因此本候选保留原放大画布。opaque 灰阶来自现有 mask canvas 的 RGBA 生成代码，不能把 helper 用于彩色或半透明画布。

onnxDetect 已接入；mask toMaskCanvas 由 pixel 子代理在相同缩放后接入，共用该 helper。额外瞬时 native target 约 47.9 MB，可能导致内存/调度开销；候选可测试的收益假设约 **50–100 ms**，不能保证或直接从中位扣除。新增少量 init observer markers：detector.ctd-regions、detector.mask-scale/read/threshold/write、mask.native-threshold，用于区分 JS region 工作、原生缩放、读回、阈值、写回及新路径；observer 异常仍被忽略，不扩展运行时调度框架。

本子任务最小 CPU lifecycle gate **9/9 通过**（Vitest 总执行 202 ms），覆盖默认关闭、源/目标色彩属性限制、1:1 独立 target、context 状态恢复、静默拒绝 filter、draw 异常、失败 target 释放、source 保留与 observer 抛错。

```powershell
npx vitest run tests/pipeline/nativeMaskThreshold.test.ts
npx tsx benchmark/perf/src/check-native-mask-threshold-browser.ts --browser-executable=<主控Chromium151路径>
```

第二条 native gate 由主控串行运行，本子任务未运行浏览器或 GPU。脚本编译实际 helper 和实际 detector scale 函数；检查所有 0..255 灰阶（含 127/128 边界）、软件/默认 source Canvas、12 组固定随机 binary mask 放大（含 730×1024→2921×4096）、每个 RGBA 字节、alpha 必须全部 255、source 不变；要求 marker 确认 native 真正成功，不能让静默 fallback 伪装通过。还需要实际扩展检测原始输出/完整 RGBA 和正常全流程 A/B。若 native 任一像素不同，立即否决候选，保留原 CPU 路径。

主控已串行运行该 gate：精确 Chromium 151 的 **14/14 case** 全部通过，nativeSuccess=14，包含两种 source Canvas 的原图尺寸缩放；每个 RGBA 字节一致、alpha 全 255、source 不变。复核实际 downstream：两个接入点原放大 out 本来就是 willReadFrequently=true，原 small binary source 的默认/GPU Canvas 仍先走原 CPU 放大 draw；返回 native target 同为 sRGB/unorm8/CPU，没有换后续插值后端。refinement.readBinaryMask 仍在 CPU context 做原 smoothing/downscale/>0；inpaint preprocess mask 仍用原 CPU draw/>127，最终 readMaskBinary 的 direct/非 direct 数学不变。helper save/restore 也保留 filter:none、smoothing:true、source-over 默认状态。此结果验证原生整数滤镜和 1:1 blit 等价，实际扩展最终输出、两个集成点和正常速度仍待主控验收。

早加载 Session 的争用仍可单独测。该两条 QA 的 bubble create 分别覆盖 detector run 已 post 至 Worker preprocess 开始的 **98 / 135 ms** 窗口，但相同安排也隐藏 OCR/inpaint 创建；没有 nosessions/aftersubmit 的同组合正常 A/B，不能把这个排队窗口完整列为净收益。Panel 在 cached/same-worker 流程仍会同步计算，主控新 warm report preload 290.9 ms 确认它不是免费；该轮优先完成上述原生往返候选及 pixel 的独立 source 预读候选，未进一步改 readingOrder 算法。

### Native threshold 实际质量通过，全流程收益未通过

主控随后提供 `.tmp/cold-budget/1790859690617-results.json`，实际扩展三条 QA：base / threshold / threshold-preread。原输入和 detector 三个 FP32 原输出 SHA、OCR confidence/layout、最终整图 RGBA 都完全一致；provider 无回退、device lost=false、errors=0。Native 两组在 detector 放大 mask 和 refined mask 各 **1 次 success**，共 **2 次成功、0 fallback**。Native gate 的 14 组等价已在实际流水线得到本样本的验证。

| QA 项目 | base | threshold | threshold-preread |
| --- | ---: | ---: | ---: |
| visible，用户触发至显示结果 | 3332.4 | 2465.7 | 2566.3 |
| detector run RPC 时长 | 427.6 | 470.8 | 398.2 |
| 原 detector read / threshold / write API 段 | 75.7 / 30.5 / 6.3 | — | — |
| 新 detector native helper API 段 | — | 28.1 | 30.0 |
| 新 refined-mask native helper API 段 | — | 17.1 | 17.2 |
| bubble Worker ORT run | 36.2 | 83.5 | 151.2 |
| bubble Worker 完成至 host 回复 | 0.5 | 0.4 | 0.3 |
| OCR Worker create 完成至 host 回复 | 3.0 | 0.2 | 0.1 |
| inpaint Worker create 完成至 host 回复 | 0.1 | 46.3 | 0.0 |

单位均为 ms。base detector 同步 read+threshold+write 合计 112.5 ms，新 helper 同步段 28.1 ms，**API 段缩短约 84.4 ms**。这仅是测得的 API 边界变化，不能称完整 raster 工作消失；下面的精确 Chromium 代码说明部分成本可以移到任务结束。QA visible 少 766–867 ms 的差值也不是此局部段的净收益：Session 初始化、Worker/GPU 等待、入口和其它 CPU 阶段一起变化，且这些 QA 携带 init/质量探针。

这次 OCR Session 没有重现旧报告的 65 / 132 ms host 回调延迟；base/threshold/preread 的 Worker 完成时点约 1705.2 / 1144.9 / 1347.0 ms，host 分别只晚约 3.0 / 0.2 / 0.1 ms。preread 组 inpaint 创建实际 **1365.5→1486.1 ms**，与 bubble ORT run **1348.3→1499.5 ms** 重叠；它证明两种初始化/执行在同一运行时重叠，未证明多出来的 bubble run 毫秒全部来自 Session 争用。主控已安排独立 late-inpaint 调度对照；本代理不修改 host 的对应 guard。

### 27 份普通报告：按缓存状态和逐轮比较抵消

同一冻结产物、同一 110 个模板，普通反向轮次数据 `.tmp/cold-budget/1790859883194-results.json`。每组 3 次全新 profile、3 次同 Worker、3 次保留缓存新进程；第 1 轮反转 variant 顺序。所有 27 份最终 2921×4096 RGBA SHA 都是原 `d3bd5084867c64501ac615d6baacb8cb31ee38f6b93af28cb7ce78f2d1d8ba97`。

| visible 中位，ms | base | threshold | threshold-preread | 当前绝对目标 |
| --- | ---: | ---: | ---: | ---: |
| 全新 profile | 3174.5 | 3356.4 | 3284.7 | 2845.5 |
| 同 Worker | 2580.7 | 2383.3 | 2343.5 | 不用它替代第一次使用 |
| 保留缓存新进程 | 2186.8 | 2179.9 | 2147.6 | 2332.7 |

当前 base 真正首次中位仍差 **329.0 ms**；Native 两组没有稳定全程提速。缓存重启三个组都已达到该状态的目标。本轮禁止把不同缓存状态互相作为基线，也不按单个最快样本宣布减半。

全新 profile 的实际关键阶段如下。入口是 content detect 起点减 pipeline 的 load/preload，包含 source RPC、传输及入口任务；没有把先行模型加载再次加上。load/preload 的后台重叠和 content 进度投递意味着它是剩余入口预算估计，并非独立 CPU 计时。

| 轮 / variant | visible | 剩余入口 | detect | bubble | OCR | mask | inpaint | finalize |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 0 base | 3341.9 | 517.2 | 679.1 | 234.3 | 335.2 | 319.2 | 264.9 | 225.5 |
| 0 threshold | 3391.2 | 486.5 | 536.7 | 446.3 | 313.8 | 255.8 | 375.2 | 241.1 |
| 0 threshold-preread | 3284.7 | 572.9 | 533.9 | 449.4 | 300.6 | 180.5 | 278.0 | 269.4 |
| 1 base | 3174.5 | 528.0 | 578.1 | 232.7 | 299.9 | 333.1 | 250.2 | 240.0 |
| 1 threshold | 2574.5 | 381.0 | 490.9 | 343.6 | 208.3 | 169.0 | 256.6 | 155.3 |
| 1 threshold-preread | 3519.3 | 856.7 | 604.1 | 448.7 | 262.2 | 176.7 | 272.0 | 240.8 |
| 2 base | 2435.5 | 299.5 | 589.1 | 138.1 | 234.9 | 186.4 | 209.7 | 156.6 |
| 2 threshold | 3356.4 | 522.0 | 558.6 | 427.6 | 287.5 | 232.7 | 338.2 | 233.4 |
| 2 threshold-preread | 2639.7 | 339.0 | 492.6 | 246.1 | 227.8 | 203.0 | 271.1 | 241.8 |

第 0 轮 Native detect **−142.4 ms**、mask **−63.4 ms**，被 bubble **+212.0 ms**、inpaint **+110.3 ms** 等抵消，全程反增 49.2 ms。第 1 轮入口/OCR/PNG 同时更快，Native 的 600.0 ms 总改善不能全部归它。第 2 轮 base 本身已在 CPU 多段的快峰，候选变慢亦跨多个阶段。以下更一致的保留缓存新进程对照值得进一步定位，不能一概称全局频率波动。

| 相对本轮 base，ms | visible Δ | detect Δ | bubble Δ | OCR Δ | mask Δ | inpaint Δ | finalize Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 缓存 0 threshold | +26.2 | −5.4 | +90.2 | −7.8 | −49.0 | +29.5 | −7.9 |
| 缓存 1 threshold | +129.7 | +30.0 | +67.8 | −15.0 | −37.4 | +31.7 | +6.7 |
| 缓存 2 threshold | −27.4 | −60.9 | +90.1 | −27.3 | −56.5 | +34.7 | +3.5 |
| 缓存 0 threshold-preread | −14.3 | +72.6 | +87.4 | −13.2 | −98.9 | −8.5 | −1.7 |
| 缓存 1 threshold-preread | −1.4 | +21.4 | +69.4 | −8.5 | −80.5 | −5.5 | +3.5 |
| 缓存 2 threshold-preread | −51.2 | +32.3 | −6.3 | −30.6 | −80.1 | −1.0 | +3.6 |
| 同 Worker 0 threshold | +144.7 | −61.7 | +88.7 | −7.6 | −30.1 | +117.6 | +22.2 |
| 同 Worker 1 threshold | −720.7 | −133.7 | −22.1 | −67.7 | −135.1 | +4.3 | −77.0 |
| 同 Worker 2 threshold | −197.5 | −73.3 | +11.1 | −13.6 | −95.1 | +3.8 | −19.7 |
| 同 Worker 0 threshold-preread | −172.8 | −46.2 | +9.1 | −8.6 | −113.4 | +14.4 | −0.4 |
| 同 Worker 1 threshold-preread | −155.7 | −31.5 | +29.7 | −16.6 | −105.6 | +40.4 | +19.1 |
| 同 Worker 2 threshold-preread | −237.2 | −32.9 | +0.1 | −7.7 | −132.1 | −6.4 | −24.4 |

普通 27 份的 **workerCalls 均 0、host-init-trace/runtime-phase-batch 均 0**，因此不能从此组确认具体 Session 创建、shader compiler、GPU readback 或 TaskObserver flush 耗时。precompile 只是状态快照：全新组按轮 base 为 987.5 / 1253.2 / 1049.5 ms，threshold 为 1426.6 / 831.7 / 981.6 ms，preread 为 951.9 / 652.0 / 1038.0 ms，count 均 110；同 Worker 报告逐项重复前一次的相同数值，不能解释成又编译了一遍。缓存新进程没有此记录，含义是未记录，不能称编译耗时为零。这些数值没有精确起止，不与 pipeline 阶段相加。整段 CPU busyPercent 不反映瞬时核频率，也不能用它替代关键路径因果证据。

### Chromium 151 的 CPU Canvas 同样延迟 raster

已核精确 **151.0.7922.34**：CanvasRenderingContext2D.GetOrCreatePaintCanvas 返回 recorder 的 recording canvas；bitmap/非加速 shared-image provider 均在 Flush 时 ReleaseMainRecording→RasterRecord→SkiaPaintCanvas.drawPicture，并非每次 drawImage 同步完成所有像素计算。[Context recording/flush 实现](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/renderer/modules/canvas/canvas2d/canvas_rendering_context_2d.cc)、[CPU bitmap 和 shared-image raster 分支](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/renderer/platform/graphics/canvas_resource_provider.cc)。willReadFrequently=true 选 CPU，并没有禁用 recorder。

getImageDataInternal 先 FinalizeFrame；source Canvas 被其它 drawImage 使用时 GetSourceImageForCanvasInternal 调 GetImage，GetImage 同样 FlushCanvas。[getImageData 入口](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc)、[source Canvas snapshot 入口](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/renderer/core/html/canvas/html_canvas_element.cc)。原 helper 对 source 做一次 draw 会触发原放大画布的 snapshot；目标上新 filter 仍可仅记录下来。后续 refine.readBinaryMask 和 inpaint.mask preprocessing 都有相应 draw/read 消费点，图像等价不代表计时归属不变。

还有更早的执行边界：CanvasRenderingContext.DidDraw 注册当前线程 TaskObserver，DidProcessTask 在 script task 结束时无条件调用 FinalizeFrame；这一入口不要求 Canvas 已连接或可见。[任务结束刷新实现](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/renderer/core/html/canvas/canvas_rendering_context.cc)。所以同一任务里先产生 native detection mask，再实际 post bubble RPC 并 await，可以在任务结束才支付 filter CPU；refined mask 也可在 post inpaint 后才 raster。bubble 本身只用原图，不直接消费 detection mask，不能误写成 bubble preprocessing 主动读取了该 mask。**这是基于源码与阶段形态的抵消假设，尚无普通 trace 的 raster 调用栈证明**；它为 cached bubble / inpaint 同时变慢提供具体可检验解释，不能认领全部差额。

### 新默认关闭实验：原图下载 Blob，删除剩余一次 Base64 往返

已复核取图→content→Port→host：background imageDownloader 原来总在已校验 arrayBuffer 后 arrayBufferToBase64；content createRuntimeImageDownloader 总做 base64ToBlob（atob→JS 逐字节→Uint8Array→Blob）。现有 binary Port 只消除随后的第二次编码，source RPC 这一层仍保留，因此新候选不重复算已有收益。QA 的 source sendMessage 整段约 **423.8 / 269.5 / 292.6 ms**，包含 fetch、DNR/queue、序列化和 content 任务；不能把 400 ms 全部视为 Base64。更早的 content longtask 发生于 download reply 之前，当前无内部 marker，也不能据此认领全部长任务。

新增 `__shinobuColdStartDownloadBlob`，默认 false，限定 shared/messages.ts、background/messages/router.ts、background/images/imageDownloader.ts、content/core/translation/imageTranslationExecution.ts。复用同一请求的 1 字节 Blob probe 和现有 probe MIME，不另建 capability 框架。router 只有 flag=true、真正 Blob、size=1、MIME 匹配才将 preferBlob 传给 downloader；旧 JSON serializer 交来 {}，自然走完整原 Base64。下载仍同 fetch options（credentials/cache/referrer/DNR/redirect）、同 arrayBuffer、格式嗅探/URL 边界、超时和串行队列；同字节以嗅探 MIME 构造 Blob，返回 base64 空串和可选 blob。Blob 构造不可用/失败回原编码；content 只接受非空且 MIME 匹配的真 Blob，若异常回包 serializer 丢 Blob 且 Base64 为空，以不带 probe 的原请求重试一次，避免空文件。abort 检查在原回包后及重试前后，原来源错误分类保留。

没有图片级结果 cache/inflight dedup：background/index 直接引用 downloader.download，SerialTaskQueue 只逐调用执行；fetch 的 HTTP cache 保持。preferBlob 存于每个排队 request，native 与 legacy 同 URL 混用不会共享空 Base64 结果，不引入 cache 类。只在现有可选 observer 存在时记录 `image.download-encode`（background）/`image.download-decode`（content），包含 transport/bytes/base64Length/duration，observer 抛错被忽略。Blob 态两者 base64Length=0；**真实速度尚未测**，必须比较这两个局部 marker 和从用户触发计起的 ordinary visible，模型/GPU 加载已重叠的部分不能再算一次。

content sourceReady 后 binary sendInput 不读 arrayBuffer/dataURL，直接传 File；host 只按原 metadata 包 new File([blob])。精确 151 的 File::Create 调 PopulateBlobData，Blob part 走 AppendBlob，后者组合 CloneBlobRemote + offset/length；这不是再做一遍全图 JS 字节转换。[File 构造](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/renderer/core/fileapi/file.cc)、[Blob parts 分支](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/renderer/core/fileapi/blob.cc)、[BlobData 引用组合](https://raw.githubusercontent.com/chromium/chromium/151.0.7922.34/third_party/blink/renderer/platform/blob/blob_data.cc)。新 Blob([arrayBuffer]) 仍需原生字节快照，不能称整链零拷贝；两个 File 包装没有已证实的 50 ms 优化预算。配置读取先 await prepareExecution，之后取图与 Port prepare 已并发，正常 debugLog=false 没有额外诊断日志等待。后续仍不可避免的是同图解码和 panel 原算法，均已有独立优化/测量，不重复认领。

最小 CPU gate **13/13 通过**（tests 本体 26 ms）：默认请求/Base64、真实 probe/源字节/MIME/fetch options、JSON 剥离 probe 一次回退、无效 size/type/non-Blob、bg flag 关闭、只丢 response Blob 的一次原请求回退、同 URL 排队跨 flag 混合调用、不共享结果、Blob 构造失败、inflight abort 不解码/重试、observer 异常。首次 5 个失败是新 test mock 未提供原有必填 AbortSignal，补充 test 后通过，未为此修改产品。未运行新的 build/typecheck/browser/GPU；主控下一次 actual extension 需继续检查 source PNG 字节 SHA、detector/input 原输出 SHA、OCR/layout/最终 RGBA 及普通多轮 visible。此候选预计删除的是一层字符串和 JS 复制，收益未定，不能先用 400 ms 填满当前 329 ms 缺口。

```powershell
npx vitest run tests/background/imageDownloadBlob.test.ts
```

### DownloadBlob 已测实际转换段；普通全程结果仍待主控

主控实际扩展三组 QA `.tmp/cold-budget/downloadblob-lateinpaint-qa-recovered.json`：同 core base、只加 downloadblob、加 downloadblob+lateinpaint，均全新 profile。第三条原 runner 日志名遇 Windows 长路径，原报告已保存并恢复入汇总，后续日志使用短 hash 名；未重跑或重写该样本数据。原文件大小 **7,915,903 bytes**，旧 Base64 长 **10,554,540 chars**；两组 Blob 记录 bytes 相同且 base64Length=0。主控确认全部三条检测输入与 blk/seg/det 原 FP32 SHA、OCR confidence/layout、最终完整 RGBA 完全一致；最终 SHA 仍为原 d3bd…ba97。

| QA 实测，ms | core base | +downloadblob | +downloadblob+lateinpaint |
| --- | ---: | ---: | ---: |
| background image.download-encode | 157.5，Base64 | 1.7，Blob | 3.0，Blob |
| content image.download-decode | 22.8，Base64 | 0.1，Blob | 0.0，Blob |
| content job 开始进度到达 | 301.6 | 163.6 | 171.7 |
| visible | 2805.2 | 2666.7 | 2654.7 |
| detector 阶段 | 634.7 | 527.5 | 724.4 |
| OCR 阶段 | 402.5 | 580.7 | 401.9 |

这次不是 Canvas 仅记录命令的例子：旧 arrayBufferToBase64 和 base64ToBlob 的 JS 字符串/循环已完成在 marker 内；新路径把实际同字节 Blob 构造收进了 1.7 / 3.0 ms，content 无再解码。因此本样本 **约 177–179 ms 的转换段被实际移除/换成更快原生构造**，任务开始进度约提前 **130–138 ms**，不能把两者加在一起。后续模型加载已与取图重叠，移除取图转换并不保证这些 177–179 ms 全在 visible 关键路径上。

三组各只有 1 条且携带质量/init 探针；detector 和 OCR 的波动及初始化调度也有抵消，QA 的 2805→2667/2655 不能宣告普通首次中位已达到 2845.5 ms 目标，也不能单凭最后一条快 12 ms 确认 lateinpaint 有收益。当前可确认的是下载真实转换工作减少、本样本质量保持；普通同冻结产物、正反向多轮的全新/同 Worker/缓存重启结果由主控继续串行测量。本代理此轮只读分析和更新本报告，没有新 source、build、CPU/typecheck 或浏览器/GPU 执行。

### DownloadBlob 普通 3 轮：固定预算初达，仍需同期原版本对照

主控普通 `.tmp/cold-budget/1790862549881-results.json` 共 27 份完成；此组没有 threshold/preread。RGBA 仍全部等于原 d3bd…ba97，主控报告 quality pass。本代理只读重新计算三组缓存状态中位如下。

| visible，ms | core base | +downloadblob | +downloadblob+lateinpaint | 固定目标 |
| --- | ---: | ---: | ---: | ---: |
| 首次轮 0 / 1 / 2 | 2530.3 / 3567.8 / 2505.2 | 2479.5 / 2380.3 / 3235.8 | 2523.6 / 2748.4 / 2259.7 | 2845.5 |
| 首次中位 | 2530.3 | 2479.5 | 2523.6 | 2845.5 |
| 同 Worker 中位 | 1782.8 | 1794.5 | 1702.6 | 另列状态 |
| 缓存重启轮 0 / 1 / 2 | 2361.6 / 2278.6 / 2235.1 | 2123.7 / 2179.0 / 1954.6 | 2261.1 / 2130.0 / 2017.4 | 2332.7 |
| 缓存重启中位 | 2278.6 | 2123.7 | 2130.0 | 2332.7 |

Blob+lateinpaint 的三个首次都低于 2845.5 ms，三个缓存重启都低于 2332.7 ms；首次最慢 2748.4 ms 仍有 97.1 ms 空间，中位有 321.9 ms 空间。只加 Blob 的首次中位更快 44.1 ms，但含一条 3235.8 ms 长尾，所以不能说它在这小样本中更稳。core base 自己同期中位也从此前 3174.5 变为 2530.3 ms，且它第 1 轮与 Blob 第 2 轮的 mask/PNG 等 CPU 段一起进入慢峰；不能把所有此次中位改善认给新增两个 flag。阶段中位不可相加当完整流水线中位。

主控准备原未优化 baseline 与所选 Blob+lateinpaint 组合的同环境、相同冻结产物、正反向 3 轮 final A/B 和 secondary QA，确认原目标改进幅度。固定绝对预算这组已初达；相对百分比、跨样本稳定性和最终建议以该同期对照为准。产品源码已按主控冻结，不追加新推理候选。

### 未实施的备选：同一次 detector 三输出读回并发

按主控请求只读审 1.27.0。当前 runDetectWithGpuPreprocess 在 Session.run 后按 entries 顺序串行 getData，detector 输出强制 gpu-buffer；实际 QA 三路 FP32 为 blk 1,806,336 bytes、seg 4,194,304 bytes、det 8,388,608 bytes。JSEP createDownloader 每次调用独立 downloadGpuData，先同步创建独立 MAP_READ staging、结束 compute pass、copy、flush，再首次 await mapAsync；flush 同步提交后复位共享 commandEncoder。GPU copy 仍走同一 device queue，CPU 回包/map 等待有重叠空间。[ORT 1.27 JSEP 下载实现](https://raw.githubusercontent.com/microsoft/onnxruntime/v1.27.0/js/web/lib/wasm/jsep/webgpu/gpu-data-manager.ts)、[backend encoder/flush/downloader](https://raw.githubusercontent.com/microsoft/onnxruntime/v1.27.0/js/web/lib/wasm/jsep/backend-webgpu.ts)。没有内部跨 await 共享的 staging buffer 或正在下载标记。

Tensor.getData 的 isDownloading 是每个 Tensor 自有；同一个 Tensor 再调用会报错，dispose 也拒绝仍正在下载的 Tensor。getData 成功会更新自身 CPU data/location，失败 finally 清 isDownloading；downloadGpuData 会先 clone 原字节再销毁 staging。[ORT 1.27 Tensor 生命周期](https://raw.githubusercontent.com/microsoft/onnxruntime/v1.27.0/js/common/lib/tensor-impl.ts)。因此如再实验，需只门控恰好 3 个不同对象的 gpu-buffer/float32 输出，用 allSettled 等 **所有** map 完成才按原 entries 顺序取数据/首个错误和进入既有 dispose；不能用首个 reject 即返回的 all。Session.run、disposeSession、下一次推理仍保留原 inferenceQueue，不引入新 queue。CPU/其它 dtype/重复对象保持旧串行。

新 QA 三例原 readback 分别为 **173.9 / 13.7 / 8.7**、**50.3 / 5.6 / 7.7**、**43.1 / 21.9 / 109.2 ms**。若等待可完全重叠，sum−max 只对应约 **22.4 / 13.3 / 65.0 ms** 的理论窗口；首 map 中的未完成 GPU 运算、编译以及同队列的复制不能被此 API 并发删除，不能当净收益。三个 staging 合计 14,389,248 bytes，比原最大一块 8,388,608 多约 6 MB；map 和 CPU clone 的调度也可能抵消。主控已因普通固定预算初达而要求先冻结：**没有实现 `__shinobuColdStartDetectorReadbackParallel`，没有修改该 Worker，也没有运行新 CPU/GPU gate**。是否需要此备用候选取决于最后同期 A/B，而非为追逐单次最小值继续扩大输出生命周期风险。

### 最终普通确认未稳定达标；实现三输出并发读回备用实验

主控最终普通 J 组 `.tmp/cold-budget/1790863507005-results.json`：所选候选的三个首次为 **2612.3 / 3370.3 / 3340.6 ms**，中位 **3340.6 ms**，仍超过固定首次预算 **2845.5 ms**，差 **495.1 ms**。同期原始未优化 baseline 中位 **7203.6 ms** 只用于同环境相对比较，不能抬高原先确定的绝对目标。因此上一轮三次均达标只说明该轮结果，不能据此称稳定达标；本研究继续。主控解除本文件负责的 Worker 读回段冻结，授权实现下列小候选。

已实施 `__shinobuColdStartDetectorReadbackParallel`，默认关闭且只接受严格布尔 `true`。只在 `runDetectWithGpuPreprocess` 真实输出恰好三个、三个 Tensor 对象各不同、每个均 `gpu-buffer` 与 `float32` 时，同时发起各自的 `getData()`；`Promise.allSettled` 等全部完成，再按原 `Object.entries` 顺序处理首个错误、记录原 readback mark、执行原 SHA、装配原 outputs/transferables。记录各读回实际起止，发出 marker 和 SHA 仍保留条目顺序，不能将有重叠的三段时长相加作为 wall time。CPU、其它 dtype、输出数量不符、重复 Tensor 以及所有其它调用保留原串行读取。

保持原模型 URL、SessionOptions、一次 Session.run、feeds、1024 输入、FP32 bytes/dims/types、同一 inferenceQueue 及最终 dispose 顺序。没有并发 Session，没有新队列，没有调用额外推理。任一 getData 异步拒绝或同步抛错，全部读回都已 settle 才进入外层 finally；避免第三路还在 mapAsync 时就 dispose。失败会按照原 entries 顺序选择错误；前面成功输出仍按原顺序发 marker/SHA，其后不装结果，遵循原错误传播。SHA 或 observer 在装配阶段失败时，所有 maps 同样已结束。无 observer 时不增加 clock 读取。三个 staging 峰值及预计 13–65 ms 等待窗口仍是上一节的限制，不保证净收益，亦不能单独认领当前 495 ms 缺口。

轻量 CPU gate **14 案例通过，进程约 0.51 s**，脚本直接 transpile 当前完整 Worker 与真实 SerialInferenceQueue，不复制待测读取实现。覆盖乱序成功的原 names/ratio/dims/字节（含负零、NaN payload、byteOffset）/SHA/transfer 顺序，default 未定义/false/string true、CPU/int64/bool、2/4 个输出、重复对象串行，第二路 async reject 或 sync throw 且第三 pending 时所有 Tensor/input/ImageBitmap/Session 不提前释放，disposeSession 仍经既有队列，以及 SHA reject 的完整清理。仅新增该检查文件和修改 Worker 检测读回段；未 build/typecheck/浏览器/GPU。主控将继续 same-version 检测输入/全部原输出 SHA、OCR/layout/完整最终 RGBA 与普通多轮 visible gate；CPU 检查不能替代实际 GPU 等价和全程收益验证。

```powershell
node benchmark/perf/src/check-detector-readback-parallel.mjs
```

### 三输出读回普通实测与 OCR 初始化时机复核（只读）

主控普通 `.tmp/cold-budget/1790866767884-results.json` 三组×三轮×三缓存状态完成，本代理重新读取汇总并复算中位；全部 RGBA/OCR 保持质量 gate，第二图片 QA 与最终普通确认仍由主控串行继续。

| visible，ms | chosen | +readparallel | +readparallel+threshold+thresholdgpu |
| --- | ---: | ---: | ---: |
| 全新 profile 三次 | 2523.8 / 3259.0 / 2829.7 | 3363.0 / 3193.2 / 2368.1 | 2311.7 / 3156.3 / 2392.5 |
| 全新中位 | 2829.7 | 3193.2 | 2392.5 |
| 同 Worker 中位 | 1801.6 | 2311.7 | 1924.4 |
| 保留缓存新进程三次 | 1961.1 / 2111.5 / 2129.5 | 1936.6 / 1969.3 / 2148.8 | 1873.8 / 2042.6 / 2144.4 |
| 缓存重启中位 | 2111.5 | 1969.3 | 2042.6 |

第三组合此组首次中位低于固定 2845.5 ms 目标 **453.0 ms**，缓存重启中位低于 2332.7 ms 目标 **290.1 ms**；仍有一条首次 3156.3 ms 长尾。不能写成每次首次都已达标，也不能认领此次全部中位差给并发读回；readparallel 单独首次中位反而较 chosen 慢 363.5 ms。当前决策依据完整组合的普通中位及同质量，而不是质量探针中的单条快值。

#### 真实 OCR Session 调用与重用

已追踪 `PipelineHost` constructor→detector.getSession→bubble.getSession→preparePaddleOcrRuntime；OCR 准备只在 bubble Session 创建成功后启动，没有额外 OCR run。`preparePaddleOcrRuntime` 先 readModel，按同 runtime providers 与 resolvePaddleSessionOptions 调 getSession，再 loadCharset；orchestrator 默认 after-detect 的 startOcrRuntimeProbe、随后 runOcr 的再次 prepare 使用相同 options/providers。modelRegistry 的缓存键是 model/provider/options，pendingSessions 覆盖并发创建，因此这些 prepare 调用共享同一真实 OCR Session，不重复加载 76 MB 模型。字典按 dictUrl 缓存 Promise；重复准备仅重新构造少量 metadata/字符数组，未观察到可填 50–150 ms 预算的重复工作。浏览器 worker createSession 不走 inferenceQueue，模型创建可与已有队列中的 detector 推理/读回交叠；原模型推理、disposeSession 仍在 inferenceQueue。

同版本 ORT 实际 `session-handler-inference.ts:65` 的浏览器 loadModel 是 `copyFromExternalBuffer(await loadFile(path))`；loadFile 对此 76,554,979-byte ONNX 用 response.arrayBuffer，完整 body Promise 完成后，才执行 WASM malloc/HEAPU8.set 和 `_OrtCreateSession`。因此 fetch-body 结束→ort-create-session 结束可定位包含 memcpy/建图的尾段，但这不是单独 CPU busy 采样；不能把整段等待都叫 CPU。

#### 最新 QA：整份 OCR 预加载后移会损失现有读取重叠

对 `.tmp/cold-budget/1790866046598-results.json` 三条 QA 的 worker/runtime-phase 与 offscreen host-init-trace 按各自 timeOrigin 转成同一绝对时钟。下表时间以各条 Worker timeOrigin 为零，单位 ms。

| 边界 | chosen | +readparallel | +readparallel+thresholdgpu |
| --- | ---: | ---: | ---: |
| Detector 原 FP32 输出已回 Host | 1384.5 | 1636.6 | 939.8 |
| OCR 模型 body 已完成 | 1458.6 | 1685.8 | 975.6 |
| OCR ORT Session 创建结束（Worker） | 1634.8 | 1880.5 | 1106.9 |
| body 后 Session 创建尾段 | 176.2 | 194.7 | 131.3 |
| Host 首次 post bubble runInference | 1731.7 | 1985.6 | 1072.9 |
| Worker bubble ORT run 开始 | 1735.7 | 1987.9 | 1110.5 |
| Host OCR 阶段开始 | 1822.9 | 2069.7 | 1229.2 |

最新三条 OCR body 完成均 **晚于**原 Detector 回包，分别晚 74.1 / 49.2 / 35.8 ms。当前没有证明这三条的 76 MB WASM copy/建图在原输出 getData 挂起时阻塞读回。慢两条的 **176.2 / 194.7 ms** 创建尾段全部落在 Host CTD/mask 后处理及 bubble 输入准备窗口，OCR 已在首次需要前准备完。快条 **131.3 ms** 中有 **97.3 ms** 在该 Host CPU 窗口，剩余 **34.0 ms** 晚于 bubble post；bubble ORT run 与 Host post 相差 37.6 ms，可能有 Worker 争用，但没有内部 CPU 调用栈证明这 34 ms 全部是阻塞。131.3 ms 全部在 OCR 阶段开始前完成，不能直接把它再算成 OCR critical wait。

OCR body 读取本身已经与 detector 执行并行，最新三个 body 267.6 / 246.4 / 207.9 ms。简单把整个 `preparePaddleOcrRuntime` 推迟到原输出读回完成，会把这段读取也后移，不能预设净收益。即使在 Host runImage Promise 成功后 settle 一个 gate，prepare 的 readModel/getSession/getProxy 都有真实 await；CTD 同步后处理可能先执行，不能凭微任务假定 createSession RPC 已 post 并覆盖 CTD。若将来确需候选，必须保留早期读取、只门控真正 CPU 初始化，并证明实际 post/读回完成边界；ORT 公共 createSession 本身没有中途暂停建图接口，当前不扩大修改范围。

旧探针不完全一致：`.tmp/cold-budget/1790859690617-results.json` threshold、downloadblob-lateinpaint 旧 QA 的 base/late 等样本，body 已在最后原输出前完成，107–118 ms 创建尾段确实与长 readback 有交叠；最长 109–174 ms 单路读回可能被 Worker CPU 推迟回调。这个风险存在，但它的出现取决于读取和 GPU 工作相对时序。最新三条边界已经不同，不能将旧交叠推为此次必然瓶颈；aftersubmit 全体 Session 后移已有负结果，不重试相同调度。

#### 当前入口/模板机会的证据范围

最新三条首 requestAdapter 为 303.5 / 778.6 / 201.5 ms，第二请求也实际出现（17.4 / 590.5 / 1.1 ms）。它们彼此重叠且共用 GPU 服务，不能将两个时长相加或把删一次调用说成删掉 590 ms。adapterOverlap 的 env.adapter 赋值只有在 ORT initEp 取值前完成才会复用；消除该 race 需要等待早期 Promise，可能反过来阻塞已开始的 ORT 初始化，并不是已证明的纯净提速。

110 份模板的预编译在 `cold-start-worker-probe.js` overlap=true 时不 await ready，已经与 Session 下载、Host panel 准备及 detector/OCR 重叠；shaderWarmup 同样异步。precompile 总记录约 1.1–1.3 s 不能整段从 visible 再减一次。最新 QA 原 detector pipeline reuse 命中绝大多数，余下三次 nativeSync 合计约 0–0.1 ms；没有已证实可删的数百 ms同步模板编译段。Host panel 准备仍有 239.9 / 347.8 ms，另一次 816 ms longtask 含加载与 panel，但那是已授权并行研究的原像素算法范围，本代理不重复归功或更改其它代理文件。

本轮只读源码和 JSON，未新改产品、未新建时序 gate，未 build/typecheck/模型/浏览器/GPU。保留现 OCR 预加载，继续由主控最终同环境普通确认与第二图 QA；当前没有能由这些 trace 直接认领更大预算的初始化删减项。


## 主控最终确认

最后五轮普通对照已完成：新 profile 中位数 **2431.2 ms**（2405.7–2783.9），缓存重启 **2042.7 ms**（1830.3–2142.5）；两个状态各五轮均低于原定2845.5/2332.7 ms预算。第二图及主图原流程的四组原始检测SHA、OCR、最终RGBA校验通过。详见 [最终报告](cold-start-budget-final-2026-10-01.md)，其中区分固定预算、同期对照、工作转移和先前长尾。所有实验开关默认关闭。
