# 完整模板之后的首图 GPU 候选

2026-10-01。ORT Web 保持 1.27.0，同一 detector / bubble / Paddle OCR / inpaint，float32，原输入尺寸和全部 ROI。暂不讨论 Firefox。本 agent 实现和 CPU 检查候选；真实浏览器和 GPU 由主控串行验证，质量结果见下文。

当前组合的新 profile 中位数为 3631.9 ms，目标 2845.5 ms，剩余 786.4 ms。detector / bubble / OCR 阶段合计 1308.6 ms **含等待与 CPU 后处理**，不能全部视作 GPU 算力瓶颈。完整模板异步编译已包括在当前组合里，下面不再次扣除旧编译收益。

## 已实现、默认关闭

| runner flag / 底层开关 | 改动 | 能减少的工作 |
|---|---|---|
| `nofence` / `__shinobuColdStartGpuPreprocessNoFence` | 不在 detector 预处理之后等待整条 GPU queue 完成；纹理、uniform、通道缓冲保留到输入 Tensor.dispose | 让 ORT 的 CPU 建图/编码与已提交的 GPU 预处理重叠，省一次 GPU→Worker 调度往返 |
| `directprep` / `__shinobuColdStartGpuPreprocessDirect` | 同样的 bilinearSample 和 color.r/g/b 直接写单 NCHW buffer | 每个 1024² 输入少 3 个 4MiB 通道缓冲、3 次复制，总共少复制 12MiB |
| `reuse` / shader probe `config.reusePipelines` | 严格相同的 WGSL、entryPoint、constants、auto layout 复用已完成 Async 编译的 Pipeline / ShaderModule 实例 | 少同步原生对象创建与模块验证；没有再次节约已经隐藏的编译 |

源码分别在 `packages/model-runtime/src/workers/gpuPreprocess.ts` 和 `benchmark/perf/src/cold-start-worker-probe.js`。未修改 onnx-worker.ts、模型文件或依赖。所有开关缺省 false；root runner 负责注入。

### 无前置 queue 栅栏

GPU 预处理已经在 ORT 共用的 `ort.env.webgpu.device.queue` 上 submit，后续 inference 使用同一个输入 GPUBuffer。候选靠同 queue 的提交顺序保证依赖，同时把中间资源寿命延长至 Worker 读取完输出并 dispose 输入之后。没有把模型推理改为并行 session.run。

