# 评估 PaddleOCR v6 替换方案

## 目标

评估当前可选的 PaddleOCR v5 识别路径是否可以升级到 PP-OCRv6，并在改动运行时代码之前确定最安全的实现范围。

## 用户价值

- 提升可选 Paddle OCR 识别路径对漫画/条漫文本的识别质量，尤其是日文、中文、英文、竖排文本和风格化文字。
- 保留现有本地浏览器内运行的流水线：不引入托管 OCR API，不上传用户图片，也不新增密钥处理。
- 在 v6 兼容性和性能尚未实测之前，避免影响当前默认内置 OCR 路径。

## 已确认决策

- 本任务先尝试跑通 `PP-OCRv6_small_rec`。
- 只有在 small 模型完成转换、加载、解码，并通过至少一次浏览器冒烟测试后，才继续尝试 `PP-OCRv6_medium_rec`。
- small 和 medium 都接入后，需要在同一测试样本和同一运行条件下比较 Paddle OCR v5、v6 small、v6 medium 的推理速度。
- 本任务只处理识别模型接入，不替换现有文本检测模型。
- PaddleOCR v6 在本任务中仍然是可选实验路径，不会直接成为默认 OCR 引擎。

## 已确认事实

- PaddleOCR 官方于 2026-06-11 随 PaddleOCR 3.7.0 发布 PP-OCRv6。
- PP-OCRv6 有 `tiny`、`small`、`medium` 三个层级。官方文档说明 small 和 medium 支持包括日文在内的 50 种语言；tiny 支持 49 种语言，不包含日文。
- 官方公布的 PP-OCRv6 相对 PP-OCRv5_server 的提升来自内部多场景基准测试，不能直接等同于本项目当前 v5 mobile 模型的实际收益。
- 官方浏览器部署文档目前仍以 `@paddleocr/paddleocr-js` 的 `ocrVersion: "PP-OCRv5"` 和内置 PP-OCRv5 模型为示例，没有直接提供 PP-OCRv6 浏览器内置模型名。
- 官方 PP-OCRv6 推理下载包是 Paddle 静态图 tar 包，包含 `inference.pdiparams`、`inference.json`、`inference.yml`，不是可直接加载的 ONNX 文件。官方文档说明可用 PaddleX Paddle2ONNX 转换。
- 本项目不依赖 `@paddleocr/paddleocr-js`，而是通过 `onnxruntime-web` 直接运行 ONNX 模型。
- 当前 `public/models/models.json` 只注册了 `paddleocr_rec`，指向 `/models/ch_PP-OCRv5_rec_mobile.onnx`，使用 `/models/paddleocr_v5_dict.txt`，输入尺寸 `[48, 320]`，归一化方式为 `minus_one_to_one`。
- 当前 PP-OCRv5 识别模型是 mobile 大小的模型，文件 `ch_PP-OCRv5_rec_mobile.onnx` 本地大小为 `16,517,247` 字节，约 15.8 MiB / 16.5 MB。
- 当前 Paddle 识别提供者只做识别。文本检测仍使用项目自己的 `detector.onnx` 路径，检测出的区域会传给 `paddleocrProvider`。
- 当前 v5 ONNX 合约为输入 `x: [N, 3, 48, W]`，输出 `fetch_name_0: [N, T, 18385]`；`18385 = 18383 个字典条目 + blank + space`。
- 已下载检查的官方 PP-OCRv6 tiny 识别模型元数据为 `CTCLabelDecode`，输入图像形状 `[3, 48, 320]`，字典条目 `6904`，输出类别 `6906`。由于官方语言支持不包含日文，tiny 不适合作为本项目日漫/漫画 OCR 候选。
- 已下载检查的官方 PP-OCRv6 small 识别模型元数据为 `CTCLabelDecode`，输入图像形状 `[3, 48, 320]`，字典条目 `18708`，输出类别 `18710`。
- 已下载检查的官方 PP-OCRv6 medium 识别模型元数据同样为 `CTCLabelDecode`，输入图像形状 `[3, 48, 320]`，字典条目 `18708`，输出类别 `18710`。
- 当前官方 PP-OCRv6 识别/检测文档只列出 `tiny`、`small`、`medium` 三个 v6 层级，没有官方 `PP-OCRv6_mobile`、`PP-OCRv6_server` 命名，也没有语言专用 v6 识别变体。
- 与当前 v5 字典的 `18383` 个唯一条目相比，PP-OCRv6 small/medium 字典与 v5 共有 `18348` 个条目，新增 `360` 个条目，移除 `35` 个条目。输出类别从 `18385` 增加到 `18710`。
- PP-OCRv6 字典顺序与当前 v5 不同：当前 v5 以全角空格和 CJK 条目开头，如 `　`、`一`、`乙`；v6 以 ASCII 标点开头，如 `!`、`"`、`#`。即使字符相同，也不能复用 v5 token id。
- 既有 Trellis 历史记录显示，早前 OCR 优化有意没有把 PaddleOCR CTC 设为默认路径；除非后续基准测试证明值得切换，否则 PaddleOCR 应保持可选。

