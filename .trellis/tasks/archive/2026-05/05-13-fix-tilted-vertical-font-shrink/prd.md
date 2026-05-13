# 修复倾斜竖排文本字号异常缩小

## Goal

修复 `compositeRegion` 中旋转 quad 的缩放计算错误，使倾斜竖排文本的字号不再因 strokePadding 被算入缩小比例而异常缩小。

## What I already know

* **根因已确认**：`compositeRegion`（typeset.ts:649-651）对旋转 quad 使用 `s = Math.min(qw / offCanvas.width, qh / offCanvas.height)`，其中 `offCanvas.width = contentWidth + 2*strokePadding`，而 `qw` 仅代表内容宽度。这使得 `s < 1`（永远缩小），且对窄竖排列缩放比例可达 0.5（50%缩小）
* **轴对齐文本不受影响**：非旋转路径走 `drawImage(offCanvas, drawX, drawY)` 无缩放，stroke 自然溢出 box
* **次要问题**：`expandRegionBeforeRender`（fontFit.ts:832-833）用 AABB `box.width/height` 代替 quad 真实尺寸计算 contentWidth/contentHeight，对倾斜 quad 可能导致展开判断不准确

## Requirements

* 旋转 quad 的 compositing 缩放因子应使内容区域 1:1 映射到 quad 尺寸（而非整个 offscreen canvas 映射到 quad）
* strokePadding 应自然溢出 quad 边界（与轴对齐路径行为一致）
* `expandRegionBeforeRender` 应使用 quad 真实尺寸而非 AABB 计算 contentWidth/contentHeight

## Acceptance Criteria

* [ ] 倾斜竖排窄列文本的字号不再异常缩小（视觉验证）
* [ ] 轴对齐竖排文本渲染效果不变
* [ ] 倾斜横排文本渲染效果不变
* [ ] TypeScript 编译通过
* [ ] 构建产物可正常替换部署

## Definition of Done

* 根因修复代码已提交
* `expandRegionBeforeRender` AABB 问题已修复
* 构建产物已部署到 C:\code\manga-translate\dist

## Technical Approach

### 主修复：compositeRegion 缩放计算

**Approach A（推荐）**：将缩放基准从整个 offscreen canvas 改为内容区域

```typescript
// Before (buggy):
const sx = qw / offCanvas.width;
const sy = qh / offCanvas.height;

// After (fixed):
const contentW = offCanvas.width - boxPadding * 2 - strokePadding * 2;
const contentH = offCanvas.height - boxPadding * 2 - strokePadding * 2;
const sx = qw / contentW;  // ≈ 1.0 (since contentW = qw for boxPadding=0)
const sy = qh / contentH;  // ≈ 1.0
const s = Math.min(sx, sy);
```

效果：内容区域 1:1 映射到 quad，strokePadding 自然溢出，与轴对齐路径行为一致。

### 次修复：expandRegionBeforeRender 使用 quad 尺寸

```typescript
// Before (uses AABB):
const contentWidth = Math.max(20, expanded.box.width - boxPadding * 2);
const contentHeight = Math.max(20, expanded.box.height - boxPadding * 2);

// After (uses quad real dimensions):
const expandedQuadDims = quadDimensions(getRegionQuad(expanded));
const contentWidth = Math.max(20, expandedQuadDims.width - boxPadding * 2);
const contentHeight = Math.max(20, expandedQuadDims.height - boxPadding * 2);
```

## Out of Scope

* 字号计算算法的其他优化
* 检测精度改进
* 水平路径字号相关修改

## Technical Notes

* 关键文件：src/pipeline/typeset.ts:612-663（compositeRegion）、src/pipeline/typeset/fontFit.ts:818-924（expandRegionBeforeRender）
* quadDimensions 函数在 geometry.ts:146-154
* resolveBoxPadding 返回 0（fontFit.ts:737-739）
* strokePadding 约为 fontSize * 0.35 + fontSize * 0.12 + strokeWidth + 2，对 fontSize=20 约为 15px