# 本地运行时模型契约

本文档记录当前主分支发布包内应包含的本地模型、来源、用途、校验规则，以及已经移除的旧模型选项。

## 场景：主分支本地模型发布契约

### 1. Scope / Trigger

- 触发：修改 `public/models/models.json`、`src/runtime/modelRegistry.ts`、OCR 设置 UI、OCR provider、inpaint/bubble 模型，或发布包模型文件集。
- 目标：主分支只发布一条本地翻译模型链路，避免前端选项、manifest、实际文件和 benchmark 入口互相漂移。

### 2. Signatures

- `ModelName = "detector" | "inpaint" | "bubble" | "paddleocr_v6_medium_rec"`
- `OcrEngine = "paddleocr_v6_medium"`
- `ExtensionSettings.ocrEngine` 保留为兼容字段，但归一化后只能是 `paddleocr_v6_medium`。
- `public/models/models.json` 只注册 `detector`、`inpaint`、`bubble`、`paddleocr_v6_medium_rec`。
- `PP-OCRv6_medium_rec.onnx` 必须搭配 `paddleocr_v6_dict.txt`。

### 3. Contracts

- 前端不再提供 OCR 引擎切换。
- 旧设置值 `48px`、`builtin`、`paddleocr`、`paddleocr_v6_small` 必须归一化为 `paddleocr_v6_medium`。
- 本地翻译全流程固定使用：
  1. `detector.onnx`
  2. `bubble.onnx` YOLO11n
  3. `PP-OCRv6_medium_rec.onnx`
  4. `aot_inpaint_512.onnx`
- 发布包 `dist/models/` 不应包含旧 48px OCR、PaddleOCR v5、PP-OCRv6 small、Lama inpaint 或旧 bubble 备份。
- `bubble.onnx` 是同名替换过的模型文件：当前文件必须来自 YOLO11n Bubble，不要因为文件名未变而沿用旧 YOLOv8m 来源判断。
- benchmark 候选模型不得自动进入前端设置、`models.json` 或默认发布包；需要产品化时先更新本文档。

### 4. Validation & Error Matrix

| Condition | Symptom | Fix |
| --- | --- | --- |
| `models.json` 注册了未发布文件 | 浏览器运行时报模型加载失败 | 删除 manifest 项，或先把模型列入本文档和发布文件集 |
| `public/models/` 有旧模型但 manifest 未引用 | 打包体积被误判，人工发布容易带入旧文件 | 删除旧文件并重新 `npm run build` |
| 前端重新暴露 OCR 引擎切换 | 用户可选择不存在或未维护的模型 | 移除 UI 选项，只保留内部兼容字段 |
| 旧设置值没有归一化 | 老用户设置升级后进入无效分支 | 在 `normalizeOcrEngine()` 中迁移到 `paddleocr_v6_medium` |
| benchmark 继续要求 small/48px/Lama 文件 | 新发布包无法跑性能测试 | 将 benchmark 入口收束到当前发布模型，历史对照只看旧报告 |
| 只按文件名判断 `bubble.onnx` 未变 | 发布说明、第三方来源或模型 release 可能继续引用旧 YOLOv8m bubble | 对照 SHA256/来源；当前应为 YOLO11n `3DA3317F...789F0A0` |

### 5. Good/Base/Bad Cases

- Good：新增模型前先在本文档写明来源、用途、manifest key、校验方式，再修改 manifest 和代码。
- Base：历史配置里仍出现 `48px` 或 `builtin`，启动时自动迁移为 `paddleocr_v6_medium`。
- Bad：只把模型文件丢进 `public/models/`，不更新 manifest、类型和 Trellis 契约。
- Bad：把 benchmark 临时候选模型暴露成用户可见 OCR 选项。

### 6. Tests Required

- `npx tsc --noEmit --pretty false`
- `npm run test`
- `npm run build`
- 构建后检查 `dist/models/` 只包含本文档“当前发布模型”和必需运行时文件。
- OCR 设置迁移测试必须覆盖 `48px`、`builtin`、`paddleocr`、`paddleocr_v6_small` 到 `paddleocr_v6_medium`。

### 7. Wrong vs Correct

#### Wrong

```json
{
  "ocr_encoder": { "url": "/models/ocr_encoder.onnx" },
  "paddleocr_v6_small_rec": { "url": "/models/PP-OCRv6_small_rec.onnx" }
}
```

#### Correct

```json
{
  "paddleocr_v6_medium_rec": {
    "url": "/models/PP-OCRv6_medium_rec.onnx",
    "dict": "/models/paddleocr_v6_dict.txt"
  }
}
```

## 当前发布模型

