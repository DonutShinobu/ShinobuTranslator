# Bubble 感知排版优化设计

## 问题

当前竖排排版中，`estimateVerticalPreferredProfile` 的 `baselineLength` 只基于源文本字符数。当译文字数多于源文本时，`advanceScale`（字符间纵向间距缩放）被过度拉大，导致：

1. 用初始字号排版时，每个字符占用的纵向空间过大（间距按源文本少量字数分配）
2. 译文溢出到多列
3. 二分搜索将字号极度压缩以强制保持源文本的列数
4. 最终结果：字号极小、字间距过大

以 #6「急に何!?」→「突然说什么!?」为例：init:67px, fit:28px。`baselineLength=5`（源文本字数）使得 `targetAdvance = contentHeight / 5` 过大，6个译文字符在大间距下无法塞进一列，二分搜索把字号从67px压到28px。

## 设计思路

核心修复：**`baselineLength` 应取源文本和译文字符数的较大值**。这样译文字多时，间距不会被过度拉大，同样字号下一列能放更多字，减少不必要的溢出和字号压缩。

`singleColumnMaxLength`（第1510行的初始字号约束）**不需要修改**——从实际 case 推演，该约束在 bubble 较大时不生效（`maxFontByHeight >= initialFontSize`），且跳过它反而可能让初始字号更大、溢出更严重。

## 修改点

### 1. `estimateVerticalPreferredProfile` — 修正 baselineLength

**文件**：`src/pipeline/typesetGeometry.ts`，约第1132行

**现状**：`baselineLength` 只用源文本字符数，导致字少时间距被拉大。

**改为**：同时考虑译文字符数，用较大值。这样即使源文本只有3个字，如果译文有6个字，间距也不会被过度拉开。

```typescript
const translatedColumnTexts = preferredColumns ?? [text];
const translatedLengths = translatedColumnTexts.map(c => countTextLength(c));
const baselineLength = Math.max(1, ...sourceLengths, ...translatedLengths);
```

### 2. 调试模式 bubbleBox 可视化

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

- 字间距基于实际需排列的字符数（含译文），不再因源文本字少而被拉大
- 同样字号下一列能容纳更多译文字符，减少不必要的列溢出
- 二分搜索触发频率降低，字号压缩幅度减小
- 调试模式下可看到 bubble 边界（绿色虚线），便于诊断排版问题
