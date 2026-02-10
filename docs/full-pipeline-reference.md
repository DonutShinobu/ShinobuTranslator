# 漫画翻译项目完整流程与迁移参考（前后端 -> 纯前端 WebNN）

## 1. 目标与边界

- 目标：将现有“前端 + Python 后端”流程迁移为“无后端、浏览器本地推理”的项目。
- 推理框架：`onnxruntime-web`，文本检测/OCR 优先 `webnn`，失败回退 `wasm`。
- 流程顺序：文本检测 -> OCR 识别 -> 翻译 -> 去字 -> 排版嵌字。
- 约束：不新增自建后端 API；翻译层可继续使用浏览器直连第三方 API。

## 2. 现有项目结构（关键目录）

- 前端主工程：`src/`
  - 流程编排：`src/pipeline/orchestrator.ts`
  - 检测：`src/pipeline/detect.ts`
  - OCR：`src/pipeline/ocr.ts`
  - 去字：`src/pipeline/inpaint.ts`
  - 排版：`src/pipeline/typeset.ts`
  - ONNX 运行时：`src/runtime/onnx.ts`
  - 模型清单与会话缓存：`src/runtime/modelRegistry.ts`
- 模型清单：`public/models/manifest.json`
- 后端参考实现（用于模型来源与流程对照）：`tmp_manga_image_translator/`

## 3. 原后端真实执行路径（参考）

### 3.1 API 到服务

- 后端入口：`tmp_manga_image_translator/server/main.py`
- 典型接口：`/translate/with-form/json`、`/translate/with-form/image`
- 服务核心：`tmp_manga_image_translator/manga_translator/manga_translator.py`

### 3.2 阶段顺序

- detection -> ocr -> textline_merge -> translation -> mask_refinement -> inpainting -> rendering

## 4. 模型映射与可迁移性

### 4.1 文本检测（可直接 ONNX）

- 代码：`tmp_manga_image_translator/manga_translator/detection/ctd.py`
- 模型：
  - GPU：`comictextdetector.pt`
  - CPU/ONNX：`comictextdetector.pt.onnx`
- 结论：可直接迁移到浏览器 ONNX，并切换到 WebNN 执行。

### 4.2 OCR（需从 ckpt 导出 ONNX）

- 代码：`tmp_manga_image_translator/manga_translator/ocr/model_48px.py`
- 模型：`ocr_ar_48px.ckpt`
- 字典：`alphabet-all-v7.txt`
- 结论：需导出 ONNX，并提供字典文件（可放 `public/models`）。

### 4.3 去字（建议先 AOT，再评估 LaMa）

- 代码：
  - AOT：`tmp_manga_image_translator/manga_translator/inpainting/inpainting_aot.py`
  - LaMa：`tmp_manga_image_translator/manga_translator/inpainting/inpainting_lama_mpe.py`
- 结论：AOT 更适合作为浏览器首个 ONNX 去字路径；LaMa 复杂度更高。

## 5. 当前前端无后端流程（已落地）

### 5.1 编排入口

- `src/pipeline/orchestrator.ts`
- 执行顺序：
  1. `fileToImage()` 读图
  2. `detectTextRegions()` 检测
  3. `runOcr()` OCR
  4. `runTranslate()` 翻译
  5. `runInpaint()` 去字
  6. `drawTypeset()` 排版

### 5.2 模型运行时

- `src/runtime/onnx.ts`
  - `onnxruntime-web/all`
  - Provider 顺序（文本检测/OCR）：`webnn` -> `wasm`
- `src/runtime/modelRegistry.ts`
  - 读取 `public/models/manifest.json`
  - 缓存 `detector/ocr/inpaint` 会话

### 5.3 阶段可视化工件

- 检测预览：`detectionCanvas`
- OCR 预览：`ocrCanvas`
- 文字分割预览：`segmentationCanvas`
- 去字结果：`cleanedCanvas`
- 最终结果：`resultCanvas`

## 6. 本次迁移改造点（关键）

### 6.1 OCR：ONNX-only（无 Tesseract 回退）

