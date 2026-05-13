# 调试橙色框遇倾斜竖排文字偏小

## Goal

修复调试模式下橙色列框（column bounding box）在倾斜竖排文字上明显偏小的 bug，使调试框尺寸与实际渲染文字精确对齐。通过架构改进防止同类偏差复发。

## Root Cause

`mapOffscreenPointToCanvas`（geometry.ts:300-302）计算缩放系数时使用了完整 offscreen 尺寸（含 strokePadding），而 `compositeRegion`（typeset.ts:652-656）使用 content 尺寸（扣除 padding）。两者公式不一致，导致倾斜竖排文字的调试框比实际渲染文字偏小。

具体对比：
- **Compositing**: `s = min(qw / (offCanvas.width - 2*boxPadding - 2*strokePadding), qh / ...)`
- **Debug mapping**: `s = min(qw / offscreenWidth, qh / offscreenHeight)` ← 用了含 padding 的全尺寸

## Decision (ADR-lite)

**Context**: compositing 和 debug mapping 各自独立计算缩放系数，公式一旦分叉就产生视觉偏差。
**Decision**: 方案 2 — 让 `compositeRegion` 返回计算出的 transform 参数（`{s, cx, cy, angle}`），debug overlay 直接复用这些参数，不再独立重算缩放系数。
**Consequences**: 消除公式分叉风险；需要改 `compositeRegion` 返回类型从 `void` 到结构体，调用链需适配。

## Requirements

* `compositeRegion` 返回 transform 参数（scale, center, angle）而非 void
* debug overlay 使用 compositing 返回的 transform 参数绘制列框，不再独立计算缩放系数
* 倾斜竖排文字的调试橙色框与实际渲染文字区域精确对齐

## Acceptance Criteria

* [ ] 倾斜竖排文字的调试橙色框与实际渲染文字区域精确对齐
* [ ] 非倾斜文字的调试框不受影响
* [ ] 非竖排（横向）文字的调试框不受影响
* [ ] compositeRegion 和 debug overlay 使用同一个 scale 值（无独立重算）

## Definition of Done

* compositeRegion 返回类型改为结构体
* drawTypesetDebugOverlay / mapOffscreenPointToCanvas 使用 compositing 返回的 transform
* mapOffscreenPointToCanvas 删除独立缩放计算
* Lint / typecheck 通过

## Technical Approach

1. 定义 `CompositeTransform` 类型 `{ s: number, cx: number, cy: number, angle: number }`
2. `compositeRegion` 返回 `CompositeTransform`（而非 void）
3. 主循环中保存 compositing 返回的 transform
4. `drawTypesetDebugOverlay` 接收 transform 参数
5. `mapOffscreenPointToCanvas` 接收 `CompositeTransform` 替代自己计算 scale/center/angle
6. 旧代码中 `mapOffscreenPointToCanvas` 的独立缩放计算删除

对于非旋转路径（`!isRotated`），compositing 直接 `drawImage` 不做 transform，返回的 transform 中 `s=1, angle=0`，或单独返回一个标记让 debug 用原始像素映射。

## Out of Scope

* 不涉及 visualize.ts 中早期阶段的可视化
* 不涉及非旋转路径的像素映射逻辑（已有正确行为，保持不变）

## Technical Notes

* 关键文件：
  - `src/pipeline/typeset/geometry.ts` 第 276-354 行（mapOffscreenPointToCanvas, mapOffscreenRectToCanvasQuad）
  - `src/pipeline/typeset.ts` 第 618-668 行（compositeRegion）
  - `src/pipeline/typeset.ts` 第 432-514 行（drawTypesetDebugOverlay）
  - `src/pipeline/typeset.ts` 第 834-878 行（主循环调用点）
* boxPadding 当前恒为 0，但应保留完整公式以兼容未来变更