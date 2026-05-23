# 第三方组件与模型声明

本文档用于说明本项目中使用的第三方模型来源、许可证与处理方式。

## 1) manga-image-translator（OCR/检测模型来源）

- 上游项目：`https://github.com/zyddnys/manga-image-translator`
- 许可证：`GPL-3.0`（以上游仓库 `LICENSE` 为准）
- 本项目用途：作为检测/OCR 相关模型来源
- 本项目处理：OCR 模型通过 `scripts/export_ocr_ar_to_onnx.py` 导出为 ONNX 供浏览器端推理

## 2) Carve/LaMa-ONNX（去字模型来源）

- 上游模型页：`https://huggingface.co/Carve/LaMa-ONNX`
- 许可证：`Apache-2.0`（以模型页声明及其文件为准）
- 本项目用途：图像去字（inpainting）
- 本项目处理：LaMa 模型通过 `scripts/patch_lama_webgpu.py` 做 WebGPU 侧兼容修补

## 3) kitsumed/yolov8m_seg-speech-bubble（气泡检测模型来源）

- 上游模型页：`https://huggingface.co/kitsumed/yolov8m_seg-speech-bubble`
- 许可证：`GPL-3.0`（以模型页声明为准）
- 基座框架：Ultralytics YOLOv8m-seg（`AGPL-3.0`）
- 本项目用途：漫画对话气泡检测
- 本项目处理：直接使用 HuggingFace 上的 `model_dynamic.onnx`，重命名为 `bubble.onnx`，无需额外导出或修补

## 4) webnn/PP-OCRv5-ONNX（PaddleOCR 识别模型来源）

- 上游模型页：`https://huggingface.co/webnn/PP-OCRv5-ONNX`
- 许可证：`Apache-2.0`（以模型页声明为准）
- 基座模型：PaddlePaddle PP-OCRv5_mobile_rec（ONNX 格式导出）
- 本项目用途：中日英文字识别（OCR）
- 本项目处理：直接使用 `ch_PP-OCRv5_rec.onnx`，重命名为 `ch_PP-OCRv5_rec_mobile.onnx`，无需额外导出或修补

## 5) 分发说明

- 本仓库根目录 `LICENSE` 采用 `GPL-3.0`，以满足与 GPL 来源模型的分发一致性要求。
- 分发本项目（源码或构建产物）时，请保留本文件、上游版权与许可证声明。
- 如你修改了第三方模型或转换脚本，请在提交记录或发布说明中标注变更内容与日期。

## 6) 应用图标（Donut icon）

- 来源：`https://www.flaticon.com/free-icon/donut_6402298`
- 作者：smashingstocks
- 许可证：Flaticon Free License（`https://www.flaticon.com/legal`）
- 本项目用途：浏览器扩展应用图标
- 署名要求：须注明 "Designed by smashingstocks from Flaticon"

## 7) 免责声明

- 本文件仅用于工程合规记录，不构成法律意见。