下载仍 await stagingBuffer.mapAsync 后才访问数据。映射前不需要再等完整 queue；[GPUQueue API 文档](https://developer.mozilla.org/en-US/docs/Web/API/GPUQueue/onSubmittedWorkDone)说明 mapAsync 本身保证相关已提交工作完成。ORT 1.27 自己的 [downloadGpuData](https://github.com/microsoft/onnxruntime/blob/v1.27.0/js/web/lib/wasm/jsep/webgpu/gpu-data-manager.ts)也采用 copy→flush→mapAsync，没有前置 queue 完成等待。

此候选不会缩短 GPU 预处理运算本身。收益上限来自原栅栏等待中可以重叠的 CPU 工作及调度往返；若实际预处理已很快，整体收益可能很小。

### 单 NCHW 写入

新 WGSL 从原字符串派生，只替换目标 bindings 和 `dst_ch0/1/2` 的 store 索引。原 bilinearSample 整段与原 shader 逐字相同；每个像素使用相同采样坐标和 float32 运算，padding 仍写 0。

GPU 编译器如何排布指令仍需要验证，所以不能单凭源码相同运算宣称逐位相同。新 WGSL 不在此前只捕获原路径的模板集中，首图需编译这个很小的 shader；报告必须计入该成本。没有把少分配 12MiB 误算成必然减少多少毫秒。

### 复用 Pipeline 实例

probe 只把已成功完成 `createComputePipelineAsync` 的对象加入 ready Map。待编译的 seed、显式 layout、带 compilationHints 的 ShaderModule、不同 constants 继续走原生路径，绝不把 Promise 当同步 Pipeline 返回。key 归属当前 GPUDevice，仍保留原模板 runtime/model/浏览器可见设备指纹核验。

ORT [ProgramManager.build](https://github.com/microsoft/onnxruntime/blob/v1.27.0/js/web/lib/wasm/jsep/webgpu/program-manager.ts)在实际首次执行时生成 uniform layout 和 Artifact，使用同步 createComputePipeline；此实验仅替换其最终拿到的、完全相同程序的 Pipeline 句柄，不跳过 ORT 的 ProgramInfo / shape / uniform 初始化。

每个 Comlink run 完成后会上传 `kind: pipeline-reuse`，包括 `model/moduleHits/pipelineHits/pipelineMisses/nativeSyncMs`。显式布局预处理、未捕获的 GPU CTC / directprep shader 也会计为 native miss，不能把全部 misses 当 OCR shape 不覆盖。

restart 测试应保留 reuse probe、去掉 `config.shaders`，让它复用生产历史 warmup 完成的 Async Pipeline；这样不会重复预编译 seed。历史测试模板命中后，124 次同步创建累计只剩 12.043 ms（不同旧组，不是当前上限）。这个候选不能再承诺旧模板节约过的约 1.2 秒。

## 质量运行与性能运行分开

`verifyinput` / `__shinobuColdStartGpuPreprocessVerify` 仅供质量检查：为 NCHW 下载副本计算 SHA256，通过现有 InitMark 发出：

```json
{"phase":"detector-input-sha256","model":"detector","bytes":12582912,"dims":[1,3,1024,1024],"sha256":"...","startedAt":0,"durationMs":0}
```

质量开关在原路径额外给输出 buffer 加 COPY_SRC。它直接调用下载 closure，**不调用 tensor.getData**；ORT 1.27 的 [Tensor.getData](https://github.com/microsoft/onnxruntime/blob/v1.27.0/js/common/lib/tensor-impl.ts)会将 location 改为 cpu，使用该方法会改变后续 inference 的 feed 路径。下载、hash 和验证增加的等待不用于性能比较。

主控构建后可串行复跑（使用对应浏览器捕获的模板，145 和 151 的指纹不能混用）：

```powershell
# 当前 151 模板和 151 浏览器配对；旧 145 对照应同时换回对应模板和可执行文件。
$budgetBrowserPath = 'C:\Users\STONE\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe'
$budgetShaderTemplates = '.tmp/cold-start-experiments/templates-chromium151.json'

# 质量组：比较 NCHW SHA、原始 detector 输出 SHA、最终全图 RGBA SHA、全部 OCR box/方向/尺寸/文本/confidence。
node benchmark/perf/src/run-cold-budget-experiments.mjs --variants=all-direct-latefonts-verifyinput-verifydet,all-direct-latefonts-nofence-verifyinput-verifydet,all-direct-latefonts-nofence-directprep-verifyinput-verifydet --rounds=1 --runs=1 --init-profile --browser-executable=$budgetBrowserPath --templates=$budgetShaderTemplates

# 性能组：质量开关关闭；相邻轮反转顺序，同时测 fresh / retained restart。
node benchmark/perf/src/run-cold-budget-experiments.mjs --variants=all-direct-latefonts,all-direct-latefonts-nofence,all-direct-latefonts-nofence-directprep,all-direct-latefonts-reuse --rounds=2 --restart --init-profile --browser-executable=$budgetBrowserPath --templates=$budgetShaderTemplates

# CPU-only，不调用 GPU。
node benchmark/perf/src/check-gpu-preprocess-scheduling.mjs
node benchmark/perf/src/check-cold-shader-probe.mjs
node node_modules/typescript/bin/tsc --noEmit -p packages/model-runtime/tsconfig.json
```

CPU 检查已通过：fence 返回时机、同一次 submit、复制次数、资源寿命和 dispose、COPY_SRC、质量 metadata、不调用 getData 改 feed、采样源码相同；probe 检查 strict key 命中、constants/explicit-layout/hints 未命中回退和计数。CPU mock 不执行 WGSL，无法替代真实 GPU 输入/输出逐位验证。

## Chromium 151 质量检查结果

主控原始汇总 `.tmp/cold-budget/1790850111750-results.json`，浏览器 151.0.7922.34。依次运行 `baseline-verifydet-verifyinput`、`nofence-verifydet-verifyinput`、`directprep-verifydet-verifyinput`；所有模型 provider 为 WebGPU，最终全图 RGBA SHA 完全一致。原始输入及全部检测输出严格逐字节相同：

| 对象 | bytes | 三方案相同的 SHA256 |
|---|---:|---|
| NCHW float32 `[1,3,1024,1024]` | 12582912 | `74a1604ddb29953a37f41646f50be1e856ae64cee6f50d506f75e99428862d87` |
| blk | 1806336 | `92c48c1ff39b040d3f0c8952b0f2eba910d68796681637c8928e873b9adf48e1` |
| seg | 4194304 | `1c09dd1ffe00135583ccb6fd943907ab435634e21c455d41968aed054dd6505f` |
| det | 8388608 | `5b1e1a14284fc72a5a27ec84a3de19ee3efdd047cdde11d3f5db5803471281e4` |

这一组用于质量和诊断，不用于推导速度收益：没有模型模板预编译，input 下载会强制等待预处理完成；第一次运行还受到新浏览器后端和驱动缓存影响。

| 子阶段 ms | baseline | nofence | directprep |
|---|---:|---:|---:|
| 预处理（含 input verify） | 635.0 | 104.5 | 3594.2 |
| input 下载+SHA（预处理内） | 28.0 | 86.1 | 25.7 |
| detector session.run（未必等待 GPU 完成） | 191.0 | 35.3 | 66.2 |
| 第一个 blk getData | 1037.2 | 512.3 | 462.1 |
| 后续 seg getData | 5.2 | 11.1 | 6.0 |
| 后续 det getData | 7.2 | 6.3 | 8.2 |

首个 blk getData 包括等待模型 GPU 工作完成，不能称为 1037ms 的纯下载。后续两个输出实际读回只有 12.4 / 17.4 / 14.2ms；新增 det/seg 压缩不足以补当前 786ms 缺口，主控据此先放弃该复杂度。

directprep 在 input verify 之前用了 3568.5ms；现有 overall 不能区分 synchronous pipeline 创建、texture upload、原 queue fence。其单独新 shader 尚未预热，不能把此值直接归因于单缓冲的运算更慢。已增加 `detector-preprocess-module/layout/pipeline/texturecopy/fence` InitMark，供下一组拆分；无 observer 不读 clock，CPU check 已覆盖。fence 包含提交完成等待，可能包含延后的原生编译；也不能称为纯 shader 运算时间。主控当前性能组合先只加入 nofence / reuse，directprep 保持关闭。

## 等待子阶段数据的候选

detector 当前逐个输出 getData，整个 tensor 下载。能先尝试同一次 inference 的输出 Promise.all(getData)，保持原组装次序，不并行 session.run。ORT 下载在 await mapAsync 前已有各自的 readback buffer 和 copy/flush；这种并行是独立结果映射，需用实际 readback 子阶段和原输出 SHA 验证。

当前检测流程在 det 存在时只使用 det 通道 0 和 seg 通道 0，永不读取 blk，即使没有检测区域也直接返回。跳过 blk 下载可省搬运，但仅指定 fetches 不能宣称跳过 blk 分支计算：Web 1.27 的 RunOptions 没有 onlyExecutePathToFetches，C++ [执行路径筛选](https://github.com/microsoft/onnxruntime/blob/v1.27.0/onnxruntime/core/session/inference_session.cc)在 ENABLE_TRAINING 编译保护中。

如果 readback 是明显瓶颈，无损压缩可保留 det 通道 0 的原始 float32 字节，只裁去 CPU 原本不使用的 padding；seg 只需阈值图，可 32 个像素打包成 u32。CPU 规则 `float32Value > JS double 0.3` 对全部 IEEE float32 可写成 unsigned bits 在 `[0x3e99999a, 0x7f800000]` 内，包含正无穷，排除负数和 NaN，避免直接用 `> f32(0.3)` 的边界差异。解包为 bool Uint8Array 后沿用 CPU mask canvas、轮廓与坐标计算。

det 的 contour score 使用 JavaScript double 逐个求和，不应换成 GPU float32 归约，否则相同模型精度也可能改变置信度或 0.6 阈值决策。当前不假设 GPU 压缩一定值得新增一次 compute；应先由 `ort-run/output-readback/detector-gpu-preprocess` 标记确定实际可减预算。

## 新候选：原 letterbox 使用 auto layout

151 模板 index 0 是原 `LETTERBOX_SHADER`，模板异步预编译使用 `layout: 'auto'`。实际预处理之前使用显式 BindGroupLayout / PipelineLayout；reuse probe 为避免错误共享显式布局而回退同步创建，所以它一直是 detector 剩余的那个 pipeline miss。主控观察的 JS create 时间约 0.2ms 仅度量同步 API 返回，不能据此排除首次 submit 后的驱动编译，也不能据此承诺百毫秒收益。

已增加默认关闭的 `__shinobuColdStartGpuPreprocessAutoLayout`。只有严格布尔 true 启用：使用相同 WGSL / entryPoint / uniform bytes / buffer usage / 复制和 dispatch，把 pipeline descriptor 的 layout 改为 `'auto'`，通过实际返回的 `pipeline.getBindGroupLayout(0)` 创建 BindGroup。启用时不创建不用的显式 BGL / PipelineLayout。缓存条件加入 layout 模式，保留 device / direct shader 模式条件。不开 directprep 时仍用原三个 float32 通道缓冲；auto 开关本身不选择 direct shader。

此候选让 index 0 已完成的异步模板可以由现有 `reuse` probe 直接返回，不再为相同 WGSL 创建显式布局的另一条 pipeline。它不把全部 109 模板已经隐藏的编译再次计作新增收益。若预处理开始时 index 0 还未准备好，probe 仍同步创建原 API pipeline；候选不会等待 seed Promise 或跳过真实 dispatch。

CPU 检查 `node benchmark/perf/src/check-gpu-preprocess-scheduling.mjs` 已通过：默认显式布局；严格 true 开关；同 device 在 explicit→auto→auto→explicit 间正确重建或命中缓存；非布尔 `'true'` 保持默认；实际 pass 绑定 pipeline 对应 BGL、纹理和四个 buffer；uniform 原字节、分配描述、4096 workgroups 和三个复制保持一致；baseline / nofence 的销毁恰好一次；无 observer 不读 clock；独立 direct flag 仍决定 shader。`tsc --noEmit` 也通过。

主控注入 Worker scalar 并统一 build 后，先在相同 Chromium 151 / 同模板 / 相同组合上做原 NCHW、三个原始 detector 输出 SHA、完整 OCR 和最终全图 RGBA 质量门；同时核对 pipeline-reuse detector 是否 40/40 hits（index 0 必须已 ready）、GPU validation error / device lost。性能组关闭 verify，比较相邻反转的 auto false / true，观察完整 fresh / restart 时间及首个 submit 到 output-readback 完成的窗口。没有浏览器/GPU 实测前不报告确定节省数值。

## 三个检测输出提前排队读回

目前 Worker 在 `runDetectWithGpuPreprocess` 内按原 outputs 顺序调用并 await 每个 getData，然后组装 TensorTransport。三个输出合计 14,389,248 bytes，全部保留。ORT 1.27 的 [createDownloader](https://github.com/microsoft/onnxruntime/blob/v1.27.0/js/web/lib/wasm/jsep/backend-webgpu.ts#L832) 调用 [downloadGpuData](https://github.com/microsoft/onnxruntime/blob/v1.27.0/js/web/lib/wasm/jsep/webgpu/gpu-data-manager.ts#L149)：每次分配独立 staging buffer，在第一次 await 前同步编码 copy、flush/submit，再 await 私有 mapAsync；flush 同步提交并清空 encoder。不同 Tensor 的调用不会同时编辑 encoder。现有 inferenceQueue 需继续覆盖全部下载，不并行模型运行。

因此最小候选是先启动三个不同 Tensor 的 getData，再等待全部 settled，按原 entries 次序组装、验证和 transfer。它仍是三个 staging、三个 submit 和三个 map；能省的是第一个 map 回来后 Worker 再为后两个输出排队的空隙。旧 151 诊断样本中后两项合计 12.4 / 17.4 / 14.2ms，这只是可改等待链的粗预算，仍包含不可省的复制和 CPU clone；不能把第一个 blk 读回的 462–1037ms GPU completion 算作可删下载，也不能据此承诺解决百毫秒缺口。

安全控制流示意（实际 Worker 由主控修改，本 agent 未改）：

```ts
const entries = Object.entries(outputs);
const settled = await Promise.allSettled(entries.map(async ([, tensor]) =>
  tensor.location === 'gpu-buffer' ? await tensor.getData() : tensor.data));
for (const item of settled) {
  if (item.status === 'rejected') throw item.reason;
}
// 按 entries 原顺序取 settled[i].value，然后沿用原 transport / SHA / transfer。
// 外层 finally 在全部下载 settled 后才 dispose outputs、input 和 bitmap。
```

不能直接用 Promise.all 的早退错误路径：[Tensor.getData/dispose](https://github.com/microsoft/onnxruntime/blob/v1.27.0/js/common/lib/tensor-impl.ts#L489) 维护每个 Tensor 的 isDownloading；一个下载拒绝时，其他下载可能仍 pending，finally 的 dispose 会抛出 being downloaded，遮蔽原错误并跳过余下清理。CPU-only 检查已使用真实安装的 ORT 1.27 Tensor，构造三个私有 deferred downloader：证明三个调用立即启动；故障后的 fail-fast dispose 会抛；等待 allSettled 后失败和成功 Tensor 均能各释放一次。CPU 检查未执行 GPU 指令，不代替质量门。

并发 staging 的请求峰值最多 13.72MiB，相比顺序最大 8MiB 增加约 5.72MiB，总创建字节不变；这是 requested buffer bytes，非实际显存。性能比较应增加全部 readbacks 的起止总区间，不能累加三项重叠 duration。依然用原输入和三个输出 SHA、全 OCR / 全图 RGBA、设备错误和 requested buffer peak 验证。

### 一个合并 staging 的可行性

同版本 [jsepRunAsync](https://github.com/microsoft/onnxruntime/blob/v1.27.0/onnxruntime/wasm/pre-jsep.js#L29) 在 run 返回前 flush 待执行模型命令；无需借由第一个 getData 才提交最后一批 compute。ORT 管理的输出 GPUBuffer 包含 COPY_SRC。仅针对三个非空 gpu-buffer / float32 输出，可以用一个 14,389,248B MAP_READ|COPY_DST staging、一个 encoder 的三个 byte copy、一 submit、一 map，再从 mappedRange 分别 slice 原字节区间生成三个独立 Float32Array；只销毁 staging，原 Tensor 仍由 finally dispose。没有算术、降精度或少传通道。

该路径才实际减少两个 submit/map/staging 对象，但不减少字节搬运，仍需三份原输出 CPU clone。若先 clone 整块再 slice，又多复制 14MB，应避免；若用一整块 CPU ArrayBuffer 的三个视图，则现 transferables 三次 push 同一 buffer 会抛 DataCloneError，需要去重且改变 transport 的 buffer ownership。因此暂优先评估保持原 downloader/三个独立 CPU buffer 的并发最小改法，只有后续 trace 显示纯读回尾段仍明显才值得做合并 helper；本次没有实现合并 helper。

## 补齐未捕获的 GPU CTC 模板

原 Chromium 151 文件的 109 条 seed 没有 `PADDLE_CTC_SHADER`，与 OCR 实际执行中出现的额外 1 次 pipeline miss 相符；具体 miss 归属仍需日志确认。该 shader 的 rows/classes 是 uniform，128 workgroup 固定，没有图像 shape literal，原代码与精度保持不变。

已生成独立 `.tmp/cold-start-experiments/templates-chromium151-ctc110.json`。新增末条 `main` / `auto` / `constants: {}` / model `paddleocr_v6_medium_rec`。原 109 文件及各 seed、ORT version、modelSignature、设备/runtime key 原样保留；`config.templateKey` 是设备指纹，不能因新增 shader 改掉。新增 pipeline key 按 probe 的 `[code, entryPoint, sorted constants]` 规则计算。

CPU 生成器 `node benchmark/perf/src/create-cold-ctc-templates.mjs` 验证 TS AST 静态 template literal 与实际 transpiled 运行 export 逐字一致、总数 110、原 109 未变。WGSL SHA256 `26f9ac67b7aac08fc0555121e02ac7664a2bbf4c193d0f2e202d27cc552eceb5`；pipeline key SHA256 `c25187dc40f74be26b7cfb2f6e6a44dc15a132479a71e0962646b544b9b19717`。`templateExtension` 标明源码和文件 hash、基底 hash、非 GPU 捕获。新 seed 是否及时 ready、额外编译争用和全流程收益均留待主控 `--templates` 串行对照；不能把旧 109 的收益再计一次。

后续主控 QA `.tmp/cold-budget/1790857001697-results.json` 已验证 auto layout + CTC110：两组 detector 40/40、bubble 25/25、OCR 首批 33/33/第二批 14/14、inpaint 13/13，pipelineMisses/nativeSyncMs 都为 0。原 NCHW、三个完整 detector 输出、最终 RGBA SHA 及主控核对的完整 OCR 均相同，仅有 webgpu provider，无设备丢失或 uncaptured error。这里两组都已启用相同 seed/layout，不能用其中时间差推导 shader 候选收益；上传开关的 API 计数对照及单样本的限制记录在 `cold-budget-gpu-upload-2026-10-01.md`。
