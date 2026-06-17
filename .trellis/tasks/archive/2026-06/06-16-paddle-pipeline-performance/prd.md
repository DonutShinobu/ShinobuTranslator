# Paddle pipeline 性能分析与加速规划

## Goal

分析当前 Paddle pipeline 全流程的速度瓶颈，并形成可执行的加速方案。最终优化目标是在不影响文本检测效果、不通过预加载模型长期占用内存的前提下，加速 Paddle pipeline，尤其确认 OCR 阶段是否因为输入尺寸未固定或预处理策略不当而变慢。

## Requirements

- 梳理 Paddle pipeline 的端到端执行链路：检测、OCR、合并/翻译前处理、inpaint/typeset 相关衔接，以及模型加载/推理/后处理边界。
- 基于代码、现有 benchmark、历史任务记录和可运行测量，定位主要耗时来源，区分冷启动耗时、模型加载耗时、图像预处理耗时、ONNX 推理耗时、后处理耗时。
- 重点验证 OCR 输入尺寸策略是否导致性能问题，包括动态输入 shape、按文本框裁剪后的尺寸分布、resize/padding/batching 策略、ONNX Runtime session/EP 对动态 shape 的影响。
- 提出不降低检测召回/精度的优化路径；检测模型输入尺寸或阈值相关优化必须有回归验证要求。
- 避免以“页面加载时预加载模型/长驻大模型”作为主要方案；允许研究用户触发后的懒加载、按需缓存、session 生命周期复用和轻量预热策略。
- 输出按收益、风险、实现成本排序的优化清单，并明确哪些需要先加 profiling，哪些可以直接实现。

## Confirmed Facts

- 当前产品形态只保留两个 OCR 选项：默认 `48px` 和 `Paddle`，其中 `Paddle` 运行时值为 `paddleocr_v6_medium`；旧设置值 `paddleocr`、`paddleocr_v6_small` 仅作为兼容别名归一化到 medium。
- Paddle v6 medium 模型注册为 `paddleocr_v6_medium_rec`，输入配置 `[48, 320]`，字典为 `paddleocr_v6_dict.txt`，归一化为 `minus_one_to_one`，通道顺序为 `bgr`。
- `PP-OCRv6_medium_rec.onnx` 的实际 ONNX 元数据是动态 batch 和动态 width：输入 `["DynamicDimension.0", 3, 48, "DynamicDimension.1"]`，smoke 形状 `[1, 3, 48, 320]`，输出类别数 `18710`。
- 检测阶段当前使用项目自己的 `detector.onnx`，固定输入 `1024x1024`；WebGPU 下有 GPU preprocess + IO binding 路径，CPU/WebNN/WASM fallback 使用 CPU letterbox。
- 改动前 Paddle OCR provider 对每个 detected region 串行执行：裁切/透视/竖排旋转、resize 到高度 48、按比例动态 width、构造 `[1,3,48,width]`、调用一次 `runInference`、CTC decode。
- 当前实现已补齐 Paddle 子阶段 debug；`runOcr` 会保留 Paddle provider 返回的真实 `OcrRunDebugInfo`，包括 session/model/charset、preprocess、inference、CTC decode、width 分布、input/output bytes、颜色补齐耗时。
- 当前 Paddle OCR provider 已支持 32px width-bucket batch 和串行 fallback；默认策略为 provider-aware：WebGPU/CUDA、非 CPU WebNN 默认 width-bucket，CPU/WASM 默认 serial，benchmark 可用 `--paddle-batch`/`--paddle-serial` 强制对照。
- orchestrator 会在 detect 开始时提前启动 OCR runtime probe，但该 probe 固定加载旧 `ocr_encoder`/`ocr_decoder`，不是 Paddle medium；Paddle medium session 在 Paddle provider 内部按需创建。
- 现有浏览器 X benchmark `run-browser-x-compare.ts` 仍硬编码 `ocrEngine: "builtin"`，不能直接回答 Paddle pipeline 的浏览器瓶颈。
- 现有 Node `bench:ocr-debug` 可跑 `48px` 与 `paddleocr_v6_medium`，现在已能输出 Paddle 子阶段摘要。
- 用户已实测固定宽度不会造成明显 OCR 质量倒退；后续固定宽度或 bucket padding 的质量风险可以降级，但仍需用 benchmark 记录文本差异。

