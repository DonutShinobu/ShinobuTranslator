# 完整模板后的首次 GPU/CPU 调度证据

2026-10-01。只读分析主控串行 Chromium 151 / ORT 1.27.0 数据，保持所有原模型、FP32、输入、ROI 和完整 detector 三 tensor。没有增加 GPU/browser/build/typecheck 负载，也没有实现下文待计数的 arena。

## 普通 18 样本

原始汇总 `.tmp/cold-budget/1790857271448-results.json`；noWrite 为全组合，write 为其仅加 writeupload。下表全部为 ms，runtime-start 是 jank 第一个阶段开始，包含此前 extension/host 启动间隔，**不是纯模型加载**。Preload 包含 `prepareReadingPanels` CPU 工作和 detector Session 剩余等待；Detect 包含 Worker 调度、预处理、ORT run、完整输出下载与 CPU 后处理，**不是纯 GPU 执行**。各列中位数不能拼成某个真实样本。

| 轮/开关/cache | visible | runtime-start | preload | detect | bubble | OCR | mask | inpaint | typeset | finalize | display-tail |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0/noWrite/fresh | 3152.9 | 461.2 | 354.3 | 608.9 | 245.3 | 308.1 | 318.5 | 273.7 | 48.6 | 228.5 | 254.8 |
| 0/noWrite/warm | 2583.4 | 444.7 | 288.3 | 330.5 | 189.1 | 222.8 | 299.9 | 253.3 | 22.4 | 268.9 | 231.4 |
| 0/noWrite/restart | 2127.7 | 300.7 | 211.7 | 341.1 | 143.7 | 226.8 | 205.6 | 223.0 | 26.6 | 150.1 | 175.9 |
| 0/write/fresh | 3205.3 | 519.4 | 325.8 | 591.7 | 225.0 | 308.7 | 338.9 | 277.5 | 49.3 | 237.0 | 276.2 |
| 0/write/warm | 2598.2 | 486.0 | 278.4 | 324.9 | 187.4 | 206.8 | 318.1 | 243.9 | 25.8 | 259.3 | 232.6 |
| 0/write/restart | 2204.2 | 365.4 | 222.3 | 444.7 | 151.0 | 221.3 | 215.4 | 198.7 | 29.6 | 151.1 | 174.9 |
| 1/write/fresh | 3137.7 | 509.3 | 334.1 | 592.2 | 220.4 | 301.0 | 316.8 | 261.0 | 48.3 | 237.7 | 271.7 |
| 1/write/warm | 2392.7 | 451.1 | 263.4 | 303.0 | 190.1 | 185.7 | 288.6 | 237.9 | 21.1 | 205.0 | 214.4 |
| 1/write/restart | 2110.8 | 302.9 | 223.7 | 439.2 | 146.8 | 199.6 | 196.4 | 202.0 | 25.6 | 157.5 | 181.3 |
| 1/noWrite/fresh | 3285.3 | 629.2 | 340.3 | 599.1 | 222.8 | 287.5 | 318.6 | 310.6 | 47.4 | 234.5 | 248.1 |
| 1/noWrite/warm | 2509.6 | 455.7 | 289.1 | 342.4 | 198.1 | 198.6 | 270.9 | 249.4 | 24.4 | 233.5 | 218.4 |
| 1/noWrite/restart | 2159.6 | 325.7 | 233.5 | 447.3 | 149.1 | 211.9 | 201.5 | 198.3 | 26.2 | 151.5 | 173.2 |
| 2/noWrite/fresh | 2481.1 | 373.8 | 231.7 | 514.3 | 174.6 | 215.6 | 220.1 | 238.3 | 28.9 | 149.3 | 275.9 |
| 2/noWrite/warm | 1848.1 | 329.9 | 170.2 | 248.6 | 116.4 | 157.5 | 209.7 | 183.5 | 15.8 | 159.9 | 226.4 |
| 2/noWrite/restart | 2164.4 | 326.9 | 231.7 | 456.4 | 146.8 | 214.2 | 209.1 | 191.7 | 25.4 | 153.7 | 176.1 |
| 2/write/fresh | 3300.9 | 628.4 | 353.7 | 605.8 | 216.2 | 310.1 | 308.9 | 253.4 | 45.4 | 232.5 | 281.1 |
| 2/write/warm | 2461.7 | 425.0 | 282.6 | 310.9 | 190.0 | 211.6 | 270.1 | 234.7 | 34.8 | 240.4 | 229.7 |
| 2/write/restart | 2099.9 | 324.1 | 212.6 | 359.1 | 151.3 | 223.3 | 208.4 | 229.0 | 27.5 | 151.8 | 172.6 |

Fresh 中位 noWrite3152.90 / write3205.33ms，未达2845.5；restart2159.56 /2110.81ms，均达2332.7。Upload 普通首次收益未证实，准确 API 计数和质量门另见 `cold-budget-gpu-upload-2026-10-01.md`。

### 编译覆盖不能再次列为可删预算

