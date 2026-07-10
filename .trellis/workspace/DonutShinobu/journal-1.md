# Journal - DonutShinobu (Part 1)

> AI development session journal
> Started: 2026-05-23

---



## Session 1: 修复大图模式翻译按钮跟随面板移动

**Date**: 2026-05-23
**Task**: 修复大图模式翻译按钮跟随面板移动
**Branch**: `worktree-fix-translate-btn-follow-panel`

### Summary

在 twitter adapter 的 createUiAnchor 中添加 ResizeObserver + transitionstart/transitionend RAF 循环，让翻译按钮在 CSS transition 期间逐帧跟随参考按钮位置，动画结束后停止 RAF 并做最终定位，锚点移除时自动清理所有 observer/listener

## Session 2: 颜色识别算法诊断与对比测试框架

**Date**: 2026-05-23
**Task**: 颜色识别算法诊断与对比测试框架
**Branch**: `worktree-color-test-benchmark`

### Summary

建立 PaddleOCR 文字前景/背景色识别的诊断+量化对比测试框架。实现了 Phase 1 诊断脚本（追踪颜色路径、hasFg/hasBg 步数、DeltaE、安全网触发）和 Phase 2 对比脚本（当前算法 vs 算法 A vs 算法 D）。24 个 Vitest 测试通过。新建 .trellis/spec/benchmark/ spec 层，沉淀完整使用指南。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `1248d1b` | (see git log) |
| `c73e9ca` | (see git log) |
| `d6221aa` | (see git log) |
| `cb4f6a5` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete

## Session 3: 统一 benchmark 目录结构

**Date**: 2026-05-23
**Task**: 统一 benchmark 目录结构
**Branch**: `master`

### Summary

将 scripts/benchmark/ 和 benchmark/ 合并为 benchmark/typeset/ 和 benchmark/color/ 两个自包含子目录，更新所有 import 路径、npm scripts、.gitignore、spec 文档，335 个测试全部通过

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `7399b30` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 4: 颜色 benchmark fixture 半自动生成流程

**Date**: 2026-05-23
**Task**: 颜色 benchmark fixture 半自动生成流程
**Branch**: `master`

### Summary

实现从日志导出半自动生成颜色 benchmark fixture：修改日志导出增加 fgColor/bgColor 字段 + sourceImageUrl 改为 data URL，创建 gen-annotation.ts 和 gen-fixture.ts 两个脚本，修复 benchmark ROOT 路径解析 bug（import.meta.dirname undefined + 层级偏差），用真实漫画 fixture 替换旧手写 fixture

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `d49791e` | (see git log) |
| `83ce714` | (see git log) |
| `04dd68c` | (see git log) |
| `f0cf4da` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 5: Pixiv 阅读模式多图翻译支持

**Date**: 2026-05-23
**Task**: Pixiv 阅读模式多图翻译支持
**Branch**: `master`

### Summary

Pixiv 阅读模式底栏新增「翻译当前页」和「翻译全部」按钮。翻译当前页按滑块精确定位可见页（支持单页/双页模式），翻译全部串行执行所有页面并在按钮文字显示进度。阅读模式关闭后翻译继续后台执行。DOM 研究首次使用 Windows Chrome CDP 远程调试完成。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `2c3bca3` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 6: 统一日志功能：ortDebugMode→enableDebugLog，解耦下载按钮与排版调试可视化

**Date**: 2026-05-23
**Task**: 统一日志功能：ortDebugMode→enableDebugLog，解耦下载按钮与排版调试可视化
**Branch**: `worktree/unify-debug-logs`

### Summary

将 ORT 调试和排版调试两个日志功能合并重构：ortDebugMode 改为 enableDebugLog（日志记录），下载日志按钮与排版调试选项解耦，删除 ORT profiling 整条链路，PipelineConfig 新增 collectDebugLog 字段实现可视化与数据采集职责分离，日志新增 pageUrl。15 文件，+28/-217 行。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `8f75306` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 7: 修复 Pixiv 无内容页面导致翻译全部按钮不切换

**Date**: 2026-05-24
**Task**: 修复 Pixiv 无内容页面导致翻译全部按钮不切换
**Branch**: `master`

### Summary

修复 translatePageByUrl 中未处理 pipeline 无内容错误（未找到文本/未返回有效识别结果），导致 allHaveTranslation 检查失败，按钮永远显示翻译全部

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `98801b3` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 8: WebGPU compute shader preprocessing for detector letterbox

**Date**: 2026-05-28
**Task**: WebGPU compute shader preprocessing for detector letterbox
**Branch**: `worktree-gpu-optimize`

### Summary

实现detector letterbox GPU预处理：WGSL compute shader + bilinear interpolation + Tensor.fromGpuBuffer + preferredOutputLocation:gpu-buffer。修复PaddleOCR platform参数缺失、tensorToTransport GPU buffer处理、回退链完整性。添加WebGPU数据流spec文档。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `23272c9` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 9: OCR inference speed optimization

**Date**: 2026-06-01
**Task**: OCR inference speed optimization
**Branch**: `master`

### Summary

Implemented split encoder/decoder OCR caching, GPU-side AR postprocess, browser smoke benchmarks, X image before/after comparison, and synced validated build artifacts.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `d0414c4` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 10: OCR split-only model release

**Date**: 2026-06-01
**Task**: OCR split-only model release
**Branch**: `master`

### Summary

