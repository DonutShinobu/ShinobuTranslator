# 漫画翻译流程深度分析与纯前端 WebNN 迁移记录

## 1. 目标与约束（对齐 PLAN.md）

- 目标：从“前端 + 后端（tmp_manga_image_translator）”切换到“纯前端浏览器推理”。
- 流程：文本检测 -> OCR -> 翻译 -> 去字 -> 排版嵌字。
- 推理优先级：文本检测/OCR/去字优先 WebNN，失败时回退 WASM（去字不再回退规则算法）。
- 关键要求：保留每一步中间结果（文本与图片），方便和现有正确结果逐步对照。

## 2. 原有项目结构与实际调用路径

### 2.1 前端入口与状态

- 入口：`src/App.tsx`
- 运行入口方法：`onRun()` 调用 `runPipeline(file, config, setProgress)`
- 主要状态：
  - 输入文件：`file`
  - 配置：`config`
  - 进度：`progress`
  - 产物：`result`

### 2.2 原有编排（改造前）

- 编排文件：`src/pipeline/orchestrator.ts`
- 原路径核心依赖：`runTmpDeepModel()`（`src/pipeline/deepModel.ts`）
- 原先行为：
  1. 加载图片
  2. 通过后端 `/translate/with-form/json` 完成检测/OCR/去字（以及可能的翻译）
  3. 如果后端未翻译，再走前端 `runTranslate()`
  4. 排版 `drawTypeset()`

### 2.3 后端实现位置（本地镜像）

- 后端入口：`tmp_manga_image_translator/server/main.py`（FastAPI）
- 关键接口：
  - `/translate/with-form/json`
  - `/translate/with-form/image`
- 核心流水线实现：`tmp_manga_image_translator/manga_translator/manga_translator.py`
  - 阶段顺序：detection -> ocr -> textline_merge -> translation -> mask_refinement -> inpainting -> rendering

## 3. 原有模型映射（后端）与 ONNX 可迁移性

### 3.1 文本检测（CTD）

- 代码：`tmp_manga_image_translator/manga_translator/detection/ctd.py`
- 模型映射：
  - GPU：`comictextdetector.pt`
  - CPU：`comictextdetector.pt.onnx`
- 结论：检测模型已有 ONNX 形态，前端迁移优先选择该链路。

### 3.2 OCR（48px）

- 代码：`tmp_manga_image_translator/manga_translator/ocr/model_48px.py`
- 模型映射：
  - `ocr_ar_48px.ckpt`
  - 字典：`alphabet-all-v7.txt`
- 结论：当前是 PyTorch ckpt，需导出 ONNX（编码器/解码器结构较复杂，建议先做最小可运行导出）。

### 3.3 去字（LaMa Large）

- 代码：`tmp_manga_image_translator/manga_translator/inpainting/inpainting_lama_mpe.py`
- 模型映射：
  - `lama_large_512px.ckpt`
- 结论：当前是 PyTorch ckpt，需导出 ONNX；输入包含图像与 mask。

## 4. 本次改造后的前端流水线（已落地）

### 4.1 新编排

- 文件：`src/pipeline/orchestrator.ts`
- 新顺序：
  1. `fileToImage()` 读图
  2. `detectTextRegions()` 文本检测
  3. `runOcr()` OCR 识别
  4. `runTranslate()` 翻译
  5. `runInpaint()` 去字
  6. `drawTypeset()` 排版嵌字

### 4.2 WebNN 运行时（先验证可用性）

- ONNX Runtime 封装：`src/runtime/onnx.ts`
  - 文本检测/OCR/去字：优先 `webnn`，失败回退 `wasm`
- 模型注册与会话缓存：`src/runtime/modelRegistry.ts`
  - 读取 `public/models/manifest.json`
  - 支持 `detector/ocr/inpaint` 会话初始化
- 启动自检：`src/runtime/selfCheck.ts`
  - 先做 WebNN API 可见性与最小 Session 冒烟
  - 再做 WASM 对照 Session，确保回退路径可用

### 4.3 中间结果保留（对照所需）

- 结果类型扩展：`src/types.ts`
  - `detectionCanvas`
  - `ocrCanvas`
  - `segmentationCanvas`
  - `cleanedCanvas`
  - `resultCanvas`
  - `runtimeStages`
- 可视化实现：`src/pipeline/visualize.ts`
  - 统一绘制文本框与标签
- 页面展示：`src/App.tsx`
- 新增“文本检测预览 / OCR 识别预览 / 文字分割预览 / 去字结果 / 最终中文图”
  - 文本列表保留原文与译文

## 5. 关键差异（改造前 vs 改造后）

- 改造前：检测/OCR/去字主要依赖后端 API。
- 改造后：主流程已改为纯前端执行，不再依赖 `tmpApiBaseUrl`。
- 改造后新增：WebNN/WASM 模型会话探测与状态展示，便于逐阶段替换推理后端。

## 6. 分步验收清单（逐步对照）

### 6.1 文本检测

- 验收点：页面出现“文本检测预览”，且框位置与气泡区域基本一致。

### 6.2 OCR

- 验收点：页面出现“OCR 识别预览”，并在文本列表中出现原文。

### 6.3 去字

- 验收点：页面出现“去字结果”，对照 `正确结果.png` 检查残影与边缘。

### 6.4 嵌字排版

- 验收点：页面出现“最终中文图”，并能下载导出。

### 6.5 运行时

- 验收点：页面显示 detector/ocr/inpaint 的运行时状态（webnn 或 wasm）。

## 7. 后续 ONNX 深化替换建议

- 第一步：先完成 WebNN 启动自检与最小 Session 冒烟，确认浏览器侧可跑通。
- 第二步：将检测模型切换为 WebNN 优先执行（失败回退 WASM）。
- 第三步：将 OCR 48px ONNX 推理切换为 WebNN 优先执行（失败回退 WASM）。
- 第四步：基于 LaMa Large ONNX 继续优化去字输入尺寸与吞吐。
- 第五步：进一步收敛预处理/后处理参数，减少不同模型间的归一化歧义。

## 8. 本次变更文件索引

- `src/types.ts`
- `src/runtime/onnx.ts`
- `src/runtime/modelRegistry.ts`
- `src/pipeline/orchestrator.ts`
- `src/pipeline/visualize.ts`
- `src/App.tsx`
- `src/styles.css`
- `docs/flow-migration-analysis.md`
