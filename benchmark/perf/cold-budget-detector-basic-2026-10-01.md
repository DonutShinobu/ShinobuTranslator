# Detector ORT Session basic 优化候选（2026-10-01）

## 已实现、组合质量验证通过；没有独立速度归因

`packages/model-runtime/src/runtime/modelRegistry.ts` 新增默认关闭实验：

```js
globalThis.__shinobuColdStartDetectorBasicOptimization = true;
```

只在 browser、模型 detector、format=ort、首选 provider=webgpu 同时满足时，将默认 `graphOptimizationLevel: 'extended'` 改为 `'basic'`。显式传入的 Session options 优先；实际 effective options 的序列化值同时用于已创建和创建中的 Session 缓存键。因此切换开关不会错误复用另一优化等级的 Session。原始模型 URL/bytes、initializer 配置、provider 顺序、FP32、1024 输入均不改变。开关没有写入 worker，主控的预算 runner 已接 `basic` variant。

这是一个跳过部分运行时图检查的候选。下文保留当时实施及实验设计；截至本次更新，主控完整组合已包括basic，原detector输入/三输出SHA、完整OCR/最终RGBA质量门通过，例如`.tmp/cold-budget/threshold-preread-quality.json`。普通全组合测试已完成，但没有仅切basic的冻结组合A/B，不能将全组合收益单独归给basic。

## 官方 1.27 实际路径

