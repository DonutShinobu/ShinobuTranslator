# Frontend Development Guidelines

> Best practices for frontend development in this project.

---

## Overview

This project is a Chrome Manifest V3 browser extension for translating manga/comics on Twitter/X, Pixiv, and E-Hentai. Runtime contexts include the imperative-DOM content script, background service worker, React popup, and separately built ONNX Worker; benchmark mode adds an isolated page entry that is absent from Release.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module organization and file layout | Filled |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition | Filled |
| [Hook Guidelines](./hook-guidelines.md) | Custom hooks, data fetching patterns | Filled |
| [State Management](./state-management.md) | Local state, global state, server state | Filled |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | Filled |
| [Type Safety](./type-safety.md) | Type patterns, validation | Filled |
| [WebGPU Dataflow](./webgpu-dataflow.md) | GPU-accelerated preprocessing and IO Binding contracts | Filled |
| [Runtime Models](./runtime-models.md) | 本地模型来源、用途、发布包文件集和 OCR 引擎固定策略 | Filled |
| [Vertical Typesetting](./vertical-typesetting.md) | Unicode 竖排方向、mixed run、纵中横与 Canvas 渲染契约 | Filled |

---

## Key Architecture Facts

- **React is only in the popup** — content scripts use imperative DOM (`document.createElement`)
- **No external state library** — `useState` in popup, `PhotoStateStore`/controllers in content, `storage.local` in background
- **Pipeline is lazy-loaded** — `import('../../pipeline/orchestrator')` only when user clicks translate
- **本地模型固定清单** — 发布包只包含 detector、PP-OCRv6 medium、AOT inpaint、YOLO11n bubble；前端不提供 OCR 引擎切换
- **Thin composition roots** — Background 通过 router/services 分层；`TranslatorCore` 组合 store/controllers/UI
- **Three Release Vite entries** — content.js、background.js、popup.js；`onnxWorker.js` 由独立脚本构建
- **Benchmark is isolated** — `benchmark.html`/`src/benchmark/browserEntry.ts` 只在 benchmark mode 出现
- **Standard quality gate** — `npm run check` 检查 app/tests/benchmark 类型、Vitest、Release/Worker 构建和产物边界
- **Custom Vite plugin** bridges ES module output to Chrome's classic script injection for content scripts

---

**Language**: Trellis 文档默认使用中文；新增或大幅更新 `.trellis/` 文档时遵循 [Trellis 文档语言约定](../guides/documentation-conventions.md)。历史英文规范不需要仅因语言迁移而重写。