六个 fresh 均有 detector40 / bubble25 / OCR33+14 / inpaint13 的全部 pipeline hits，0 misses/nativeSyncMs。Warm 报告的 probe 数组累计上一轮记录，需要取本轮新增 records；本轮所有模型均无新 pipeline 创建。Retained restart 没有静态 seed，probe 的 pipelineMisses40/25/33+14/13 代表未被 JS readyPipelines Map 替换，不证明 driver cache miss 或新的昂贵编译。

Write 完整110 seed async用时835–901ms，noWrite1084–1206ms；其全程却未下降。更短的背景编译总时间可能不在关键路径，也可能来自 API/线程竞争变化，现记录没有每 template ready 时间与 GPU 原生执行时长。不可把300ms差直接相加到已隐藏的模板收益。

### QA map 不足以解释快状态

QA `.tmp/cold-budget/1790857001697-results.json` 的 noWrite→write 在输入 map 之前已出现 WASM instantiate129.5→46.1ms、detector create874.3→594.6ms。普通 noWrite 第3轮没有 map 验证，也能fresh2481/warm1848且mask/finalize同步较快。快样本 CPU busy66.1%高于其余慢 fresh50.8–59.1%；该指标是全系统逻辑CPU idle ticks，未测单线程频率/排队，不能据此定性机器更忙导致慢。

OCR快样本的CPU preprocessing84.1ms反而大于慢样本67.8–71.9ms，而实际九批 inference RPC合计86.4ms vs159.1–173.4ms、首批15.3ms vs50.7–72.9ms；color采样41.9ms vs55.1–65.2ms。说明有广泛波动，但不是每个CPU阶段按固定比例变化。这里的RPC包含排队/传输/CTC/等待，没有GPU timestamp，不能称纯模型计算差。

主控已完成既有 fence 三轮 `.tmp/cold-budget/1790858304760-results.json`，中位 noFence3262.62 / fence3310.95ms，相同RGBA。恢复预处理 `onSubmittedWorkDone` 未证实稳定收益，停止以QA快状态为依据继续该假设。

## 候选优先顺序与最小诊断

主控已有真实 source 路径候选优先：NativeThreshold保留8bit阈值语义、SourcePreRead将现有90–120ms灰度/原像素读取放到 detector输出尚未就绪的窗口；由各 owner 实现与严格质量验证。本 agent 不编辑其文件。以下 GPU 调度只在相同冻结组合上作独立变量，不换主模型、精度和三tensor。

### 1. 已有 aftersubmit 与 dispatch64

`pipelineHost.ts` 当前 earlySessions 在detector Session ready后先创建bubble；QA bubble create约202–216ms，于detector preprocess之前结束。已有`aftersubmit`仅等detector RPC成功postMessage后再排bubble创建，**不是等GPU queue.submit**。它有将初始化置入detector等待/CPU后处理窗口的机会，也可能令bubble/OCR随后等待，不能将202ms全部假设为可删。先检查主控已有QA与normal比较，不重写初始化框架。