| 文件 | manifest key | SHA256 | 用途 | 来源 |
| --- | --- | --- | --- | --- |
| `detector.onnx` | `detector` | `1A86ACE74961413CBD650002E7BB4DCEC4980FFA21B2F19B86933372071D718F` | 漫画文字检测；输出文本区域和文字 mask，供 OCR、mask refinement 和 inpaint 使用 | [`mayocream/comic-text-detector-onnx`](https://huggingface.co/mayocream/comic-text-detector-onnx)，上游为 [`dmMaze/comic-text-detector`](https://github.com/dmMaze/comic-text-detector) |
| `PP-OCRv6_medium_rec.onnx` | `paddleocr_v6_medium_rec` | `9C09ABF0957F7968C7586464B7397B84AD2387A0497A351AF40E9ACC71B673BA` | 唯一 OCR recognition 模型；识别检测框内日文/中文文本，使用 CTC decode | [`PaddlePaddle/PP-OCRv6_medium_rec_onnx`](https://huggingface.co/PaddlePaddle/PP-OCRv6_medium_rec_onnx) |
| `aot_inpaint_512.onnx` | `inpaint` | `ACDDDCCFDC32780C8947946814E9EEA6A8B0D5B1880FB46F3BE8389510F11689` | 去字 inpaint；接收原图和 refined text mask，输出清理后的图像 | [`mayocream/aot-inpainting`](https://huggingface.co/mayocream/aot-inpainting)，来源 checkpoint 为 [`zyddnys/manga-image-translator`](https://github.com/zyddnys/manga-image-translator) 的 AOT inpainting |
| `bubble.onnx` | `bubble` | `3DA3317F6DFFE27CF5C9396DC95D5324FB647E22ADEB7BF304EDBE921789F0A0` | YOLO11n 气泡实例分割；给排版阶段提供 `bubbleBox` 和 `bubbleMask` | [`huyvux3005/manga109-segmentation-bubble`](https://huggingface.co/huyvux3005/manga109-segmentation-bubble)，MangaLens YOLO11n speech bubble segmentation |

### Bubble 同名替换记录

- 当前 `bubble.onnx` 保持 manifest key 和文件名不变，但二进制内容已经从旧 YOLOv8m speech bubble segmentation 切换为 YOLO11n Bubble。
- 旧 `models-v0.4.0` release 中的 `bubble.onnx`：size `108982949`，SHA256 `36C26BDEFE150226ACD9669772E9FF5A011FA0DD4622469B49D3D5E359F3251C`。
- 当前发布模型的 `bubble.onnx`：size `11626988`，SHA256 `3DA3317F6DFFE27CF5C9396DC95D5324FB647E22ADEB7BF304EDBE921789F0A0`。
- 更新发布说明、第三方声明或模型 release 时，必须写当前 YOLO11n 来源；不要沿用旧 `kitsumed/yolov8m_seg-speech-bubble` 描述。

非模型但必须随包保留：

| 文件 | 用途 |
| --- | --- |
| `paddleocr_v6_dict.txt` | PP-OCRv6 medium CTC 字典 |
| `models.json` | 模型 manifest |
| `ort/*.wasm` / `ort/*.mjs` | ONNX Runtime Web 浏览器推理运行时 |

## 已移除模型

这些文件不应再出现在 `public/models/` 或最终 `dist/models/` 发布包中：

| 文件 | 移除原因 |
| --- | --- |
| `ocr.onnx` | 旧 48px OCR 整体模型，已不再作为产品路径 |
| `ocr_encoder.onnx` | 旧 48px split encoder，已不再作为产品路径 |
| `ocr_decoder.onnx` | 旧 48px split decoder，已不再作为产品路径 |
| `ocr_dict.txt` | 旧 48px OCR 字典 |
| `ch_PP-OCRv5_rec_mobile.onnx` | 旧 PaddleOCR v5 mobile 候选，不再发布 |
| `paddleocr_v5_dict.txt` | 旧 PaddleOCR v5 字典 |
| `PP-OCRv6_small_rec.onnx` | v6 small 候选，不再发布 |
| `lama_fp32.onnx` | 旧 Lama inpaint，当前改用 AOT |
| 旧 `bubble.onnx` YOLOv8m 备份 | 当前改用 YOLO11n `bubble.onnx` |

## 维护规则

- 新增模型必须先写入本文档，再加入 `public/models/models.json`。
- 如果只是用于 benchmark 的候选模型，不要加入前端设置，也不要加入默认发布包。
- 模型二进制受 `.gitignore` 忽略；发布前以 `public/models/models.json` 为准检查实际 `public/models/` 和 `dist/models/` 文件集。
