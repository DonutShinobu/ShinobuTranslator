---
name: original-mode-prd
description: 新增原文模式——跳过翻译，将OCR原文原样排版到去字后的图片上
metadata:
  type: project
---

# PRD: 新增原文模式

## 目标

在现有的翻译模式和去字模式之外，新增"原文模式"（original mode），跳过翻译阶段，将 OCR 识别到的原文内容原样排版到去字后的图片上，替代原有的手写/印刷文字，使文字更加清晰易读。

## 已确认事实

- 当前有两种模式：`translate`（翻译模式）和 `erase`（去字模式）
- `ProcessMode` 类型定义在 `src/shared/config.ts` 和 `src/types.ts`
- 去字模式跳过翻译和排版，仅做去字（inpaint），输出纯净图片
- 翻译模式执行完整流水线：检测 → OCR → 排序 → 去字 + 翻译 → 排版
- 模式选择 UI 使用 `SegmentedControl` 组件，位于 popup `App.tsx`
- `normalizeProcessMode()` 用于校验模式值
- 排版引擎（`drawTypeset`）已有 `translatedText || sourceText` 回退机制
- `bake.ts` 中已有 `r.translatedText = r.sourceText` 的现有模式

## 已确认决策

- **排版方式：去字后排版原文** — 先 inpaint 去掉原有文字，再用排版引擎把 OCR 原文重新绘制上去。手写/模糊文字被替换为清晰排版文字，内容不变。

## 需求

- 新增 `original` 模式值到 `ProcessMode` 类型
- 原文模式流水线：检测 → OCR → 排序 → 去字 → 排版原文（跳过翻译）
- 排版使用 `sourceText`（OCR 原文），不使用翻译文本
- UI 的 `SegmentedControl` 新增"原文模式"选项
- `normalizeProcessMode()` 支持 `original` 值
- 进度标签需适配原文模式

## 验收标准

- [ ] 用户可在 popup 中选择"原文模式"
- [ ] 原文模式下，图片经过检测、OCR、去字后，OCR 原文原样排版到去字后的图片上
- [ ] 原文模式不执行翻译步骤
- [ ] 进度标签正确显示原文模式状态

## 暂不考虑

- 原文模式的字体/颜色自定义
- 原文排版的美化/优化处理