ORT [ProgramManager.run](https://github.com/microsoft/onnxruntime/blob/v1.27.0/js/web/lib/wasm/jsep/webgpu/program-manager.ts#L76) 的dispatch64改动仅将compute提交阈值16改64。原upload、readback、memcpy独立提交不由此合并。须同时看submit减少量、ORT-run/下载总窗口、全程以及requested buffer peak；更晚flush使pending buffer较晚回free pool，可能增加内存及延后第一批GPU工作。质量门仍检查NCHW/三原输出SHA、完整OCR和最终RGBA，内存门不把requested当VRAM。

主控随后提供16/aftersubmit两条QA `.tmp/cold-budget/1790858817153-results.json`，visible3378.49/3436.16ms、计数完全相同，质量一致；只缩短detector阶段未使全程更快，主控不再为aftersubmit单独跑普通A/B。Dispatch64 QA另存`.tmp/cold-budget/1790858994119-results.json`，质量汇总`.tmp/cold-budget/dispatch64-quality.json`四rawSHA/完整OCR/RGBA通过。两QA来源的实际GPU计数如下，均为noWrite完整组合。

| 请求指标 | 16（12:47:12报告） | 64（12:50:01报告） | 差值 |
|---|---:|---:|---:|
| queue.submit | 1069 | 886 | −183 |
| upload staging个数/字节 | 804 / 216,558,480 | 相同 | 0 |
| writeBuffer个数/字节 | 3929 / 366,224 | 相同 | 0 |
| requested created bytes | 1,417,663,440 | 1,458,506,064 | +40,842,624 |
| requested live bytes | 1,141,293,568 | 1,182,136,192 | +40,842,624 |
| requested peak bytes | 1,144,439,296 | 1,185,281,920 | +40,842,624 |
| created/live/peak buffers | 2142/1299/1300 | 2253/1410/1411 | 各+111 |
| destroyed buffers | 843 | 843 | 0 |

故dispatch64确实减少183次显式submit，也多保留约38.95MiB请求buffer；不是实际VRAM读数。扣去804次原upload模式，其他submit从265→82，但仍没有将剩余copy/readback/compute细分。两组QA全部pipeline hits、零miss、lost=false/error0。64的2526.50ms仅是带SHA和profile的单QA，mask216.0/finalize152.6ms同时也较快，不能作为正式收益。三轮普通16/64 A/B已完成，见下节；普通组关闭这些诊断。

若需要区分compute提交，只在isolated ORT `flush()`入口按`pendingDispatchNumber`统计0/1–15/16（64组相应0/1–63/64）。非零表示待提交compute数量，0可含纯copy；partial可能带readbackcopy，不能从该计数给唯一调用原因。原upload source可独立统计，不用泛化encoder wrapper，也不增加同步fence。当前1069或296总submit没有此分类。

### 2. 先计小 uniform API 开销，不先做arena

同版本 `backend-webgpu.ts` `run()` 为每个含uniform的dispatch创建/复用一个uniform buffer、写原ArrayBuffer、立即release到pending。QA noWrite记录3929个`writeBuffer`总共366,224B，除预处理/CTC等自有参数，主要是每dispatch小uniform。上传write候选减少773次大数据staging后仍保留这些小写。**调用数和小payload不构成100ms收益证据。**

主控批准后，现 `cold-gpu-buffer-submit-probe.js` 的两处既有wrapper已经加入极简默认关闭timing：

- 严格`__coldGpuApiTiming === true`时才加clock；按目标`buffer.usage & UNIFORM`分类，字段`uniformWriteBufferCalls/Bytes/NativeSyncMs`和`maxUniformWriteBufferNativeSyncMs`。其余请求counts/bytes/syncMs可从既有总数和新的`queueWriteBufferNativeSyncMs`减uniform得到，不能命名initializer。
- `queue.submit`增加`queueSubmitNativeSyncMs/maxQueueSubmitNativeSyncMs`，另有`apiTimingEnabled`标明计时状态。不包encoder或computePass，不增加await/map/queue fence，不逐调用fetch或输出records。
- native调用正常返回后累计；保留args/this/返回与原异常。同步时长仅为JS→native API返回开销，异步GPU validation可能在返回后发生，仍检查lost/error。
- 所有聚合在已有inpaint-reply批量flush。诊断样本与normal性能隔离，诊断clock开销不能并入正式加速百分比。

仅新增8个聚合字段，未改普通Worker/isolatedbundle/runtime-phase probe/runner/dist。Probe源码SHA为`698c8d42581ae5401beeec1b4bdb25bfcff41dfaf6418c90947ab58537a1cb0f`。小CPU检查`node benchmark/perf/src/check-gpu-buffer-submit-probe.mjs`通过（0.26s）：真实probe在VM中覆盖undefined/false/字符串true/布尔true，native原this/args/返回、原submit/write同步异常不计成功、TypedArray offset/size元素单位、DataView/ArrayBuffer字节单位；mock native自行推进clock证实仅计native调用窗口。不开timing不增加clock读取，错误路径不改变原异常，批量终点和原buffer统计保留。主控的三variant串行QA已提供实际API计时，见下节。

实测uniform同步累计只有2.4–7.6ms，停止arena方向。若以后设备证据不同且确认成本足够，isolated backend每flush一个uniform arena才有讨论价值：各原uniform字节不变、offset按minUniformBufferOffsetAlignment（此设备256）对齐、binding.size保持原值、flush前一次writeBuffer，同队列提交完成编码后才复用slot，不改变WGSL或数据。必须覆盖run末尾/下载/临时copy的所有flush，以及错误/Session释放。它不是现在已实现或已验证的候选。

### 3. 更小的 BGL 对象复用

上述ProgramManager每个dispatch调用pipeline.getBindGroupLayout(0)。[Chromium151实现](https://github.com/chromium/chromium/blob/151.0.7922.34/third_party/blink/renderer/modules/webgpu/gpu_compute_pipeline.cc#L71)每次创建GPUBindGroupLayout包装对象。可仅按**实际GPUComputePipeline对象**WeakMap缓存index0 BGL，继续每次创建原entries bindgroup，不缓存tensor或buffer、不跨device/layout共享。此方向删除重复对象/API，但没测调用成本；先用同诊断总calls/nativeSyncMs决定，不能承诺百毫秒。当前不实现新框架。

## 质量范围

18份报告相同image+cacheState的OCR明细一致，最终2921×4096 RGBA SHA均为d3bd5084867c64501ac615d6baacb8cb31ee38f6b93af28cb7ce78f2d1d8ba97，四provider均webgpu。Fresh/restart与warm的首ROI confidence有现有batching差异，因此按cacheState分组验证，未改原热路径，也不将跨状态差异归因upload。一次QA四rawSHA门通过不替代其他图片/设备覆盖。

## dispatch64 普通三轮：方向不一致

`.tmp/cold-budget/1790859051166-results.json` 共18个普通样本，固定相同CTC110文件SHA、同一完整组合，64只修改isolated JSEP提交阈值。新profile fresh、相同Worker warm、保留profile另起进程 restart 分开统计；未清操作系统/驱动缓存，new-profile不等于重启设备后的首次驱动编译。

| 轮 | fresh16 | fresh64 | Δ64−16 | restart16 | restart64 | Δ64−16 | warm16 | warm64 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 0 | 3782.3 | 3219.4 | −562.9 | 2178.2 | 2122.8 | −55.4 | 2774.3 | 2499.2 |
| 1（反转） | 2534.8 | 3418.2 | +883.5 | 2066.6 | 2282.9 | +216.3 | 1880.9 | 2431.1 |
| 2 | 3411.4 | 2352.3 | −1059.1 | 2134.5 | 2208.7 | +74.2 | 2594.5 | 1672.6 |
| 中位数 | **3411.4** | **3219.4** | **−192.0** | **2134.5** | **2208.7** | **+74.2** | 2594.5 | 2431.1 |

Fresh距2845.5ms分别仍差565.9/373.9ms；restart两组均满足2332.7ms。两组都是两次慢、一次广泛较快，192ms的中位差不能记作减少183次submit的确定收益。

下表仅fresh阶段，ms；runtime-start、preload和detect定义同前文。jank阶段已包含各Worker等待，不另加下方OCR RPC。

| 轮/阈值 | runtime-start | load | preload | detect | bubble | OCR | mask | inpaint | typeset | finalize | display-tail |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 0/16 | 443.5 | 248.8 | 429.8 | 759.0 | 225.3 | 345.4 | 337.7 | 375.3 | 53.6 | 250.7 | 268.2 |
| 0/64 | 554.9 | 9.5 | 309.7 | 599.5 | 221.6 | 291.3 | 334.1 | 277.5 | 49.0 | 240.8 | 289.0 |
| 1/16 | 310.9 | 12.9 | 324.5 | 575.9 | 141.1 | 247.7 | 218.6 | 223.3 | 27.8 | 151.1 | 272.4 |
| 1/64 | 816.5 | 8.3 | 316.4 | 568.3 | 216.1 | 313.9 | 293.7 | 277.5 | 47.1 | 235.7 | 273.1 |
| 2/16 | 492.3 | 7.9 | 334.7 | 676.9 | 220.3 | 339.3 | 365.2 | 359.6 | 48.7 | 243.9 | 281.1 |
| 2/64 | 373.3 | 8.6 | 287.8 | 519.1 | 141.4 | 213.5 | 205.9 | 204.4 | 27.1 | 153.3 | 172.6 |

第0轮load下降239.3ms，发生在dispatch阈值能起作用之前；第1轮64 runtime-start多505.6ms；第2轮mask、finalize、display分别减少159.3、90.6、108.5ms。不能由GPU提交次数解释这些前置和CPU/显示阶段的变动。64的detect三轮都小一些，但第0轮编译覆盖也不同，且后续总阶段及真实OCR RPC不呈同向。

### 实际模型RPC与编译覆盖

这18份普通报告的`jank.workerCalls`全部为空，也没有`runtime-phase-batch`/`ort-run`细分。唯一现成的实际模型RPC样本是`pipelineSummary.ocrDebug.paddle.inferenceRuns`：计时从调用`modelRuntime.run`前开始、返回后停止，含RPC排队、数据传输、ORT调用、CTC和GPU读回；不能称纯GPU计算，也不能虚构其余模型的纯run时间。

| 轮 | fresh16九批RPC/首批 | fresh64九批RPC/首批 | restart16九批RPC | restart64九批RPC |
|---|---:|---:|---:|---:|
| 0 | 168.2 / 28.6 | 161.1 / 63.2 | 107.5 | 108.4 |
| 1 | 111.8 / 37.1 | 162.6 / 58.9 | 105.9 | 145.1 |
| 2 | 172.7 / 61.8 | 104.2 / 34.8 | 105.3 | 107.1 |

64每轮restart真实OCR RPC都未更快。Fresh第0轮首批反而较慢；第1轮RPC整体较慢，第2轮整体较快。因此目前没有三轮一致的推理节省证据。

Base第0轮fresh detector有40 module hits、**29 pipeline hits / 11 misses**、nativeSync0.1ms；完整110背景预编译1313.1ms，于detector运行后结束。其他五个fresh detector均40/40，bubble25、OCR33+14、inpaint13均全hit/零miss。64背景预编译915.6/888.6/934.4ms，base1313.1/971.6/1255.7ms；第1轮64的背景编译较短却全程较慢。完整模板已提供，但部分较早首图run仍可能赶在所有pipeline异步ready之前；miss计数不提供原生GPU编译时长。Warm报告累计了fresh记录，只看新增记录，本次warm没有新pipeline创建；restart没有静态seed替换，全部pipeline miss也不能代表驱动编译cache miss。

只读CPU比较18份完整报告的相同image+cacheState，严格对照17个OCR region的box/方向/inputDims/inputBytes/resizedWidth/text/confidence/accepted、九批run的dims/输出dims/文本/confidence/accepted计数、detected数量、四provider及最终RGBA，全部Passed。只移除随机regionId及时间字段，不将warm首ROI confidence0.9039178292979576与fresh/restart0.9715988535357322混为同一门。

## 实际 API 计时 QA：停止uniform arena方向

主控`.tmp/cold-budget/1790859690617-results.json`包含base、NativeThreshold、NativeThreshold+SourcePreRead各一个fresh质量样本，均开verifyinput、verifydet、init profile及API timing，**不是普通性能组**。`.tmp/cold-budget/threshold-preread-quality.json`同cacheState全质量门通过。

| 同步API或请求指标 | base | threshold | threshold+preread |
|---|---:|---:|---:|
| uniform writeBuffer次数 / bytes | 3929 / 366,224 | 相同 | 相同 |
| uniform同步累计ms / 单次最大ms | 7.6 / 0.1 | 2.4 / 0.1 | 3.5 / 0.1 |
| queue.submit次数 | 1069 | 1069 | 1069 |
| submit同步累计ms / 单次最大ms | 15.2 / 1.3 | 7.2 / 0.4 | 12.1 / 1.4 |
| upload staging个数 / bytes | 804 / 216,558,480 | 相同 | 相同 |
| requested peak bytes | 1,144,439,296 | 相同 | 相同 |
| device lost / uncaptured errors | false / 0 | false / 0 | false / 0 |

三组所有writeBuffer恰好都属于UNIFORM分类；这是本次noWrite固定组合的实际API统计，不是任意ORT模型的保证。性能计时为原native调用返回前窗口，低于时钟分辨率的小调用可归零，不计异步GPU执行/validation，也不含所有buffer allocation/encoder/JS循环。该诊断足够否定“3929次小写必有100ms”的估计；不给uniform arena或自定义flush新增实现预算。普通性能组关闭该开关。

### 真正的首次ORT调用与读回窗口

| Worker内阶段（ms） | base | threshold | threshold+preread |
|---|---:|---:|---:|
| detector `session.run` | 63.0 | 34.9 | 51.0 |
| detector三tensor读回合计 | 53.7 | 214.3 | 65.3 |
| bubble `session.run` | 36.2 | 83.5 | 151.2 |
| OCR九次`session.run`合计 / 首次 | 108.0 / 28.5 | 53.7 / 16.4 | 84.0 / 36.7 |
| inpaint `session.run` | 42.2 | 41.7 | 41.7 |

Detector输出是gpu-buffer，`session.run`返回不代表GPU已执行完；第一输出getData通常包括剩余GPU完成。Bubble/inpaint输出默认CPU，`session.run`已包含内部map回CPU，其后的`output-readback`0–0.1ms是读取已在CPU的数据，不能据此称没有下载。OCR这里单独的`output-readback`还包含项目GPU CTC处理，原始tensor dims与其少量CTC读回bytes的语义不同。

Threshold的seg读回119.5ms几乎覆盖OCR Session创建后半段（Worker at985.7–1105.2 vs create806.0–1104.1）；SourcePreRead组bubble run1303.3–1454.5与inpaint create1320.5–1441.1重叠。记录证明这些窗口含其他初始化/CPU事件的并发，无法仅以14.4MB payload估下载带宽或将整个run解释为模型GPU时间。三组原detector输入/blk/seg/det SHA、完整OCR/最终RGBA均相同，且所有模型pipeline全hit。

### 约220ms残差在Session创建，不能先当成可合并upload

Detector prefetch已经进入创建调用并被复用。创建结束为Worker at813.6/585.4/627.7；detector fetch-body完成455.3/359.6/400.1，故残差358.3/225.8/227.6ms。它包括模型入WASM复制、图分配/检查、kernel和权重初始化、同步CPU→GPU上传，现probe没有这些内部子段，**不是first run才上传权重的220ms**。

GPU device ready453.6/254.8/270.1，首个submit708.5/527.0/570.0。在预处理尚未开始时就已提交，符合初始化权重上传路径；fetch-body完成到首submit253.2/167.4/169.9ms，而首submit到detector Session ready仅105.1/58.4/57.7ms。因此约220ms残差的大部分发生在首提交之前。缺少首staging创建时间，不能排除其单次大复制，但也不能把整个残差归804次upload；804计数属于全模型、含各模型输入/其他CPU→GPU拷贝。

官方1.27 [SaveInitializedTensors](https://github.com/microsoft/onnxruntime/blob/v1.27.0/onnxruntime/core/framework/session_state_utils.cc)在Session初始化逐initializer分配/反序列化/CopyTensor；[JS data transfer](https://github.com/microsoft/onnxruntime/blob/v1.27.0/onnxruntime/core/providers/js/data_transfer.cc)的CPU→GPU调用是同步EM_ASM。安装包`init.ts`从HEAPU8构造view后立刻调用upload，原upload逐次mapped staging复制、encoder/copy/finish/submit/destroy；同算法并批只能去掉部分encoder/submit，仍要保留原CPU字节复制。

最小下一证据若必要：仅isolated `GPUDataManager.upload()`实际方法增加严格默认关闭的调用次数/bytes/同步累计及最大、首尾时间，在创建调用和run调用边界采样聚合差值；不遍历每initializer输出，不加await/fence/逐事件网络。已有总submit同步只有7–15ms，且writeupload减少773次submit仍无普通fresh收益，故尚无≥100ms的实证依据。

延后读取HEAP view会碰到临时CPU tensor释放/堆增长；必须当场复制原staging。延后copy命令的submit还需在计算/下载/Session成功、失败与释放边界提交或清理，并在submit后才destroy staging。`jsepOnCreateSession`仅在成功创建后调用，单独拿它作唯一flush出口覆盖不了失败路径。当前不实现这类生命周期改动，也不把105/58ms尾窗口当成确定能全部删除的预算。

## 1.27 pooling/cache与graph等级：没有新现成GPU cache开关

- `textureCacheMode`属于WebGL；WebGPU env公开项没有pool/cacheMode开关。GPUDataManager已经按硬编码size bucket分别复用storage/uniform，在flush后回收到freelist；graph capture会额外保留中间buffer，不是减少首次初始化的pool模式。[1.27 env.ts](https://github.com/microsoft/onnxruntime/blob/v1.27.0/js/common/lib/env.ts)，[GPUDataManager](https://github.com/microsoft/onnxruntime/blob/v1.27.0/js/web/lib/wasm/jsep/webgpu/gpu-data-manager.ts)。
- JSEP含webgpu provider时`enableMemPattern`被强制false，传true不会开启GPU memory pattern；当前Worker没有设`enableCpuMemArena`，binding的`!!undefined`已传false。再加这两个false不会省重复工作；CPU arena不是GPU allocator。[session-options.ts](https://github.com/microsoft/onnxruntime/blob/v1.27.0/js/web/lib/wasm/session-options.ts)，[WASM API](https://github.com/microsoft/onnxruntime/blob/v1.27.0/onnxruntime/wasm/api.cc)。
- Detector ORT当前full组合已有basic；disabled同样跳过saved Level2 replay，不再带来一层额外replay省略。Basic组合已过同cacheState原输入/三raw输出/完整OCR/RGBA门，但basic没有单独冻结组合收益证据；不能重复计入新预算。
- 对bubble/OCR/inpaint的**ONNX**改basic不同：Level2包括JS/WebGPU ConvActivation等融合，降到basic可能增加dispatch并改变FP32舍入，不是“仅删CPU优化”。若还需现成单flag，ONNX的all→extended更窄：保留Level2，跳过更高级的CPU layout等transformer。但其初始化扫描成本未计时、可能改变CPU fallback图，且FP32资产并无可预设的100ms收益。[1.27 graph_transformer_utils.cc](https://github.com/microsoft/onnxruntime/blob/v1.27.0/onnxruntime/core/optimizer/graph_transformer_utils.cc)。

上述extended只是一项低优先只读候选，未新增flag或运行。若之后单独验证，必须让effective Session options参与cache key，保留同modelbytes/provider/dims，原始三tensor及OCR confidence/最终RGBA按image+cacheState严格门，检查模板覆盖是否变化；不可复用另一等级的Session或原图template覆盖收益。

随后主控普通三variant反转27样本`.tmp/cold-budget/1790859883194-results.json`已完成，base/threshold/threshold+preread fresh中位3174.47/3356.40/3284.74ms，restart2186.81/2179.88/2147.56ms。该完整组合的新profile中位仍未满足2845.5ms，不将上方单QA2465/2566ms称为目标已实现。其source候选的阶段细分由相应owner继续核对。

另一个现成options方向已排除：本次直接按安装包FlatBuffer schema读取detector.ort真实images=[1,3,1024,1024]、每维VALUE且无dimParam/denotation、全图符号维度集合为空；项目GPU/CPU detector调用也固定该shape。没有可由`freeDimensionOverrides`再固定的动态高度/宽度/batch，未新增旗标，证明见`cold-budget-detector-basic-2026-10-01.md`。

## 最小调度候选：只延后early inpaint

`apps/extension/src/offscreen/pipelineHost.ts`新增严格默认关闭的`__shinobuColdStartEarlyInpaintAfterBubble === true`。只有开启已有EarlySessions时才影响构造阶段的链：detector→bubble→preparePaddleOcrRuntime保持原顺序，最后一次early `getSession('inpaint', ['webgpu','webnn','wasm'])`被跳过。undefined/false仍执行原四Session链；不开EarlySessions时此旗标没有额外行为。

正常流水线保留原inpaint初始化。`orchestrator.ts`的默认`current`在OCR runtime准备完成后、`runOcr`之前调用`startInpaintRuntimeProbe()`，能与OCR预处理重叠；使用其他既有schedule时按原schedule工作。`dist-chromium/models/models.json`的inpaint runtime确为webgpu→webnn→wasm，与原early显式providers一致；后续runInpaint亦保留原providers。只新增末步guard，没有新的锁、取消出口或Session生命周期。此候选针对已观察到的bubble run与inpaint创建重叠，是否缩短总时间仍待同组合串行QA/普通反转对照。

原`tests/offscreen/pipelineHost.test.ts`中的顺序门扩为undefined/false/true三种：前两者四Session，true三Session且不提前run；true时正常host作业仍可通过传入的modelRuntime请求第四个inpaint Session并完成。其余dispose/stop/cancel/after-submit测试保持。小CPU检查`node node_modules/vitest/vitest.mjs run tests/offscreen/pipelineHost.test.ts --maxWorkers=1`通过35/35，未运行浏览器/GPU/build。

### Native filter可能把raster移入后续inpaint

扩展的`browserPipelinePlatform.createCanvas`实际创建HTMLCanvas。`tryNativeOpaqueMaskThreshold`向新Canvas记录contrast filter的1:1 `drawImage`后直接返回，没有读取或快照目标Canvas；`mask.native-threshold`只包这段JS调用。后续inpaint预处理将mask画到512×512并`getImageData`，再在合成前读取全尺寸binary mask，因此会消费此前绘制结果。

Chromium151的HTMLCanvas `FinalizeFrame`和`GetImage`会先`FlushCanvas`再快照；即使软件路径，`Canvas2DBitmapProvider`也保存record，在Flush时才`RasterRecord`。`willReadFrequently:true`并不保证每次drawImage返回时已完成目标raster。[HTMLCanvas实现](https://github.com/chromium/chromium/blob/151.0.7922.34/third_party/blink/renderer/modules/canvas/canvas2d/canvas_rendering_context_2d.cc#L783)、[软件Canvas provider](https://github.com/chromium/chromium/blob/151.0.7922.34/third_party/blink/renderer/platform/graphics/canvas_resource_provider.cc#L318)、[getImageData公共路径](https://github.com/chromium/chromium/blob/151.0.7922.34/third_party/blink/renderer/modules/canvas/canvas2d/base_rendering_context_2d.cc#L392)。

这是延后工作的一种可行解释，源码无法确定该样本每次filter的实际raster时点：recording限额或其他消费者也可能更早flush。上述质量QA中inpaint profile的`preprocess`为base23.5ms、threshold60.7ms、threshold+preread53.5ms，分别增加37.2/30.0ms，与延后绘制相符，但还有其他CPU负载和初始化调度。不能把mask阶段减少的37–56ms全部称为工作被删除，也不能把inpaint增加全部归因filter。验收应同时检查相关mask/inpaint窗口和完整visible时间，在相同image+cacheState的普通样本中判断净收益。

## 完整Detector输出消费与按需读回：不改变协议

2026-10-01只读追踪当前源码与最新实际扩展QA。`onnxDetect.ts`约916行先调用`pickDetTensor`，存在匹配det时进入CTD分支，先用det通道0的FP32值阈值化（`>0.3`）并提取8邻接contour，按原像素顺序累加FP32值计算score（`>0.6`）、生成quad/regions，再优先取seg通道0制作粗mask。该分支即使regions为空、det数据类型/尺寸导致空regions，或binary mask无效，也直接返回，不尝试blk；CTD中抛出的异常亦没有blk恢复逻辑。不存在“先blk成功就不需要8MB det”的路径。

| 原始输出 | 固定shape / 字节数 | 当前消费者 |
| --- | --- | --- |
| blk | `[1,64512,7]` / 1,806,336B | 仅未找到匹配det时，才尝试boxes/过滤；当前模型正常输出det时不消费blk内容 |
| seg | `[1,1,1024,1024]` / 4,194,304B | det分支优先作为粗mask；无匹配det且blk未给出合法框时亦用于mask/CC |
| det | `[1,2,1024,1024]` / 8,388,608B | 当前模型主CTD路径使用通道0；seg缺失/无效时也可用det通道0作mask。通道1当前未被图像流水线读取 |

`pickDetTensor`按名称优先，随后可按任意4D tensor的shape选取；`pickBlkTensor`同样支持匿名3D输出，`pickSegTensor`支持匿名单通道输出。因此只按名称删字段还会破坏匿名/异常shape路径。理论上的未消费传输是blk约1.8MB与det第二通道约4.2MB，不是整个8.4MB det；这些结论仅针对当前资产和正常主分支。

全树调用检查：实际图像调用在`detectByOnnx`的`modelRuntime.runImage`；extension `PipelineHost`包装只添加提交通知，web pipeline worker只代理，Node bridge明确不支持GPU预处理并抛错供CPU fallback。`browser.ts`仍公开导出`runDetectWithGpuPreprocess`，`ModelRuntime`/`OnnxWorkerApi`与`GpuDetectResult`返回完整`Record<string, TensorTransport>`（FP32数组、原dims/type）。generic `runInference`亦保留所有输出。调试摘要本身没有另一个原始det消费者，但raw SHA质量门在Worker中读取并验证输入及blk/seg/det三完整数组；Comlink随后转移这些ArrayBuffer。现有`finally`在所有待完成map结束后dispose全部output/input并关闭ImageBitmap。

跳过blk的`getData`、只返回det通道0、或放入假数组，都改变此公共返回协议和完整原始张量门。即使调用方只用det/seg，跳过原本未使用的blk下载异常，也会改变`runImage`抛错→WebNN/WASM CPU fallback的现有行为。若未来另立私有选择输出接口，需要明确约束正常shape/资产、缺失输出fallback、debug/rawSHA强制完整读回及失败清理；当前没有充分性能理由为此扩展接口，本轮没有实现此候选，也没有修改模型的输出或图计算。

### 最新QA的读回、CPU CTD与调度上限

`.tmp/cold-budget/1790866046598-results.json`全部为同图/new-profile带`verifyinput`/`verifydet`的诊断样本，不能作为普通性能中位数。三个输入及blk/seg/det SHA、最终2921×4096 RGBA完全相同；剔除随机regionId与`*Ms`计时字段后，完整OCR debug语义数据亦一致。

| 指标（ms） | chosen顺序读回 | 加readparallel | 再加threshold/thresholdgpu |
| --- | ---: | ---: | ---: |
| visible（仅QA） | 3470.7 | 3522.9 | 2501.0 |
| ORT detector run调用 | 72.5 | 62.9 | 50.0 |
| blk getData | 36.6 | 44.5 | 41.8 |
| seg getData | 4.3 | 45.7 | 42.9 |
| det getData | 7.1 | 49.1 | 48.1 |
| 全部读回最早start→最晚完成 | 53.7 | 49.2 | 48.3 |
| Host CTD regions | 34.0 | 36.9 | 15.1 |
| Host mask scale/read/threshold/write | 35.8/106.4/31.1/6.9 | 39.2/89.0/27.3/7.7 | scale29.8；其余三次往返由既有native候选省略 |
| 完整110模板async总时长 | 1318.5 | 1148.2 | 1004.7 |
| Detector pipeline hits/misses | 40/0 | 37/3 | 37/3 |

并行三条getData同时等待GPU完成，不能相加为140ms。顺序组53.7ms窗口含前两输出SHA的插入等待，实际三个getData累计48.0ms；末个det SHA另在下载完成后执行。blk首下载包含尚未完成的GPU工作，去掉它会让seg或det承担这份等待，不能把36–45ms称为blk传输成本。GPU完成后的4.2MB/8.4MB下载在该顺序QA中只有4.3/7.1ms，少读blk/半个det无法从这份证据推导100ms收益；没有做额外GPU压缩或输出协议改动。

实际Comlink detector RPC发出到Worker预处理开始尚有186.5/123.4/108.6ms，均紧随early bubble Session创建完成；这是初始化/Worker调度窗口，不能称纯推理或纯传输。延后所有early Session到detector提交的既有`aftersubmit`已在前序QA/普通实验无稳定收益，故这里没有重新实现此方案。CTD本体仅15–37ms，亦不是167–250ms可删预算。模板全量完成时间处于后台且部分准备较晚，现日志没有每模板ready时间或原生GPU编译时间，不能直接把seed总时长从visible扣去。

### readparallel与native GPU threshold的普通27样本

汇总`.tmp/cold-budget/1790866767884-results.json`，每个variant三轮、每轮new-profile/same-worker/retained-cache-new-process各一图。普通样本没有开启上述SHA诊断；父任务已通过按相同image+cacheState分组的OCR/最终RGBA门。以下全部ms，固定目标仍为fresh2845.5、retained restart2332.7；warm不参与这两个预算门。

| 组合 | 三次fresh visible | fresh中位 | retained restart中位 | warm中位 |
| --- | --- | ---: | ---: | ---: |
| chosen | 2523.8 / 3259.0 / 2829.7 | 2829.7 | 2111.5 | 1801.6 |
| chosen+readparallel | 3363.0 / 3193.2 / 2368.1 | 3193.2 | 1969.3 | 2311.7 |
| chosen+readparallel+threshold+thresholdgpu | 2311.7 / 3156.3 / 2392.5 | 2392.5 | 2042.6 | 1924.4 |

第三组本轮fresh和restart中位均过固定预算，最快两轮fresh低于目标、另一轮3156.3ms；仍应等待独立最终确认与第二图质量门。readparallel单独没有普通fresh收益，第三组的合并结果不能全归于并行传输。

九个fresh的detector模板hit分别chosen39/30/16、parallel29/36/36、合并28/40/32；合并最快2311.7ms的样本bubble仅15/25hit（10miss），另外两次25/25。所有组OCR33+14与inpaint13均已ready；较快样本仍有miss，而某个全hit样本总耗时3156.3ms。这说明当前miss数量不足以证明百毫秒编译瓶颈，缺少逐模板ready/native执行数据时，不因剩余miss扩大并发或重复记模板收益。


## 主控最终确认

最后五轮普通对照已完成：新 profile 中位数 **2431.2 ms**（2405.7–2783.9），缓存重启 **2042.7 ms**（1830.3–2142.5）；两个状态各五轮均低于原定2845.5/2332.7 ms预算。第二图及主图原流程的四组原始检测SHA、OCR、最终RGBA校验通过。详见 [最终报告](cold-start-budget-final-2026-10-01.md)，其中区分固定预算、同期对照、工作转移和先前长尾。所有实验开关默认关闭。
