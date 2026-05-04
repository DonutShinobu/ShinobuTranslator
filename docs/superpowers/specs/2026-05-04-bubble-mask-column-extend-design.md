# Bubble Mask 逐列扩展排版设计

## 问题

当前竖排排版中，译文比原文长时的处理有两个问题：

1. **bubbleBox 在 merge 阶段丢失** — bubble 匹配在 OCR 之前执行，`mergeTextLines` 创建新对象时未携带 `bubbleBox`，导致排版阶段永远收不到 bubble 数据。

2. **bubbleBox 替换 box 导致对齐偏移** — 现有代码 `cloned.box = bubbleBox` 把整个排版区域替换为 bubble bounding box，改变了位置和宽度，破坏了与原文的上端对齐。

3. **方形 box 无法处理圆角 bubble** — bubble 大多带圆角，用 bounding rect 计算会导致文字超出 bubble 实际边界。

## 设计

### 1. 数据层变更

`TextRegion` 新增字段：

```typescript
bubbleMask?: ImageData;  // bubble 的实例分割 mask（全图尺寸）
```

`matchRegionsToBubbles` 匹配时同时存储 `bubbleBox` 和 `bubbleMask`。

### 2. Pipeline 顺序调整

**orchestrator.ts：**
- 将 `bubbleResult.bubbles` 提升到 try 块外
- 将 `matchRegionsToBubbles` 调用移到 `mergeTextLines` 之后
- bubble 检测（模型推理）时机不变，仍在 OCR 之前并行

**bake.ts：**
- 在 merge 之后增加 bubble 检测和匹配调用

### 3. Mask 查询函数

新增函数，用于排版时查询每列的实际可用垂直空间：

```typescript
function queryMaskMaxY(
  mask: ImageData,
  xStart: number,
  xEnd: number,
  yStart: number,
): number
```

从 `yStart` 逐行向下扫描，检查 `[xStart, xEnd]` 范围内所有像素的 alpha 是否 > 0。当整行全部不在 mask 内时，返回上一行的 y 坐标。如果扫描到 mask 底部都在内，返回 `mask.height - 1`。

### 4. 排版逻辑变更

**在 `computeFullVerticalTypeset` 中：**

移除 `cloned.box = bubbleBox` 的替换逻辑。改为以下流程：

1. 用原始 `box` 计算 `contentHeight`，用原始字号排版
2. 如果列数 ≤ 目标列数 → 完成，无需任何调整
3. 如果溢出，且有 `bubbleMask`：
   a. 对每一列，根据该列的实际 x 范围（含 padding 和列间距）和 box 顶部 y，调用 `queryMaskMaxY` 获取该列可用的最大 y
   b. 每列的可扩展高度 = `maxY - (box.y + boxPadding)`
   c. 取所有列中最小的可扩展高度作为 `extendedContentHeight`
   d. 用 `extendedContentHeight` + 原始字号重新排版
4. 如果扩展后还溢出 → 在 `extendedContentHeight` 范围内二分缩小字号
5. 没有 `bubbleMask` 时退回现有逻辑（不做 box 替换，保持原有行为）

**在 `expandRegionBeforeRender` 中：**

移除 `expanded.box = bubbleBox` 的替换逻辑。

### 5. 对齐保持

- box 的 x、y、width 始终不变
- 扩展只影响 contentHeight（向下延伸）
- 上端对齐始终保持
- offscreenHeight 使用实际排版所用的 contentHeight

## 修改文件

- `src/types.ts` — 新增 `bubbleMask` 字段
- `src/pipeline/bubbleDetect.ts` — 匹配时存储 mask 引用
- `src/pipeline/orchestrator.ts` — 调整 bubble 匹配执行顺序
- `src/pipeline/bake.ts` — 增加 bubble 检测
- `src/pipeline/typesetGeometry.ts` — 新增 `queryMaskMaxY`，修改 `computeFullVerticalTypeset` 和 `expandRegionBeforeRender`
