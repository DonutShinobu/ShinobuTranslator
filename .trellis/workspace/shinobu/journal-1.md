# Journal - shinobu (Part 1)

> AI development session journal
> Started: 2026-05-12

---



## Session 1: 初始化 Trellis 项目管理框架与开发规范文档

**Date**: 2026-05-12
**Task**: 初始化 Trellis 项目管理框架与开发规范文档
**Branch**: `master`

### Summary

完成 Trellis init 后的 bootstrap 任务：扫描代码库实际模式，填充 6 个 spec 文件（directory-structure、component-guidelines、hook-guidelines、state-management、type-safety、quality-guidelines），修复 AGENTS.md 被模板覆盖的问题，恢复项目信息并补充 Trellis 模板块。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `bbec7b9` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 2: pipeline架构重构：消除重复代码与拆分巨型文件

**Date**: 2026-05-13
**Task**: pipeline架构重构：消除重复代码与拆分巨型文件
**Branch**: `master`

### Summary

将5个700+行巨型文件(detect/ocr/typesetGeometry/textlineMerge/maskRefinement)按职责拆分为子目录模块，提取15+个跨文件重复函数到shared/utils.ts和pipeline/utils.ts，清理TranslatorCore与config.ts重复逻辑。纯内部重构，TypeScript零错误，34测试全通过，构建成功。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `8a85b09` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 3: Spec更新：反映pipeline架构重构

**Date**: 2026-05-13
**Task**: Spec更新：反映pipeline架构重构
**Branch**: `master`

### Summary

更新3个spec文件以反映pipeline架构重构后的目录结构和约定：directory-structure.md重写目录布局，quality-guidelines.md新增共享工具规范，code-reuse-thinking-guide.md新增语义别名模式。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `225f00b` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 4: 修复倾斜竖排文本字号异常缩小

**Date**: 2026-05-13
**Task**: 修复倾斜竖排文本字号异常缩小
**Branch**: `fix/tilted-vertical-font-shrink`

### Summary

修复 compositeRegion 缩放基准和 expandRegionBeforeRender AABB 问题，构建产物已部署到 C:\code\manga-translate\dist

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `0e5a0cc` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 5: 修复调试橙色列框倾斜竖排缩放偏差

**Date**: 2026-05-13
**Task**: 修复调试橙色列框倾斜竖排缩放偏差
**Branch**: `master`

### Summary

compositeRegion 返回 CompositeTransform，debug overlay 复用而非独立重算缩放系数，消除公式分叉风险

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `ba2038c` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 6: 补充纯函数单元测试体系

**Date**: 2026-05-13
**Task**: 补充纯函数单元测试体系
**Branch**: `master`

### Summary

建立 Vitest 测试体系：创建 vitest.config.ts，迁移旧测试到独立 tests/ 目录，新增 9 个测试文件覆盖 typeset/detect/ocr/textlineMerge/utils 等模块的 51+ 个纯函数，从 34 个测试扩展到 289 个测试

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `59f4ae9` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 7: ONNX 推理移入自建 Worker，消除动画卡顿

**Date**: 2026-05-15
**Task**: ONNX 推理移入自建 Worker，消除动画卡顿
**Branch**: `master`

### Summary

将 ONNX 推理（session.create/run + 自回归 OCR 解码循环 + selfCheck）移入自建 Web Worker，通过 comlink RPC 通信。Content script 通过 blob URL 创建 Worker（chrome-extension:// URL 受 same-origin 限制）。Worker 构建为独立步骤（scripts/build-worker.mjs），所有依赖内联无外部 chunk 导入。输入 tensor 用 structured clone 保留主线程所有权，输出用 Comlink.transfer 零拷贝。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `202714a` | (see git log) |
| `82af7c2` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 8: 修复多列并排翻译间距异常宽

**Date**: 2026-05-15
**Task**: 修复多列并排翻译间距异常宽
**Branch**: `master`

### Summary

estimateVerticalPreferredProfile 新增 originalContentWidth 参数，使用扩展前区域宽度计算列间距，避免区域扩展导致列间距异常放大

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `044a71d` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 9: 新增原文模式

**Date**: 2026-05-26
**Task**: 新增原文模式
**Branch**: `master`

### Summary

新增原文模式(original mode)：跳过翻译阶段，将OCR原文原样排版到去字后的图片上。改动涉及类型扩展(ProcessMode)、orchestrator流水线分支、UI SegmentedControl新增选项。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `40409ae` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 10: 优化横排文字排版

**Date**: 2026-05-26
**Task**: 优化横排文字排版
**Branch**: `master`

### Summary

将竖排6项排版优化技术迁移到横排路径：字体大小优化循环、LLM换行提示、行重平衡、动态间距调整、气泡遮罩感知、contentHeight扩展。5个文件880行新增58行替换。

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `b07f4b0` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 11: 归档历史遗留任务

**Date**: 2026-05-26
**Task**: 归档历史遗留任务
**Branch**: `master`

### Summary

归档两个已完成但未归档的任务：05-23-unify-debug-logs（统一日志功能）和05-26-process-mode（处理模式）。补写task.json后通过task.py archive归档到archive/2026-05/

### Main Changes

(Add details)

### Git Commits

(No commits - planning session)

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete


## Session 12: stroke-aware-mask: 亮色描边检测

**Date**: 2026-05-26
**Task**: stroke-aware-mask: 亮色描边检测
**Branch**: `worktree-stroke-aware-mask`

### Summary

在去字流程中增加亮色描边检测逻辑，减少白描边残留问题

### Main Changes

(Add details)

### Git Commits

| Hash | Message |
|------|---------|
| `938a400` | (see git log) |

### Testing

- [OK] (Add test results)

### Status

[OK] **Completed**

### Next Steps

- None - task complete
