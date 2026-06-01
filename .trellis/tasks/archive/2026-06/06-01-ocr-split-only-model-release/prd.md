# OCR split-only 模型发布

## Goal

让内置 OCR 的浏览器推理路径真正切换为 split-only：运行时不再依赖 `public/models/ocr.onnx`，`models-v0.4.0` 预发布也不再上传或校验 `ocr.onnx`。这样新版模型包只包含当前优化后的 `ocr_encoder.onnx` / `ocr_decoder.onnx` 和必要字典，减少下载体积并避免换电脑开发时拉取过时的大模型。

## User Value

- 换电脑开发时，`npm run models:download -- 0.4.0` 拉取的是新版 OCR 所需的最小模型集合。
- 发布扩展时，`MODEL_RELEASE_TAG=models-v0.4.0 npm run build` 生成的 manifest 指向可用的 GitHub Release 资产，不包含废弃 `ocr.onnx`。
- 当前 AR 优化路径成为主路径，避免继续为 full AR 模型维护发布包。

## Confirmed Facts

- `public/models/models.json` 仍注册了 `"ocr"`，其 URL 是 `/models/ocr.onnx`。
- `runOcrByOnnxInternal` 当前先加载 `getModel("ocr")` 和 `getModelSession("ocr", ["webgpu", "webnn", "wasm"])`，所以缺少 `ocr.onnx` 会在进入 split 优化前失败。
- split 模型目前只是 full AR 路径里的优化分支：`getModelSession("ocr_encoder")` / `getModelSession("ocr_decoder")` 成功时走 `runOcrSplitBatchDecode`，失败时回退 `runOcrBatchDecode`。
- split decode 已经会从 decoder 输出中读取颜色：`decodeBatchAutoregressiveWithEncoderCache` 调用 `extractBatchColorsFromOutputs`，并把 `colors` 带回 OCR result。
- 颜色解码 fallback 仍调用 `runOcrColorBatch` / `runOcrColorSingle`，并传入 full OCR session/inputNames。
- 如果 OCR result 缺少颜色，`fillMissingOcrFields` 还有基于图像裁剪的 histogram / edge / corner 采样兜底。
- 浏览器 OCR smoke benchmark 已经有直接创建 `ocr_encoder` / `ocr_decoder` session 并调用 `runOcrSplitBatchDecode` 的覆盖。
- 现有模型上传/下载脚本已经在工作区改为从 `models.json` 自动推导资产；因此移除 manifest 里的 `"ocr"` 后，`ocr.onnx` 会自然退出上传/下载清单。
- GitHub 上 `models-v0.4.0` pre-release 已被创建，但上传被中断，目前只确认有 3 个资产：`ch_PP-OCRv5_rec_mobile.onnx`、`ocr_dict.txt`、`ocr_encoder.onnx`。后续发布前需要补齐并确保没有 `ocr.onnx`。

## Requirements

- 内置 OCR 正常路径只加载 `ocr_encoder`、`ocr_decoder` 和 `ocr_dict.txt`，不再加载 `ocr.onnx`。
- provider fallback 仍保留：WebGPU 失败时应能按现有策略回退 WebNN/WASM，但 fallback 也必须使用 split 模型，而不是 full OCR。
- batch decode、single-region fallback、颜色解码都要有 split-compatible 路径；不能因为移除 full session 失去必要的 OCR 输出字段。
- 移除 `ocr.onnx` 后，颜色读取的主路径应复用 split decoder 返回的 `colors`；若某些 region 缺失模型颜色，必须落到图像采样兜底或新增 split-compatible color fallback。
- `public/models/models.json` 移除 `"ocr"` 或把它迁移成不参与发布/运行的显式 legacy 配置，默认发布清单不得包含 `/models/ocr.onnx`。
- `models:upload` / `models:download` dry-run 中不得出现 `ocr.onnx`。
- `models-v0.4.0` pre-release 最终资产不得包含 `ocr.onnx`，并且 `models.sha256` 只覆盖新版资产。
- 保持 PaddleOCR provider 和非 OCR 模型发布不受影响。

## Acceptance Criteria

- [x] `rg "getModelSession\\(\"ocr\"" src benchmark` 不再命中正常运行路径。
- [x] `public/models/models.json` 的默认模型列表不再引用 `/models/ocr.onnx`。
- [x] `npm run models:upload -- 0.4.0 --dry-run` 输出不包含 `ocr.onnx`，包含 `ocr_encoder.onnx`、`ocr_decoder.onnx`、`ocr_dict.txt`。
- [x] `npm run models:download -- 0.4.0 --dry-run` 输出不包含 `ocr.onnx`。
- [x] `npm run build` 通过。
- [x] 至少一个浏览器/WebGPU OCR smoke 或等价真实浏览器验证通过 split-only 路径。
- [x] split-only 验证中 OCR 输出仍带有 `fgColor` / `bgColor`，或明确经过图像采样兜底填充。
- [x] GitHub `models-v0.4.0` pre-release 是 pre-release，资产完整且不包含 `ocr.onnx`。

## Out of Scope

- 重新训练或重新导出 OCR 模型结构。
- 优化 OCR 识别质量。
- 移除 PaddleOCR provider。
- 大规模重写 modelRegistry 或 ONNX worker 生命周期。

## Decision

- User approved the recommended scope: remove full `ocr.onnx` fallback from the normal runtime path and from the `models-v0.4.0` release. Color handling should prefer split decoder colors, then image-sampling fallback, with a split-compatible color fallback only if real validation proves it is needed.

## Resolved Questions

- 彻底移除正常运行和发布清单中的 full OCR fallback；`ocr.onnx` 仅可作为本地重新 split 的源文件存在，不参与换机下载或默认发布。
