# Bubble 感知排版优化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正竖排排版中 `advanceScale` 基于源文本字符数导致译文字号过小/间距过大的问题，并在调试模式中可视化 bubbleBox。

**Architecture:** 修改 `estimateVerticalPreferredProfile` 的 `baselineLength` 计算，使其取源文本和译文字符数的较大值；在 `drawTypesetDebugOverlay` 中新增 bubbleBox 绿色虚线绘制。

**Tech Stack:** TypeScript, Canvas 2D API

---

### Task 1: 修正 `baselineLength` 计算

**Files:**
- Modify: `src/pipeline/typesetGeometry.ts:1130-1132`

- [ ] **Step 1: 修改 `estimateVerticalPreferredProfile` 中的 `baselineLength`**

在 `src/pipeline/typesetGeometry.ts` 第1130-1132行，将：

```typescript
  const sourceColumns = resolveSourceColumns(region);
  const sourceLengths = sourceColumns.map((column) => countTextLength(column));
  const baselineLength = Math.max(1, ...sourceLengths);
```

改为：

```typescript
  const sourceColumns = resolveSourceColumns(region);
  const sourceLengths = sourceColumns.map((column) => countTextLength(column));
  const translatedColumnTexts = preferredColumns ?? [text];
  const translatedLengths = translatedColumnTexts.map((c) => countTextLength(c));
  const baselineLength = Math.max(1, ...sourceLengths, ...translatedLengths);
```

- [ ] **Step 2: 构建验证**

Run: `npm run build`
Expected: 编译成功，无错误

- [ ] **Step 3: 提交**

```bash
git add src/pipeline/typesetGeometry.ts
git commit -m "fix(typeset): include translated text length in baselineLength calculation

advanceScale was computed using only source text char count, causing
excessive vertical spacing when translated text has more characters.
Now takes max of source and translated lengths."
```

### Task 2: 调试模式 bubbleBox 可视化

**Files:**
- Modify: `src/pipeline/typeset.ts:454` (在 `ctx.setLineDash([])` 之后插入)

- [ ] **Step 1: 在 `drawTypesetDebugOverlay` 中添加 bubbleBox 绘制**

在 `src/pipeline/typeset.ts` 的 `drawTypesetDebugOverlay` 函数中，在 expanded region 绘制（第454行 `ctx.setLineDash([])` ）之后、label 绘制（第456行 `ctx.font = ...`）之前，插入：

```typescript
  // bubble box (detected bubble boundary)
  if (sourceRegion.bubbleBox) {
    const { x, y, width, height } = sourceRegion.bubbleBox;
    ctx.strokeStyle = 'rgba(76, 175, 80, 0.9)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(x, y, width, height);
    ctx.setLineDash([]);
  }
```

- [ ] **Step 2: 构建验证**

Run: `npm run build`
Expected: 编译成功，无错误

- [ ] **Step 3: 提交**

```bash
git add src/pipeline/typeset.ts
git commit -m "feat(typeset): add bubbleBox visualization in debug overlay

Draws green dashed rectangle for bubble boundary when typesetDebug
is enabled, making it easier to diagnose bubble-related layout issues."
```

### Task 3: 构建验证

- [ ] **Step 1: 完整构建确认无回归**

Run: `npm run build`
Expected: 编译成功，无错误
