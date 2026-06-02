# OCR split-only 模型发布设计

## Architecture

当前结构是 full OCR session 作为入口，split encoder/decoder 作为可选加速。目标结构改为 split session 作为入口：

- metadata 从 `ocr_decoder` 读取字典、输入尺寸和 normalize 配置。
- provider 选择先创建 `ocr_encoder` session，再用相同 provider 创建 `ocr_decoder` session。
- split decode 调用 `runOcrSplitBatchDecode(encoderSessionId, decoderSessionId, inputNames, ...)`。
- fallback provider 重新创建 encoder/decoder pair，不再回退到 `ocr` full session。

## Data Flow

1. `runOcrByOnnxInternal` 加载 `getModel("ocr_decoder")` 作为 OCR metadata 来源。
2. 创建 `ocr_encoder` session，记录实际 provider。
3. 创建 `ocr_decoder` session，优先使用 encoder 的 provider。
4. `runOcrByOnnxWithSplitSessions` 预处理候选区域，并调用 split batch decode。
5. single-region fallback 应优先新增 split single decode，或让 split batch decode 接受单元素 batch 作为 fallback。
6. 颜色解码优先复用 split decode 返回的颜色；如果仍需 fallback，需要新增 split-compatible color decode，或者使用 `fillMissingOcrFields` 的图像采样兜底，不能调用 full OCR session。

## Compatibility

- `paddleocr_rec` 不变。
- `ocr_dict.txt` 继续由 `ocr_decoder.dictUrl` 引用。
- `scripts/split-ocr-encoder-decoder.mjs` 可以继续以本地 `ocr.onnx` 作为生成输入，但生成脚本输入不等于运行/发布依赖。
- 本地开发者如需重新 split，可自行准备 `ocr.onnx`，但换机开发下载脚本不应拉取它。

## Release Handling

- `public/models/models.json` 移除默认 `"ocr"` 项后，自动推导上传/下载清单会排除 `ocr.onnx`。
- `models-v0.4.0` 已部分创建，发布前需要清理/补齐，确保远端资产和 checksum 一致。

## Risks

- full session 当前承担颜色 fallback 和 single fallback；split decoder 已经能返回颜色，但需要验证覆盖率。如果颜色缺失，应走图像采样兜底或补 split color API，而不是恢复 `ocr.onnx`。
- split encoder/decoder 在 WebNN/WASM 上的兼容性需要验证，不能只看 WebGPU。
- 移除 manifest `"ocr"` 后，任何旧 benchmark 或 debug 脚本如果仍显式读取 `ocr` 会失败，需要同步改测试入口。
