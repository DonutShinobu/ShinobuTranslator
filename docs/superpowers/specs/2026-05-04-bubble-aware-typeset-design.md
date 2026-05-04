# Bubble 感知排版优化设计

## 问题

当前竖排排版的字号决策只考虑"源文本每列有几个字"，不考虑 bubble 的实际空间。虽然 `computeFullVerticalTypeset` 已经将 `region.box` 替换为 `bubbleBox`（第1492行），但后续两层约束仍基于源文本字符数：

1. **初始字号约束**（第1510-1517行）：`maxFontByHeight = availableHeight / singleColumnMaxLength`，其中 `singleColumnMaxLength` 是源文本最长列的字符数。这让初始字号被源文本字数固定住——bubble 再大也不会给出更大的字号。
2. **列数约束 + 二分搜索**（第1578-1607行）：`targetColumnCount` 基于源文本列数。译文字多排出更多列时，二分搜索会疯狂压缩字号来强制塞回源文本的列数。
3. **间距约束**（`estimateVerticalPreferredProfile` 第1134行）：`baselineLength` 基于源文本字符数，当源文本字少时 `targetAdvance` 过大，字间距被拉开。

结果：字号极小、字间距过大，即使 bubble 空间完全足够放下更大的字。

## 设计思路

核心原则：**当有 bubbleBox 时，每列能放多少字应该由 bubble 高度和字号决定，而非由源文本字符数预设**。

当前 `singleColumnMaxLength` 的作用是估算初始字号上限，但 `resolveInitialFontSize` 已经基于 box 尺寸（替换后即 bubble 尺寸）给出了合理的初始值。`singleColumnMaxLength` 约束是多余的——它用源文本字数来二次限制字号，反而阻止了字号利用 bubble 的额外空间。

## 修改点

### 1. `computeFullVerticalTypeset` — 跳过基于源文本字符数的字号压制

**文件**：`src/pipeline/typesetGeometry.ts`，约第1510行

**现状**：无论是否有 bubbleBox，都用 `singleColumnMaxLength`（源文本字符数）压低初始字号。

**改为**：当 region 有 bubbleBox 时，跳过 `singleColumnMaxLength` 对初始字号的约束。`resolveInitialFontSize` 已经基于 bubble 大小的 box 给出合理值，排版引擎会根据字号和 bubble 高度自然决定每列放多少字。

```typescript
if (singleColumnMaxLength && singleColumnMaxLength > 0 && !cloned.bubbleBox) {
  // 仅在没有 bubble 时才用源文本字符数限制字号
  const boxPaddingEst = resolveBoxPadding(cloned);
  const availableHeight = Math.max(20, cloned.box.height - boxPaddingEst * 2);
  const maxFontByHeight = Math.round(availableHeight / singleColumnMaxLength);
  if (maxFontByHeight > 0 && maxFontByHeight < estimatedInitialFontSize) {
    estimatedInitialFontSize = Math.max(8, maxFontByHeight);
  }
}
```

### 2. `computeFullVerticalTypeset` — 放宽列数约束

**文件**：`src/pipeline/typesetGeometry.ts`，约第1578行

**现状**：当排版列数 > `targetColumnCount`（源文本列数）时，二分搜索缩小字号。

**改为**：当有 bubbleBox 时，放宽 `targetColumnCount`。如果排版引擎用合理字号排出的列数能在 bubble 宽度内放下，就接受多出的列数，而不是缩小字号。

```typescript
let effectiveTargetColumnCount = targetColumnCount;
if (inputRegion.bubbleBox && layout.columns.length > targetColumnCount) {
  const totalNeeded = computeVerticalTotalWidth(layout.columns.length, layout.metrics);
  if (totalNeeded <= contentWidth) {
    effectiveTargetColumnCount = layout.columns.length;
  }
}

if (layout.columns.length > effectiveTargetColumnCount && fontSize > minFontSafetySize) {
  // ... 二分搜索逻辑不变，但用 effectiveTargetColumnCount
}
```

### 3. `estimateVerticalPreferredProfile` — 基于 bubble 高度计算间距

**文件**：`src/pipeline/typesetGeometry.ts`，约第1132行

**现状**：`baselineLength` 只用源文本字符数，导致字少时间距被拉大。

**改为**：同时考虑译文字符数，用较大值。这样即使源文本只有3个字，如果译文有6个字，间距也不会被过度拉开。

```typescript
const translatedColumnTexts = preferredColumns ?? [text];
const translatedLengths = translatedColumnTexts.map(c => countTextLength(c));
const baselineLength = Math.max(1, ...sourceLengths, ...translatedLengths);
```

### 4. 调试模式 bubbleBox 可视化

**文件**：`src/pipeline/typeset.ts`，`drawTypesetDebugOverlay` 函数

在绘制 source region（蓝色）和 expanded region（青色虚线）之后，新增 bubbleBox 绘制（绿色虚线）：

```typescript
if (sourceRegion.bubbleBox) {
  const { x, y, width, height } = sourceRegion.bubbleBox;
  ctx.strokeStyle = 'rgba(76, 175, 80, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 3]);
  ctx.strokeRect(x, y, width, height);
  ctx.setLineDash([]);
}
```

## 预期效果

- 有 bubble 时，初始字号由 bubble 大小决定，不被源文本字符数压低
- 译文字多时，允许利用 bubble 宽度自然增加列数，而非压缩字号
- 字间距基于实际需排列的字符数（含译文），不再因源文本字少而被拉大
- 调试模式下可看到 bubble 边界（绿色虚线），便于诊断排版问题
