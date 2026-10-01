# 同版本 JSEP 的 CPU→GPU 上传候选

2026-10-01。原 ORT 1.27.0 / 全模型原字节 / float32 / 原输入和全部输出。主控串行构建与 GPU 验证；此处先记录源码依据和 CPU 检查，不报告未测收益。

## 为什么值得试

memory16 诊断记录共 2142 次 createBuffer、843 次 destroy、1069 次 queue.submit，请求 buffer 累计约 1.418GB、未 destroy 约 1.14GB。已有 probe 没有区分权重上传、数值输入上传、compute、readback 和图像复制，**不能把 1069 全算作模型初始化**。同样，GPUDevice 返回后首次 submit 的 356ms 包含首个上传之前的模型加载/解析/准备，不能直接减去。

ORT [GPUDataManager.upload](https://github.com/microsoft/onnxruntime/blob/v1.27.0/js/web/lib/wasm/jsep/webgpu/gpu-data-manager.ts#L226) 每个 CPU→GPU payload 都创建 mappedAtCreation MAP_WRITE|COPY_SRC 暂存 buffer，复制 CPU 字节、unmap、创建独立 encoder、copy、submit、destroy；其 destination 是原 GPUDataManager buffer。上传来源包括 initializer 和普通 CPU 数值输入，不能仅凭调用函数归为权重。

本次 [Chromium 151.0.7922.34 的 GPUQueue](https://github.com/chromium/chromium/blob/151.0.7922.34/third_party/blink/renderer/modules/webgpu/gpu_queue.cc#L103) 对 submit 使用 FlushNow；writeBuffer 使用 EnsureFlush(eventLoop)。原每次上传的立即 IPC flush 可以由 writeBuffer 合并。它也可能延后早期上传、减少 CPU/GPU overlap，收益须用全流程比较确认。

Chromium 该版本 [DEPS](https://github.com/chromium/chromium/blob/151.0.7922.34/DEPS#L406) 固定 Dawn revision `583f3600453cc982a3dac39308cac8939875d7af`。该 [wire Queue](https://github.com/google/dawn/blob/583f3600453cc982a3dac39308cac8939875d7af/src/dawn/wire/client/Queue.cpp#L97) 的每次 submit 还安排内部 OnSubmittedWorkDone callback。writeBuffer 小于 4MiB 时同步序列化 payload，大块时同步复制到 MemoryHandle；[serializer](https://github.com/google/dawn/blob/583f3600453cc982a3dac39308cac8939875d7af/src/dawn/wire/ChunkedCommandSerializer.h#L109) 在调用内复制，API 返回后不再依赖原 WASM Uint8Array view。

这不是零复制。[native Buffer.UploadData](https://github.com/google/dawn/blob/583f3600453cc982a3dac39308cac8939875d7af/src/dawn/native/Buffer.cpp#L978) 仍使用 DynamicUploader 暂存和 GPU copy；JS probe 看到少分配 buffer，也不能代表驱动内部没有暂存或实际显存必然降低。

## 最小隔离实现

`build-cold-start-jsep-js.mjs` 的 esbuild onLoad 仅转写 `lib/wasm/jsep/webgpu/gpu-data-manager.ts`，没有改 node_modules、模型、WASM 或正常扩展 bundle。私有转换在 `cold-jsep-upload-write-patch.mjs`，原源码 SHA256 固定为 `e559e7bf7424b2cab2b7c70ba34383bbcece6816c031421b5c4c5c5eb4db45d3`；版本或源码不同即停止此候选构建。

在原 cache/size 校验之后，仅当 `__shinobuColdStartUploadWriteBuffer === true`、`srcLength > 0`、`srcLength % 16 === 0` 且 destination 有 COPY_DST 时执行 `queue.writeBuffer(destination, 0, data)`。其他情况保留原上传代码；原 LOG_DEBUG 仍恰好调用一次。开关默认关闭，root runner 要求同时使用 jsepjs 独立 Worker。

严格 16 字节条件保留 ORT 的 padding 语义：原暂存会复制 `ceil(N/16)*16` 字节，其中 padding 全零。仅写 N 字节可能留下 freelist buffer 的旧 tail，所以本次不替换非整 16 字节的 payload。源 Uint8Array 可以有自己的 byteOffset，直接传 view，不传整个 WASM heap 或隐含多余字节。没有新增 await、fence 或 buffer lifetime 变更。

构建 metadata 的 `sourcePatches` 包含原/修改后源码 SHA、patch 名称、默认关闭 flag 和 isolated scope。

## 新诊断与收益边界

`cold-gpu-buffer-submit-probe.js` 原批量终点不变，新增：

| 字段 | 定义 |
|---|---|
| uploadStagingBuffersCreated / uploadStagingBytesCreated | 成功返回的 createBuffer 中，mappedAtCreation 且 usage 恰好 MAP_WRITE|COPY_SRC 的请求模式；没有 model/initializer 标签 |
| queueWriteBufferCalls / queueWriteBufferBytes | 正常返回的 writeBuffer API 次数和请求字节；TypedArray offset/size 按元素，ArrayBuffer/DataView 按字节 |
| firstWriteBufferAt / firstWriteBufferMsSinceDevice | 首次 writeBuffer API 进入时间及相对 device 的间隔；不是 GPU 实际完成时间 |

异步 GPU validation error 仍可能发生，API 计数不等于传输成功或物理提交数。writeupload 下首次 queue.submit 可能更晚，因为早期上传已通过 writeBuffer 排队；不能因此判断 GPU 启动变慢。观察 firstWrite、全部 init/run 阶段、全程及错误记录。

候选最多能删除**满足 guard 的 upload 调用数**对应的显式 staging/encoder/submit；全部字节依然要进入 GPU，compute/readback submit 不变。下文已取得质量/诊断组的准确次数与字节差值，以及三轮正常全流程 A/B。**普通首次启动收益未证实**，仍没有足够证据给确定的毫秒收益上限。其预算机会来自上传 CPU/API/IPC 开销及浏览器调度，不能用 1069×固定单次耗时计算。

## 已完成的 CPU 检查与下一步

```powershell
node benchmark/perf/src/check-jsep-upload-write.mjs
node benchmark/perf/src/check-gpu-buffer-submit-probe.mjs
```

两项通过。前者提取实际 patched upload 方法并 transpile，在小 buffer mock 上覆盖 strict flag、0/1/4/15/16/20/32B、带 byteOffset 的源、payload 原字节/零 padding/不写尾部、cache/size 原错误、缺 COPY_DST 原路径、writeBuffer native 错误不重试、单次 LOG_DEBUG。后者覆盖各 BufferSource 的计数单位、参数/返回值/this 转发、同步错误不计、staging 请求模式、firstWrite、原 submit/批量终点/device incidents。

本 agent 没有运行构建、typecheck、浏览器或 GPU。主控统一 isolated build 后执行质量/诊断门，结果见下；接下来关闭质量/诊断 probe，测相邻反转的 jsepjs 同组合 writeupload 关闭/开启。输出并发读回的等待链仅约 12–17ms，主控已暂缓该方向。

## 主控 Chromium 151 质量与 API 计数验证

原始汇总 `.tmp/cold-budget/1790857001697-results.json`，明细分别为 `benchmark/perf/reports/ui-jank-2026-10-01T12-16-57-330Z.json` 和 `ui-jank-2026-10-01T12-17-07-545Z.json`。两组使用相同 isolated Worker SHA `a21f65fcafd04da1d04decaf89eb09b581c5180d42bebefba07639fbafdbfae8`、相同 CTC110 模板 SHA `c2f656cba2edb329d334861634f7e0c56616d80409828d62240ac68e557f04ba`，只切换 writeupload；均为 new-profile，带 verifyinput / verifydet 和诊断。

主控核对完整 OCR、最终 RGBA、provider 一致；本 agent 从两份明细重读四个原始 SHA 也逐字相同：原 12MiB NCHW 和完整 blk / seg / det，与前述 Chromium 151 原 SHA 相同。全部 provider 记录仅 webgpu，deviceLost=false，uncapturedErrors=0。2921×4096 最终图 SHA 为 `d3bd5084867c64501ac615d6baacb8cb31ee38f6b93af28cb7ce78f2d1d8ba97`。

| API 请求指标 | 同组合开关关闭 | writeupload 开启 | 差值 |
|---|---:|---:|---:|
| upload staging 创建数 | 804 | 31 | −773 |
| upload staging 请求字节 | 216,558,480 | 75,568 | −216,482,912 |
| queue.submit 次数 | 1069 | 296 | −773 |
| queue.writeBuffer 次数 | 3929 | 4702 | +773 |
| queue.writeBuffer 请求字节 | 366,224 | 216,849,136 | +216,482,912 |
| 全部 buffer 创建数 | 2142 | 1369 | −773 |
| 全部 buffer destroy 次数 | 843 | 70 | −773 |
| 全部 buffer 累计请求字节 | 1,417,663,440 | 1,201,180,528 | −216,482,912 |
| 未 destroy 请求字节 | 1,141,293,568 | 1,141,293,568 | 0 |
| 未 destroy 请求字节峰值 | 1,144,439,296 | 1,144,439,296 | 0 |
| live / peak buffer 对象数 | 1299 / 1300 | 1299 / 1300 | 0 |

次数和字节的独立差值完全一致：773 次 staging 上传以原 216,482,912 字节迁移到 writeBuffer。移除约 96.1% 的 staging 调用、72.3% 的显式 queue.submit。剩余 296 个 submit 中，31 对应保留的 upload descriptor 模式，其余 265 仍未细分为 compute / readback / 图像复制；不称作 265 次模型推理。CPU→GPU 字节没有减少。Live/peak 完全不变；这些仍是 JS 请求 buffer 描述统计，不能报告实际 VRAM 下降。

两组 pipeline-reuse 均为 detector 40/40、bubble 25/25、OCR 首批 33/33 和第二批 14/14、inpaint 13/13，pipelineMisses 与 nativeSyncMs 全部为 0。Auto layout 和新增 CTC seed 在此 fixture 的首图已覆盖先前剩余 miss；不把此覆盖计作 uploadwrite 的新增编译收益。

诊断单样本的 visibleResultMs 为 3479.32 / 2419.75ms（内部 totalMs 为 3227.5 / 2238.6ms）。质量下载和 SHA、诊断计数均启用，只有各 1 个样本，系统 CPU busy 也不同；这两个数字不是 median，不证明目标达成，也不作为正式加速百分比。随后正常三轮结果如下。

## 正常三轮 A/B：首次收益未证实

来源 `.tmp/cold-budget/1790857271448-results.json`。18 个普通样本为两个同组合、三轮、fresh / same-worker / retained-cache-new-process；只切 writeupload。Worker 和 CTC110 文件 SHA 与上述 QA 相同。性能组不启用原始输入/检测输出 SHA 下载和 InitMark/API 计数诊断，仍检查最终全图 RGBA。

| visibleResultMs | 开关关闭 | writeupload 开启 |
|---|---:|---:|
| fresh，第 1 / 2 / 3 轮 | 3152.90 / 3285.33 / 2481.14 | 3205.33 / 3137.65 / 3300.86 |
| fresh 中位数 | **3152.90** | **3205.33** |
| same-worker 中位数 | 2509.56 | 2461.75 |
| retained restart 中位数 | **2159.56** | **2110.81** |

Fresh 的 2845.5ms 固定目标两者都未达到，分别还差 307.40 / 359.83ms。Retained restart 的 2332.7ms 目标两者都达到。三样本与一次广泛加速的异常波动不足以认定 writeupload 稳定变慢；同样不能用 QA 的单次快结果认定它加速冷启动。**当前保留为默认关闭的实验候选，没有普通首次收益证明。** API 减少和质量通过的结论仍有效，不能将它们等同于全程加速。

六个 fresh 全部为 detector 40/40、bubble 25/25、OCR 33/33 + 14/14、inpaint 13/13 命中，零 pipelineMisses/nativeSyncMs。writeupload 的完整预编译计时 898.9 / 901.1 / 834.8ms，比关闭的 1205.6 / 1131.5 / 1084.0ms 更短，但全程未稳定降低；重叠工作总时长不能直接从关键路径扣除。

本 agent 重读 18 份报告：最终 RGBA、四个 provider、检测数量、17 个 OCR ROI 位置/方向/输入维度/文字/是否接受均保持一致；相同 cacheState 内 OCR confidence 也一致。跨 cold/warm 不能称全部逐位一致：现有 width-bucket 热路径首个 chunk 从 1 改为 2，第一个 ROI confidence 从 fresh/restart 的 0.9715988535357322 变为 same-worker 的 0.9039178292979576，两个 upload variant 的热路径结果相同。优化质量门按 image + cacheState 比较，保持原有 batching。

快样本在 verifyinput map 之前以及 CPU 后段已经更快。QA write 的 WASM instantiate 46.1ms / detector create 594.6ms，而 QA ref 为 129.5 / 874.3ms；这些差异不能由后来的输入 map 引起。普通第 3 轮关闭开关时，fresh 2481.14ms 和紧接 same-worker 1848.08ms 同时较快，mask/finalize 约 220.1/149.3ms，比其他 fresh 约 308.9–338.9/228.5–237.7ms 更短。OCR preprocessing 却为 84.1ms，比慢样本约 67.8–71.9ms 更长，不能将所有差异归于统一 CPU 频率比例。`cpuBusyPercent` 来自全系统逻辑 CPU idle ticks，只能说明总忙闲，未记录 Worker 线程排队、实际频率或 GPU 进程 CPU 成本，不能据此确定根因。

主控随后原 fence 三轮 `.tmp/cold-budget/1790858304760-results.json` 中位 noFence3262.62 / fence3310.95ms，恢复 fence 没有稳定收益。继续优先真实源路径和已有 dispatch64 独立对照；小 uniform API 成本仅提出计数接口，不先实现 arena。18 样本阶段明细及最小调度候选见 `cold-budget-gpu-scheduling-2026-10-01.md`。
