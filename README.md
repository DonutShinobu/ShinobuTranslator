# ShinobuTranslator

ShinobuTranslator 是一个运行在浏览器中的漫画翻译扩展，主要用于 X/Twitter 图片大图场景。

它会在本地完成完整流程：文本检测、OCR、翻译、去字与排版，支持在原图与译图之间切换。

## 功能简介

- 在 X/Twitter 图片查看器中一键触发翻译
- 前端本地执行 ONNX 推理（按环境在 WebNN / WebGPU / WASM 之间回退）
- 支持 Google Web 翻译与 OpenAI 兼容 LLM
- Popup 中可配置目标语言、LLM 提供商与模型参数

## 本地开发

```bash
npm install
npm run dev
```

构建与预览：

```bash
npm run build
npm run preview
```

仅类型检查：

```bash
npx tsc --noEmit
```

## 使用方式（Chrome/Edge）

1. 执行 `npm run build`
2. 打开浏览器扩展管理页并启用开发者模式
3. 选择“加载已解压的扩展程序”，目录指向项目下的 `dist`
4. 打开 X/Twitter 图片大图页面，使用扩展按钮开始翻译
