# ShinobuTranslator

ShinobuTranslator 是一个运行在浏览器中的漫画翻译扩展，主要用于推特条漫翻译场景。

它会在本地完成完整流程：文本检测、OCR、翻译、去字与排版，支持在原图与译图之间切换。

## 功能简介

- 在推特大图界面点击即可翻译
- 前端本地执行 ONNX 推理（按环境在 WebNN / WebGPU / WASM 之间回退）
- 支持 Google 翻译与大模型翻译
- 主要用于竖排条漫翻译，目前仅支持简体/繁体中文

## 使用方式（Chrome/Edge）

1. 前往Releases下载压缩包并解压到本地文件夹
2. 打开浏览器扩展管理页并启用开发者模式
3. 选择“加载已解压的扩展程序”，目录指向解压出来的文件夹
4. 打开 X/Twitter 图片大图页面，使用扩展按钮开始翻译

## 碎碎念

本项目灵感源于 https://github.com/zyddnys/manga-image-translator 和 https://greasyfork.org/scripts/437569 

其中的油猴脚本似乎因为服务器问题无法继续使用，于是决定在不依赖个人服务器的情况下实现一个效果类似的拓展

代码全部由大模型（gpt-5.3-codex、claude-4.6-opus、glm-5）生成

## 许可证与第三方声明

- 本项目许可证：`GPL-3.0`（见根目录 `LICENSE`）
- 第三方模型与脚本处理说明：见 `THIRD_PARTY_NOTICES.md`