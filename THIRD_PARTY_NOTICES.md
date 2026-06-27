# 第三方组件与模型声明

本文档用于说明本项目中使用的第三方模型来源、许可证与处理方式。

## 1) comic-text-detector（文本检测模型来源）

- 上游模型页：`https://huggingface.co/mayocream/comic-text-detector-onnx`
- 上游项目：`https://github.com/dmMaze/comic-text-detector`
- 许可证：以模型页及上游仓库声明为准
- 本项目用途：漫画文字区域和文字 mask 检测
- 本项目处理：使用发布模型资产中的 `detector.onnx`，在 `public/models/models.json` 中注册为 `detector`

## 2) PaddlePaddle/PP-OCRv6_medium_rec_onnx（PaddleOCR 识别模型来源）

- 上游模型页：`https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_rec_onnx`
- 许可证：以模型页及 PaddleOCR 上游声明为准
- 基座模型：PaddlePaddle PP-OCRv6 medium recognition（ONNX 格式导出）
- 本项目用途：中日英文字识别（OCR）
- 本项目处理：使用发布模型资产中的 `PP-OCRv6_medium_rec.onnx`，配套 `paddleocr_v6_dict.txt`，在 `public/models/models.json` 中注册为 `paddleocr_v6_medium_rec`

## 3) mayocream/aot-inpainting（去字模型来源）

- 上游模型页：`https://huggingface.co/mayocream/aot-inpainting`
- 相关来源：`https://github.com/zyddnys/manga-image-translator` 的 AOT inpainting checkpoint
- 许可证：以模型页及相关上游声明为准
- 本项目用途：图像去字（inpainting）
- 本项目处理：使用发布模型资产中的 `aot_inpaint_512.onnx`，在 `public/models/models.json` 中注册为 `inpaint`

## 4) huyvux3005/manga109-segmentation-bubble（气泡检测模型来源）

- 上游模型页：`https://huggingface.co/huyvux3005/manga109-segmentation-bubble`
- 模型说明：MangaLens YOLO11n speech bubble segmentation
- 许可证：以模型页声明为准
- 本项目用途：漫画对话气泡实例分割
- 本项目处理：使用发布模型资产中的 `bubble.onnx`，在 `public/models/models.json` 中注册为 `bubble`

## 5) manga-image-translator（项目灵感与模型处理思路）

- 上游项目：`https://github.com/zyddnys/manga-image-translator`
- 许可证：`GPL-3.0`（以上游仓库 `LICENSE` 为准）
- 本项目用途：项目灵感、部分模型处理思路参考，以及 AOT inpainting checkpoint 的相关来源

## 6) 分发说明

- 本仓库根目录 `LICENSE` 采用 `GPL-3.0`。
- 分发本项目（源码或构建产物）时，请保留本文件、上游版权与许可证声明。
- 如你修改了第三方模型或转换脚本，请在提交记录或发布说明中标注变更内容与日期。

## 7) 应用图标（Donut icon）

- 来源：`https://www.flaticon.com/free-icon/donut_6402298`
- 作者：smashingstocks
- 许可证：Flaticon Free License（`https://www.flaticon.com/legal`）
- 本项目用途：浏览器扩展应用图标
- 署名要求：须注明 "Designed by smashingstocks from Flaticon"

## 8) 应用字标（Sour Gummy outline）

- 字体来源：`https://github.com/eifetx/Sour-Gummy-Fonts`
- Google Fonts 分发：`https://github.com/google/fonts/tree/main/ofl/sourgummy`
- 设计者：Stefie Justprince
- 许可证：SIL Open Font License 1.1（OFL）
- 本项目用途：将 `ShinobuTranslator` 文字转换为 SVG outline，用于 README 头图与扩展弹窗标题；不分发完整字体文件。
- 版权声明：Copyright 2018 The Sour Gummy Project Authors (`https://github.com/eifetx/Sour-Gummy-Fonts`)

## 9) 免责声明

- 本文件仅用于工程合规记录，不构成法律意见。
