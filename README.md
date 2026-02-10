# Manga Translate Web

前端版漫画翻译原型：输入日文漫画图，输出中文漫画图。

## 已实现流程
- 文本检测（前端执行，ONNX 运行时优先 WebNN）
- OCR（前端执行）
- 文本翻译（有道或 OpenAI 兼容 LLM API）
- 去字（前端执行，ONNX 运行时优先 WebNN，失败回退 WASM）
- 排版与嵌字（Canvas 自动换行）
- 中间结果可视化（检测框 / OCR / 翻译框 / 去字 / 最终图）

## 运行
```bash
npm install
npm run dev
```

## 模型接入（来自 manga-image-translator）
1. 从 `https://github.com/zyddnys/manga-image-translator` 获取模型并转换为浏览器可运行的 ONNX。
2. 放到 `public/models`。
3. 更新 `public/models/manifest.json`。

## 翻译说明
- 有道：走公开 Demo 端点，可能受频率限制。
- LLM：浏览器直连时 API Key 暴露风险高，仅建议本地测试使用。

## 调试
- 可使用浏览器开发工具或 Browser MCP 检查网络请求、Canvas 输出和错误日志。

## 迁移分析文档
- 详见 `docs/flow-migration-analysis.md`
- 完整流程参考 `docs/full-pipeline-reference.md`
