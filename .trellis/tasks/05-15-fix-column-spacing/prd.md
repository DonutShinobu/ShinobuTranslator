# 四列并排翻译间距异常宽

## Goal

修复漫画页面出现四列（或多列）竖排文字并排时，翻译后列间距异常宽的问题，使间距接近原文列间距。

## 根因

`estimateVerticalPreferredProfile` 使用**扩展后的区域宽度** (`contentWidth`) 计算列间距，将所有多余空间分配给列间距。区域扩展后宽度远大于原文，导致列间距异常宽。

核心链条：检测膨胀 → 区域扩展 → contentWidth 增大 → rawSpacing 增大 → colSpacingScale 放大（最高 2.5x）

## Decision (ADR-lite)

**Context**: 翻译后列间距应接近原文列间距，且不影响文字大小
**Decision**: Option B — 使用**原始区域宽度**（扩展前）计算列间距，而非扩展后的区域宽度。扩展产生的多余宽度作为区域边框余量，不流入列间距。
**Consequences**: 列间距将与原文列间距一致；区域扩展后多余宽度变为不可见的边框余量（可能需要少量 boxPadding 吸收）

## Requirements

* 翻译后的多列文字列间距应接近原文列间距
* 单列和双列场景不受影响
* 现有的文字填充/排版质量不下降

## Technical Approach

### 核心改动

**1. `estimateVerticalPreferredProfile` 新增 `originalContentWidth` 参数**

```ts
// 当前公式（使用扩展后宽度）
const rawSpacing = (contentWidth - targetColumnCount * metrics.colWidth) / (targetColumnCount - 1);

// 修改后（使用原始宽度）
const spacingWidth = originalContentWidth ?? contentWidth;
const rawSpacing = (spacingWidth - targetColumnCount * metrics.colWidth) / (targetColumnCount - 1);
```

**2. `computeFullVerticalTypeset` 传递原始宽度**

在 `expandRegionBeforeRender` 之前，计算 `originalContentWidth`：
```ts
const originalContentWidth = Math.max(20, clonedQuadDims.width - resolveBoxPadding(cloned) * 2);
```

然后传递给 `estimateVerticalPreferredProfile` 的三个调用点（行 135、199、229）。

### 涉及文件

* `src/pipeline/typeset/fontFit.ts` — `estimateVerticalPreferredProfile` 函数签名和间距计算逻辑
* `src/pipeline/typeset/index.ts` — `computeFullVerticalTypeset` 中三处调用点传递 `originalContentWidth`

### 可选优化（视效果决定）

* `resolveBoxPadding` 返回少量 padding（如 `fontSize * 0.3`）吸收扩展余量，让文字块居中更自然
* 降低 `colSpacingScale` 上限从 2.5 到更合理值（1.5）

## Acceptance Criteria

* [ ] 四列并排场景：翻译后列间距视觉上接近原文列间距
* [ ] 单列/双列场景：排版效果不退化
* [ ] 长文字场景：多列排版仍能正确填充区域
* [ ] 旋转区域：列间距计算正确

## Definition of Done

* 修改通过类型检查
* 在调试图片的场景中验证效果
* 不引入新的排版问题

## Out of Scope

* 重新设计检测阶段的 unclipBox/padRatio
* 修改区域扩展算法的核心逻辑

## Technical Notes

* 关键文件: `src/pipeline/typeset/fontFit.ts:687-731`, `src/pipeline/typeset/index.ts:135,199,229`
* `verticalColumnSpacingRatio = 0.1` (colSpacing = fontSize * 0.1)
* `minVerticalColSpacingScale = 0.5`
* `resolveBoxPadding` 当前返回 0
* `clonedQuadDims` 在扩展前已计算（行 100），可直接用于 `originalContentWidth`
* 调试图片: `.trellis/workspace/shinobu/debug-img/间距1.png`, `间距2.png`