Switched builtin OCR runtime to split-only encoder/decoder models, removed ocr.onnx from the default release/download path, added portable model release scripts, uploaded and verified models-v0.4.0 assets, and recorded Chrome/WebGPU OCR timing for the latest X image.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `37abbb0` | (see git log) |
| `7648dbd` | (see git log) |
| `0c96df2` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 11: Screenshot context translation

**Date**: 2026-06-03
**Task**: Screenshot context translation
**Branch**: `codex/screenshot-context-translation`

### Summary

Implemented a generic right-click screenshot translation flow with in-page region selection, visible-tab capture, cropped pipeline input, draggable result overlays, close cleanup, and tests for message guards and crop geometry.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `372a4b4` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 12: Polish screenshot translation overlay

**Date**: 2026-06-03
**Task**: Polish screenshot translation overlay
**Branch**: `codex/screenshot-context-translation`

### Summary

Unified generic context-menu translation through the screenshot floating overlay, polished pill close/selection confirmation visuals, added screenshot geometry helpers with tests, and recorded frontend overlay conventions.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `fe64b99` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 13: 快捷键与非线性动画

**Date**: 2026-06-03
**Task**: 快捷键与非线性动画
**Branch**: `master`

### Summary

为截图翻译和悬停元素翻译接入 Chrome commands，在 popup 展示真实绑定并优化为标题行小字；补充截图候选切换与浮动译图缩放动画，并修复缩放时药丸右对齐。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `d697151` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 14: 回退进度动画优化实验

**Date**: 2026-06-03
**Task**: 回退进度动画优化实验
**Branch**: `master`

### Summary

按用户要求回退 spinner/阶段调度优化，仅保留进度卡顿观测代码、浏览器 jank smoke 和实验文档记录。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `21e8b48` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 15: 阶段明细可视化卡片

**Date**: 2026-06-04
**Task**: 阶段明细可视化卡片
**Branch**: `master`

### Summary

完成翻译完成态阶段明细可视化卡片：新增持久化展开状态、阶段占比条、模型运行时 chips、结构化卡片数据测试，并更新 frontend 测试目录规范。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `715efb8` | (see git log) |
| `eedf84a` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 16: Nano Banana 图片翻译任务收尾

**Date**: 2026-06-11
**Task**: Nano Banana 图片翻译任务收尾
**Branch**: `master`

### Summary

完成 Nano Banana/Gemini 图片端到端翻译任务收尾：确认配置、消息、Gemini App/API 图像路径、popup 控件、content 展示路径和相关测试；本轮复跑 npm run test、npx tsc --noEmit、npm run build 以及 dist 入口 node --check。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `ce84dcc` | (see git log) |
| `a0f4bd0` | (see git log) |
| `8696a6c` | (see git log) |
| `4cab5ec` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 17: Stabilize vertical source geometry

**Date**: 2026-06-11
**Task**: Stabilize vertical source geometry
**Branch**: `master`

### Summary

Fixed vertical typeset source geometry ordering and per-column advance safety, added fixture audit and non-destructive rebake workflow, rebuilt local fixtures cleanly, and verified build, tests, benchmark, and fixture audit.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `8373d80` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 18: PaddleOCR v6 medium 收敛与任务收尾

**Date**: 2026-06-16
**Task**: PaddleOCR v6 medium 收敛与任务收尾
**Branch**: `master`

### Summary

完成 OCR 冷启动和全流程基准记录，插件侧 Paddle 选项收敛到 paddleocr_v6_medium，新增 v6 medium 字典与模型校验/benchmark 支持，记录 Trellis 规范并归档 PaddleOCR v6 replacement 任务。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `69ec023` | (see git log) |
| `1179750` | (see git log) |
| `4a170f4` | (see git log) |
| `67c38e0` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 19: Paddle pipeline profiling and optimization

**Date**: 2026-06-17
**Task**: Paddle pipeline profiling and optimization
**Branch**: `master`

### Summary

Added Paddle OCR sub-stage debug, browser/Node Paddle profiling tools, WebGPU width-bucket batching, provider experiments, and recorded WASM/WebGPU cold-start findings.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `918f947` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 20: Paddle cold-start validation

**Date**: 2026-06-17
**Task**: Paddle cold-start validation
**Branch**: `codex/paddle-cold-start-validation`

### Summary

Validated Paddle OCR cold-start routes on branch codex/paddle-cold-start-validation. Added benchmark-only controls for small model, prepare/warmup, fixed width, and ORT graph capture; recorded reports showing small legacy as the best current candidate, prepare as promising but contention-prone, and graph capture blocked by GPU external buffer requirements.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `cff16fd` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 21: Structured diagnostic logging

**Date**: 2026-06-27
**Task**: Structured diagnostic logging
**Branch**: `master`

### Summary

Implemented structured diagnostic logging with popup download and clear actions, LLM/API/pipeline event capture, text .log export, redaction, timestamp hardening, tests, and spec updates.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `5c5b7a4` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 22: Manga translation coherence

**Date**: 2026-06-27
**Task**: Manga translation coherence
**Branch**: `master`

### Summary

Completed the translation coherence task: improved LLM prompt and structured payloads for natural Chinese wording, added structured single-region fallback after batch misses, improved semantic column splitting, and covered the behavior with translator, pipeline, and typeset tests.

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `ad52490` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 23: 竖排字形方向与 mixed 排版

**Date**: 2026-07-10
**Task**: 竖排字形方向与 mixed 排版
**Branch**: `master`

### Summary

基于 Unicode 17 实现竖排方向、Latin mixed run 与句末双标点纵中横，修正真实墨迹度量和旋转中心，补充 benchmark 字形评分；14 张 fixture、507 项测试、类型检查与构建均通过。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `636eef5` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