- 文件：`src/pipeline/ocr.ts`
- 策略：
  - 优先尝试 `getModelSession("ocr")` 执行 ONNX。
  - ONNX 失败或无有效解码结果时，直接报错，不走 Tesseract。
  - 支持可选字典地址 `dictUrl`（manifest 配置）用于 CTC 贪心解码。

### 6.2 去字：新增 ONNX 优先（无规则回退）

- 文件：`src/pipeline/inpaint.ts`
- 策略：
  - 优先尝试 `getModelSession("inpaint")` 执行 ONNX（`webnn` -> `wasm`）。
  - 移除规则去字回退路径，仅保留 ONNX 推理链路。
  - 去字阶段为异步，编排层使用 `await runInpaint(...)`。

### 6.3 manifest 扩展字段（兼容旧配置）

- 文件：`src/runtime/modelRegistry.ts`
- 新增可选字段：
  - `dictUrl`（OCR 字典）
  - `normalize`（输入归一化策略）
  - `outputNormalize`（输出归一化策略）
  - `maskInputName`（inpaint mask 输入名）

## 7. 分阶段验收标准（对照图片）

### 7.1 检测阶段

- 期望：文本框覆盖漫画对白区域，误检可接受但不可大面积漏检。

### 7.2 OCR 阶段

- 期望：文本列表出现日文原文，主要对白可识别。

### 7.3 去字阶段

- 期望：文字主体被清除，背景过渡可接受，无大块脏污。

### 7.4 排版嵌字阶段

- 期望：译文落入气泡，换行可读，最终图可导出。

## 8. 运行与调试建议

- 模型文件放置：`public/models/`
  - 已有：`detector.onnx`
  - 待补：`ocr.onnx`、`lama_fp32.onnx`（必需，缺失会导致对应阶段失败）
- 运行：`npm run dev`
- 构建验证：`npm run build`

## 9. 后续可继续推进

- 将 OCR 与去字的 ONNX 输入输出名、字典与预后处理参数收敛到 `manifest.json`。
- 为每个阶段增加“导出当前阶段 PNG”按钮，便于回归比对。
- 在 Web Worker 中执行推理，降低主线程卡顿。

## 10. WebNN 迁移实施顺序（本次）

1. 先做运行时自检：验证 `navigator.ml` 可见性 + ORT WebNN 最小 Session 冒烟。
2. 文本检测迁移：将 detector 运行时顺序切到 `webnn` -> `wasm`，确认检测框稳定。
3. OCR 迁移：将 OCR 运行时顺序切到 `webnn` -> `wasm`，确认识别文本输出稳定。
4. 去字迁移：inpaint 切到 `webnn` -> `wasm`，并移除规则去字回退。

## 11. 本地阶段验收记录（v6）

- 输入样例：`测试图片.png`
- 产物目录：`artifacts/`
  - `stage_detection_v6.png`
  - `stage_ocr_v6.png`
  - `stage_translated_overlay_v6.png`
  - `stage_inpainted_v6.png`
  - `stage_final_typeset_v6.png`

### 11.1 检测

- 能运行并产出文本框。
- 对主要对白覆盖率已明显高于早期版本，但仍有少量漏检与误检（非文字区域小框）。

### 11.2 OCR

- 能运行并产出 OCR 预览框。
- 仍存在漏检（小气泡、拟声词）与部分框位不精准问题，影响后续翻译完整性。

### 11.3 去字

- 能运行并产出去字图。
- 当前回退算法以“遮盖 + 融合”为主，部分区域仍有残影，背景过渡可见处理痕迹。

### 11.4 嵌字排版

- 能运行并生成最终图。
- 可读性基本可用，但存在中日混排残留、部分低对比文本与长竖排拥挤问题。

### 11.5 结论

- 无后端链路已打通：检测 -> OCR -> 翻译 -> 去字 -> 嵌字均可在前端独立运行。
- `lama_fp32.onnx` 为当前去字必需模型，不再回退到规则去字算法。
- 若要达到更高质量成品，下一步应补齐 ONNX OCR 与 ONNX Inpaint 模型，并按 manifest 参数细化预后处理。
