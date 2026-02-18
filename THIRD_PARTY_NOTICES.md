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

## 3) 分发说明

- 本仓库根目录 `LICENSE` 采用 `GPL-3.0`，以满足与 GPL 来源模型的分发一致性要求。
- 分发本项目（源码或构建产物）时，请保留本文件、上游版权与许可证声明。
- 如你修改了第三方模型或转换脚本，请在提交记录或发布说明中标注变更内容与日期。

## 4) 免责声明

- 本文件仅用于工程合规记录，不构成法律意见。