Web binding 将 disabled/basic/extended 分别传给 native 为 0/1/2，见 [1.27 session-options.ts](https://github.com/microsoft/onnxruntime/blob/v1.27.0/js/web/lib/wasm/session-options.ts)。对 ORT 文件，Session 初始化仍执行 `PartitionOrtFormatModel`，然后执行 `ApplyOrtFormatModelRuntimeOptimizations`；后者从 Level2 循环到指定优化等级。因此 basic 和 disabled 都跳过 saved runtime replay；basic 不会重新执行 ORT 文件已固化的 Level1 优化。FlatBuffer 读取、EP 分配、布局转换、kernel 和权重初始化、SessionState finalization 仍执行，见 [1.27 inference_session.cc](https://github.com/microsoft/onnxruntime/blob/v1.27.0/onnxruntime/core/session/inference_session.cc#L1987)。不能把 Session create 的所有剩余耗时归因于这段 replay。

Level2 的 minimal/runtime 注册 QDQ、ConvActivation、MatMulNBits 和 QDQ cleanup transformers，saved ConvActivation/MatMulNBits 指定 CPU EP，见 [1.27 graph_transformer_utils.cc](https://github.com/microsoft/onnxruntime/blob/v1.27.0/onnxruntime/core/optimizer/graph_transformer_utils.cc#L469)。saved replay 先遍历节点处理子图，再验证记录和目标 provider，不兼容则跳过；见 [SelectorActionTransformer](https://github.com/microsoft/onnxruntime/blob/v1.27.0/onnxruntime/core/optimizer/selectors_actions/selector_action_transformer.cc#L227)。即便记录在 GPU 图上不应用，也不是零成本；其成本大小尚未测量。

[ORT 官方说明](https://onnxruntime.ai/docs/performance/model-optimizations/ort-format-model-runtime-optimization.html)区分已固化优化与 saved runtime 优化：后者只有在当前 EP 分配仍适用时才应用。将当前策略命名 basic，是选择较温和的 Session policy 值；对本 ORT saved replay，它和 disabled 的循环范围相同，不预设 disabled 能再省一层工作。

## 原文件只读检查

使用安装包的生成 FlatBuffer schema 读取当前 dist 的 detector.ort，无转换或修改：

| 属性 | 值 |
|---|---|
| bytes | 94,863,096 |
| SHA256 | `0e9c3979e73092a56404c835e63d9894e7d94b50b356ee29e84ee6a32d65f7d9` |
| ORT **文件格式**版本（不是 runtime 版本） | 6 |
| nodes / initializers | 387 / 280 |
| saved optimizer / action / records | ConvActivationFusion / ConvAct / 43 |
| Conv / LeakyRelu / Relu | 103 / 40 / 12 |
| Q/DQ / MatMulNBits | 0 / 0 |

因此 detector 含 saved runtime records，不能称为完全 Fixed 转换、无 replay 的资产。如果这些 ConvAct 目标由 GPU 接管，extended 仍会检查并跳过 43 组记录；basic 可以跳过注册/遍历/检查。仅有 Session handle.provider=webgpu 并不能证明全部内部节点没有 CPU fallback。若目标节点落到 CPU，basic 会保留非融合图，可能影响性能和 float32 舍入，需要下面的严格门。

```powershell
# CPU-only；直接检查原文件及默认关闭实验边界。
node benchmark/perf/src/inspect-ort-runtime-records.mjs
node benchmark/perf/src/check-detector-basic-optimization.mjs
node node_modules/typescript/bin/tsc --noEmit -p packages/model-runtime/tsconfig.json
```

上述 CPU 检查及 diff-check 已通过。行为检查涵盖默认关闭、非 boolean 值关闭、适用范围、显式 options 优先、切换开关后的 cache identity、相同/不同 options 的 pending identity。CPU mock 不验证模型数学或实际 provider 分配。

## 主控串行实验与质量门

先运行质量组（hash 下载不计作性能）：

```powershell
$budgetBrowserPath = 'C:\Users\STONE\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe'
$budgetShaderTemplates = '.tmp/cold-start-experiments/templates-chromium151.json'
node benchmark/perf/src/run-cold-budget-experiments.mjs --variants=baseline-verifydet-verifyinput,basic-verifydet-verifyinput --rounds=1 --runs=1 --init-profile --browser-executable=$budgetBrowserPath

# 若第一/第二张不同尺寸图片均过门，再在同组合、同浏览器/模板下比较。
node benchmark/perf/src/run-cold-budget-experiments.mjs --variants=all-direct-latefonts-binary-prefetch-nofence-reuse,all-direct-latefonts-binary-prefetch-nofence-reuse-basic --rounds=2 --restart --init-profile --browser-executable=$budgetBrowserPath --templates=$budgetShaderTemplates
```

要求 NCHW 输入 SHA、所有原始 blk/seg/det 的 bytes/dims/SHA、所有 OCR box/方向/文本/confidence、最终整图 RGBA SHA 严格一致；模型 provider 和模型文件 hash 也应相同。预算 runner 自动检查最终 RGBA，原始输入/输出和 OCR 明细由主控的质量比较器校验。报告真实模型 Session options，确认本次确为 basic。两张图片覆盖原本已有的不同 OCR width/batch，且不缩输入或删 ROI。

性能组关闭 verify flags。读 `ort-create-session`、detect 总阶段和首个输出 readback，但不要把嵌套/重叠阶段相加。通过相邻反转的重复运行判断是否稳定；同图新 profile 与 retained profile 分开报告。此候选没有独立预设可节约毫秒数，也不替代全流程 2845.5ms 的预算验证。

## dispatch64 的最小独立实验

JSEP backend 的 `maxDispatchNumber=16` 只决定何时提交累积 dispatch，不更改模型、张量精度或 WGSL 算法；见 [1.27 backend-webgpu.ts](https://github.com/microsoft/onnxruntime/blob/v1.27.0/js/web/lib/wasm/jsep/backend-webgpu.ts)。旧 `run-cold-start-experiments.mjs` 已支持 `--variants=dispatch64`，但该 runner 不含当前完整组合。

若加入主控预算 runner，在选择实际 workerSource（包括 jsepjs 候选）之后，以唯一命中 guard 替换，不修改 node_modules：

```js
if (flags.includes('dispatch64')) {
  const target = 'maxDispatchNumber=16';
  if (workerSource.split(target).length !== 2) throw new Error('Expected exactly one JSEP dispatch limit');
  workerSource = workerSource.replace(target, 'maxDispatchNumber=64');
}
```

同一 patched workerSource 也用于 restart，现有 finally 恢复 dist。若运行的是原生 WebGPU EP，JSEP 属性不是其调度器，此补丁不适用；需确认该 backend 实际工作，不能只靠字符串存在。上方字符串替换是当时建议；主控实际runner已兼容minified两种声明、总occurrence严格为1。完整模板后的64现已完成三轮普通测试，fresh中位16=3411.4/64=3219.4ms，但逐轮方向不一致、startup/CPU/模板覆盖也波动；submit减少183次，同时requested peak增加40,842,624B，不能记成192ms确定收益。实际来源与质量/内存门见`cold-budget-gpu-scheduling-2026-10-01.md`。增大批量可能推迟GPU开始执行、提高暂存资源峰值；保留原始输出SHA门。

## Detector固定shape复查：不增加freeDimensionOverrides候选

只读使用安装包生成FlatBuffer schema直接读取同一个`detector.ort`（上表bytes/SHA不变），未转换模型或进行推理：

| 真实输入/输出name | elemType | shape |
|---|---|---|
| images | FLOAT（1） | [1,3,1024,1024] |
| seg | FLOAT（1） | [1,1,1024,1024] |
| blk | FLOAT（1） | [1,64512,7] |
| det | FLOAT（1） | [1,2,1024,1024] |

以上每个维度的`DimensionValue.dimType()`都为`VALUE`，`dimParam()`/denotation均null；**全图nodeArgs含动态维度的数量0，符号维度名集合为空**。读取流程为`InferenceSession.getRootAsInferenceSession(ByteBuffer(bytes)).model().graph()`，根据`graph.inputs()/outputs()`在`nodeArgs()`匹配name，再读取`type().value(new TensorTypeAndShape()).shape().dim(i).value()`。schema来自`node_modules/onnxruntime-web/lib/onnxjs/ort-schema/flatbuffers/onnxruntime/fbs/`，这不是根据代码预处理推测的shape；只读解析耗时0.37s，无CPU/GPU Session和模型run。

实际调用也匹配该固定shape：`packages/image-pipeline/src/pipeline/detect/onnxDetect.ts`设inputSize=1024；GPU runImage、GPU失败后的CPU预处理、非WebGPU路径都使用batch1/3通道/1024×1024，Worker的`runDetectWithGpuPreprocess`同样传1024给原GPU预处理。TTB预检测/benchmark走同detector路径；Node的GPU预处理入口不支持，而CPU检测仍使用上面的固定预处理。

官方1.27 [FreeDimensionOverrideTransformer](https://github.com/microsoft/onnxruntime/blob/v1.27.0/onnxruntime/core/optimizer/free_dim_override_transformer.cc)按实际`dim_param`名称或denotation匹配，只有被匹配且没有固定value的维度才设置新shape/触发graph resolve。这里没有这些名称，不能用images、height、width或位置编号替代符号名。

因此没有height/width/batch符号可再固定，`freeDimensionOverrides`是现有options字段且cache key已经排序记录它，但为这份模型添加假定符号名称不会创造新的shape优化。当前basic策略也不改变模型原有固定shape；不加默认关闭空效果flag，不新增质量/性能跑组，不预设初始化/内存/首run收益。