## Measurements

- 2026-06-16 在当前机器运行 `npm run bench:ocr-debug -- --ocr-engine=all --runs=2`，样本为 `benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png`，检测到 14 个 region。Node CUDA 不可用，回退 CPU。
- 同次 Node 结果：detect `34869.83ms`；`48px` OCR 冷 `3754.94ms`、热 `2698.45ms`；`paddleocr_v6_medium` OCR 冷 `998.82ms`、热 `415.67ms`。
- 该 Node detect 时间走 CPU 路径，不代表浏览器 WebGPU detect；它只说明 Node 全流程不能直接当浏览器 Paddle pipeline 结论。
- 同一样本手动探针显示，Paddle 当前动态 width 分布为 `[216,129,178,142,118,268,272,214,186,186,78,111,267,174]`，平均 `181.36`，最大 `272`，小于 manifest 上限 `320`。
- 串行动态 width 探针：preprocess `39.81ms`，inference `448.78ms`，decode `11.13ms`，输入字节 `1,462,464`，总计约 `499.72ms`。
- 串行固定 320 padding 探针：inference `745.55ms`，输入字节 `2,580,480`，总计约 `795.33ms`，并改变了少量 OCR 文本/标点。
- 单 batch 到最大观测宽度 272 探针：inference `509.64ms`，输入字节 `2,193,408`，总计约 `556.66ms`，少量文本变化。
- 单 batch 到 320 探针：inference `441.15ms`，输入字节 `2,580,480`，总计约 `492.36ms`，少量文本变化。
- 按 32px width bucket batch 探针：6 次 batch run，inference `331.36ms`，输入字节 `1,585,152`，总计约 `377.75ms`，相对当前串行动态约快 `24%`；该结果来自 Node/CPU，仍需浏览器 WebGPU 复测。
- 补齐 debug 后的 Node profile 显示，Paddle 颜色补齐通常只有数毫秒到十几毫秒，热跑主要仍在 OCR inference；`modelLoadMs/sessionLoadMs/charsetLoadMs` 只影响 cold run 或 cache miss。
- `npm run bench:ocr-debug -- --ocr-engine=paddleocr_v6_medium --runs=2 --paddle-batch`：Paddle width-bucket 将 14 个 region 压成 6 次 `runInference`，一次热跑观测到 OCR `382.99ms`、inference `306.78ms`、accepted `14/14`。
- `npm run bench:ocr-debug -- --ocr-engine=paddleocr_v6_medium --runs=2 --paddle-serial`：CPU 串行对照为 14 次 `runInference`，一次热跑观测到 OCR `431.70ms`、inference `353.58ms`、accepted `14/14`。
- Node CPU 结果存在波动，另一次 batch 热跑约 `460.81ms`；因此当前默认策略不在 CPU/WASM 上强制 batch，把默认 batch 限定在更可能受益的 GPU 类 provider，浏览器 WebGPU 仍是最终判断来源。
- 2026-06-17 补充浏览器 WebGPU profile：`npm run bench:browser-paddle-profile -- --image=benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png --runs=3`，Paddle provider 为 `webgpu`，默认 width-bucket。冷启动 total `26.57s`、OCR `15.30s`，其中 Paddle session `1.18s`、首次 inference `13.89s`；热跑 median total `2.54s`、OCR `245ms`、Paddle inference `124ms`、preprocess `81ms`、CTC `12ms`、颜色补齐 `23ms`。
- 同一浏览器 profile 强制 serial：热跑 median total `1.68s`、OCR `242ms`、Paddle inference `144ms`、preprocess `69ms`，17 次 inference。默认 width-bucket 为 8 次 inference，对热 OCR 只有约 `20ms` inference 收益；总耗时差异主要来自 inpaint/detect 抖动，不应解读为 serial 全流程更快。
- `processMode=original`（仍跑本地去字，再排版原文）热跑 median total `1.62s`、OCR `170ms`、Paddle inference `84ms`、typeset `21ms`。热跑 stage median：`parallel`/去字 `815ms`（其中 inpaint `590ms`、mask refine `225ms`）、detect `287ms`、bubble `167ms`、OCR `170ms`、order `136ms`。