## 需求

- 将 PP-OCRv6 作为可选 Paddle 识别提供者升级/实验路径，而不是默认 OCR 替换。
- 首轮只接入 PP-OCRv6 识别模型，不在本任务中替换项目现有检测器。
- 优先实现 `PP-OCRv6_small_rec`，因为它支持日文，并且明显小于 medium。
- 只有 small 模型转换、加载、解码和浏览器冒烟测试均成功后，才尝试 `PP-OCRv6_medium_rec`。
- 不能复用 `paddleocr_v5_dict.txt`；必须从匹配的 v6 `inference.yml` 生成并注册 v6 专用字典。
- 在运行时接入前，需要先把官方 Paddle 静态推理模型转换为浏览器可加载的 ONNX。
- 在 UI 暴露前，需要验证 ONNX Runtime Web 在项目常规执行后端回退链路，即 `webgpu`、`webnn`、`wasm` 下的兼容性。
- 在 v6 有真实浏览器冒烟测试结果前，必须保留当前内置 OCR 和现有 PaddleOCR v5 路径作为可恢复路径。
- 当前 PP-OCRv5 识别路径需要保留，既作为回滚路径，也作为速度基线。
- 需要在同一测试样本上对已接入的 Paddle 识别变体做基准测试；条件允许时，冷启动加载耗时和热推理耗时分开记录。
- 基准测试结果需要包含足够解释上下文：选择的模型、实际执行后端、区域数量、有效 OCR 数量、总识别耗时、单区域耗时摘要和示例识别文本。
- 如果 UI 文案或错误提示发生变化，用户可见文案保持中文。
- 规划阶段不提交大型模型二进制文件。

## 验收标准

- [ ] PRD 记录 PP-OCRv6 是否存在、首个实现候选为何是 `small`、`medium` 为什么依赖 small 成功。
- [ ] design.md 说明模型转换、字典生成、manifest 变更、识别提供者兼容性和基准测试风险。
- [ ] implement.md 包含类型检查/build、Paddle CTC decode 测试、模型元数据检查和浏览器 OCR 冒烟测试的验证命令。
- [ ] 在用户批准选定范围之前，不改运行时代码或模型 manifest。
- [ ] 如果进入实现，`paddleocrProvider` 可以从专用模型 id 加载 `PP-OCRv6_small_rec`，且不破坏现有默认 OCR 路径。
- [ ] 如果 small 成功，`paddleocrProvider` 可以从专用模型 id 加载 `PP-OCRv6_medium_rec`，且不破坏 v5 或 small。
- [ ] 如果进入实现，基准测试/冒烟测试输出需要在同一日文漫画/条漫样本或当前 OCR fixture 上比较 Paddle v5 识别与 v6 small 识别。
- [ ] 如果 medium 成功，基准测试/冒烟测试输出还需要在同一运行条件下比较 v6 medium、v6 small 和 v5。
- [ ] 如果 small 或 medium 在转换、运行时、浏览器推理任一环节失败，需要记录准确失败步骤和最后一个通过的验证点。

## 非目标

- 本任务不把 PaddleOCR 设为默认 OCR 引擎。
- 第一阶段不把项目文本检测器替换为 PP-OCRv6 detection。
- 不引入托管 PaddleOCR API 调用。
- 不训练或微调 OCR 模型。

## 未决问题

- 无阻塞未决问题。进入实现前，需要用户审阅并批准 `prd.md`、`design.md`、`implement.md`。

## 备注

- `prd.md` 聚焦需求、约束和验收标准。
- 本任务属于复杂任务，进入实现前需要同时维护 `prd.md`、`design.md`、`implement.md`。
