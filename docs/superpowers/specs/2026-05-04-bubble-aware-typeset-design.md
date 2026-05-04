# Bubble 感知排版优化设计

## 问题

当前竖排排版中，`singleColumnMaxLength` 和 `baselineLength` 只基于源文本字符数计算。当译文字数多于源文本时：

1. 初始字号按源文本短字数算，偏大
2. 用这个偏大字号排版译文，溢出到多列
3. 二分搜索将字号极度压缩以强制保持源文本的列数
4. `advanceScale` 也基于源文本字数拉大字间距

结果：字号极小、字间距过大，即使 bubble 空间完全足够放下更大的字。

## 修改点

### 1. `computeFullVerticalTypeset` — singleColumnMaxLength

**文件**：`src/pipeline/typesetGeometry.ts`，约第1505行

**现状**：
```typescript
const singleColumnMaxLength = verticalPreferred?.singleColumnMaxLength
  ?? (sourceColumnLengths.length > 0 ? Math.max(...sourceColumnLengths) : null);
```

**改为**：同时考虑译文每列的字符数，取源文本和译文的较大值。

```typescript
const translatedColumnTexts = preferredColumns ?? [text];
const translatedColumnLengths = translatedColumnTexts.map(c => countTextLength(c));
const maxTranslatedColumnLength = Math.max(0, ...translatedColumnLengths);
const baseSingleColumnMaxLength = verticalPreferred?.singleColumnMaxLength
  ?? (sourceColumnLengths.length > 0 ? Math.max(...sourceColumnLengths) : null);
const singleColumnMaxLength = Math.max(baseSingleColumnMaxLength ?? 0, maxTranslatedColumnLength) || null;
```

### 2. `estimateVerticalPreferredProfile` — baselineLength

**文件**：`src/pipeline/typesetGeometry.ts`，约第1132行

**现状**：
```typescript
const baselineLength = Math.max(1, ...sourceLengths);
```

**改为**：同时考虑译文字符数。

```typescript
const translatedColumnTexts = preferredColumns ?? [text];
const translatedLengths = translatedColumnTexts.map(c => countTextLength(c));
const baselineLength = Math.max(1, ...sourceLengths, ...translatedLengths);
```

### 3. 调试模式 bubbleBox 可视化

**文件**：`src/pipeline/typeset.ts`，`drawTypesetDebugOverlay` 函数

在绘制 source region（蓝色）和 expanded region（青色虚线）之后，新增 bubbleBox 绘制：

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

- 初始字号按"需要放下的最多字符数"计算，不再被源文本短字数抬高
- 不需要二分搜索疯狂压缩字号
- 字间距（advanceScale）也基于实际字符数，不再被过度拉大
- 调试模式下可以看到 bubble 边界（绿色虚线）