## Initial Conclusions

- “没有固定输入大小”不是单独的根因。强制每个 region 固定 320 串行运行会增加输入字节和时间步，在 Node/CPU 上更慢；用户实测质量没有明显倒退，因此固定宽度可作为后续优化候选，但性能收益仍需实测。
- 当前更可能的瓶颈是 Paddle provider 的多次 `runInference` 和 provider/shape 相关开销；优化方向已落地为“保留动态/分桶宽度，同时把同宽或近似宽度 region batch 化”。
- Paddle 路径缺少 profiling 的首要工程缺口已补齐；下一步需要在浏览器 WebGPU 下用新 debug 字段判断 session 创建、shape 编译、数据传输、推理和 decode 的占比。
- 浏览器数据表明要区分 cold 与 warm：cold run 主要卡在 Paddle OCR 首次 WebGPU inference/shape 编译，其次是 detector/bubble/inpaint session 准备；warm run 的全流程瓶颈已经转移到 erase 并行阶段（inpaint + mask refine），Paddle OCR 约占热 total 的 `10-15%`，其中 OCR 内部主要是 ONNX inference 和 preprocess。
- 检测效果约束应通过不改 detector 输入、阈值和后处理来满足；本轮加速优先放在 OCR provider 和 benchmark，不碰检测模型策略。
- 不预加载占内存约束应通过用户触发后按需建 session、复用当前 session cache、避免页面加载时 warmup 来满足。可研究“点击后阶段内并行加载 Paddle session”，但不做页面空闲预加载。

## Acceptance Criteria

- [ ] PRD 记录已确认事实、约束、验收标准和仍需用户决策的问题。
- [ ] 技术设计说明端到端性能测量点、瓶颈判断方法、OCR 输入尺寸策略分析、优化候选方案和风险取舍。
- [ ] 实施计划包含分阶段 checklist、验证命令、回归指标和回滚点。
- [ ] 最终方案能回答“当前 Paddle pipeline 主要卡在哪里”和“固定 OCR 输入大小是否是关键优化方向”。
- [ ] 所有建议遵守“不影响检测效果”和“不预加载占内存”的约束，若有例外必须明确标为需要用户批准的可选方案。

## Out of Scope

- 不替换 detector 模型，不调整检测输入尺寸、阈值、NMS、mask 后处理或 region filtering。
- 不把 Paddle 或其它模型改成页面加载时预加载。
- 不重新引入 v5/small 作为用户可见 OCR 选项。
- 不引入远程 OCR API、上传图片、训练或微调模型。

## Decisions

- 先完善 Paddle 子阶段 debug，再开始观测和优化。
- 固定宽度不会造成明显 OCR 质量倒退这一点按用户实测接受；实现仍需报告文本差异和性能数据，避免静默改变识别行为。

## Open Questions

- 无阻塞未决问题。用户已批准先实现 Paddle 子阶段 debug。

## Notes

- Keep `prd.md` focused on requirements, constraints, and acceptance criteria.
- Lightweight tasks can remain PRD-only.
- For complex tasks, add `design.md` for technical design and `implement.md` for execution planning before `task.py start`.
