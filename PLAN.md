# 网页版漫画翻译实现计划

## 目标
- 纯前端实现（不依赖独立后端服务）
- 输入：日文漫画图片
- 输出：中文漫画图片
- 流水线：文本检测 -> OCR -> 翻译 -> 去字 -> 排版 -> 嵌字
- 检测/OCR/去字模型优先使用 WebGPU（浏览器端）

## 约束与原则
- 不新增自建后端 API；翻译使用 Google 翻译或大模型 API（浏览器直接调用）
- 模型资产参考 `zyddnys/manga-image-translator`
- 前端推理优先 `onnxruntime-web` + WebGPU，必要时 WASM 回退
- 全流程可观察（每一步可预览中间结果）

## 技术方案

### 1) 前端框架与工程
- Vite + React + TypeScript
- Canvas 2D 负责可视化与最终合成
- Web Worker 负责任务隔离与避免主线程阻塞

### 2) 模型执行层
- 推理框架：`onnxruntime-web`
- 设备策略：优先 `webgpu`，失败回退 `wasm`
- 模型管理：
  - 本地 `public/models/manifest.json` 管理模型 URL、输入尺寸、归一化参数
  - 支持从 `manga-image-translator` 对应模型导入/转换后的 ONNX 文件

### 3) 图像流水线
1. 读图与预处理（缩放、归一化）
2. 文本检测（输出气泡/文字框）
3. OCR（识别日文文本）
4. 翻译（Google/LLM）
5. 去字（inpaint）
6. 排版（自动换行、字号拟合）
7. 嵌字（Canvas 合成输出）

### 4) 翻译适配层
- `google` 适配器：使用公开端点（可能受 CORS/配额限制）
- `llm` 适配器：支持 OpenAI 兼容接口（用户输入 API Key）
- 统一接口：`translateBatch(texts, from, to)`

### 5) 调试与验证
- 浏览器开发 MCP：页面流程调试、DOM 状态与错误检查
- 每一步展示中间图层（检测框、OCR 文本、去字后底图、最终图）
- 导出 PNG

## 里程碑

### M1: 工程初始化与 UI 骨架
- 文件上传、预览、参数面板、执行按钮、进度状态

### M2: 推理运行时与模型加载
- `onnxruntime-web` 接入
- 模型 manifest 与懒加载
- WebGPU/WASM 回退机制

### M3: 端到端最小可运行链路
- 先以占位/简化算法打通全链路（含导出）

### M4: 模型替换与效果增强
- 替换为真实检测/OCR/去字模型
- 优化排版、文字样式与可读性

### M5: 稳定性与性能
- worker 化、分块推理、缓存
- 异常处理与重试

## 目录草案
```
src/
  app/
    App.tsx
    state.ts
  pipeline/
    orchestrator.ts
    steps/
      detect.ts
      ocr.ts
      translate.ts
      inpaint.ts
      typeset.ts
      compose.ts
  runtime/
    ort.ts
    modelRegistry.ts
    tensor.ts
  translators/
    google.ts
    llm.ts
    index.ts
  workers/
    pipeline.worker.ts
  ui/
    ImageUploader.tsx
    StageViewer.tsx
    Controls.tsx
    ProgressPanel.tsx
```

## 风险与应对
- WebGPU 兼容性：提供 WASM 回退
- 模型体积大：懒加载 + 分模块下载 + 本地缓存
- Google 翻译端点不稳定：LLM 适配器兜底
- 漫画字排版复杂：先规则排版，后续加入更强布局策略

## 本次执行顺序
1. 初始化前端工程
2. 实现 UI 骨架和流水线状态机
3. 打通端到端（先可运行）
4. 接入翻译适配器
5. 接入/预留模型注册与 WebGPU 推理
6. 浏览器调试与构建验证
