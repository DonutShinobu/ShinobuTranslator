# 补充纯函数单元测试体系

## Goal

为 ShinobuTranslator 项目建立纯函数单元测试体系，覆盖核心 pipeline 模块的纯逻辑函数，提供回归防护和重构信心。

## What I already know

* 项目是 Chrome MV3 漫画翻译扩展，TypeScript + Vite + Vitest
* 现有 3 个测试文件：`src/pipeline/geometry.test.ts`、`src/pipeline/typeset/geometry.test.ts`（需确认路径）、`scripts/benchmark/metrics.test.ts`
* 大量核心模块完全无测试：typeset、detect、ocr、textlineMerge、readingOrder 等
* Vitest 4.1.5 已在 devDependencies，无独立 vitest.config.ts
* Playwright 依赖存在但仅用于 benchmark，不做 E2E

## Requirements

1. 创建 `vitest.config.ts`，配置 `tests/` 目录为测试 include 路径
2. 迁移 3 个现有 co-located 测试文件到 `tests/` 镜像目录结构
3. 为 P0 模块（typeset）编写深度纯函数单元测试
4. 为 P1 模块（detect 纯逻辑部分、ocr CTC decode + 文本后处理）编写单元测试
5. 为 P2 模块（textlineMerge 合并算法、readingOrder 排序算法）编写单元测试
6. 为 P3 模块（shared/utils）编写单元测试
7. ONNX 依赖使用 `vi.mock()` mock `onnxruntime-web` 模块
8. 测试文件组织：独立 `tests/` 目录，镜像源码结构（如 `tests/pipeline/typeset/geometry.test.ts`）
9. 共享 helper 渐进提取，先不建 `tests/helpers/`

## Acceptance Criteria

- [ ] `vitest.config.ts` 存在且配置正确，`npm test` 可执行所有测试
- [ ] 3 个旧测试迁移到 `tests/` 目录，import 路径正确，全部通过
- [ ] typeset 模块（geometry、column 布局、字体适配、颜色提取）有纯函数单元测试覆盖
- [ ] detect 模块 heuristic 纯逻辑部分有测试覆盖
- [ ] ocr 模块 CTC decode 和文本后处理有测试覆盖
- [ ] textlineMerge 合并算法有测试覆盖
- [ ] readingOrder 排序算法有测试覆盖
- [ ] shared/utils toErrorMessage 有测试覆盖
- [ ] 所有新增测试通过
- [ ] 码目录中不再存在 `.test.ts` 文件（全部迁出）

## Definition of Done

- 所有测试 `npm test` 绿色通过
- TypeScript 类型检查无错误
- Lint 无新增警告
- 不设覆盖率门槛（质量优先）

## Technical Approach

### 文件组织
- 测试文件放 `tests/<镜像路径>/<filename>.test.ts`
- `vitest.config.ts` 配置 `include: ['tests/**/*.test.ts']`
- 小数据内嵌测试文件，大 fixture 暂不需要（纯函数测试）

### Mock 策略
- 对依赖 `onnxruntime-web` 的模块，使用 `vi.mock('onnxruntime-web', ...)` 替换
- 纯函数模块（typeset/geometry、shared/utils 等）不需要 mock
- 对依赖 ONNX session 的模块（detect、ocr），mock 返回预设 tensor 结果

### 迁移清单
- `src/pipeline/geometry.test.ts` → `tests/pipeline/geometry.test.ts`
- `src/pipeline/typesetGeometry.test.ts` → 需确认实际路径后迁移到对应 `tests/` 位置
- `scripts/benchmark/metrics.test.ts` → `tests/benchmark/metrics.test.ts`

## Decision (ADR-lite)

**Context**: 项目严重缺乏测试，需要建立测试体系提供回归防护
**Decision**: 100% 纯函数单元测试，独立 `tests/` 目录，vi.mock() mock ONNX，不设覆盖率门槛，不接 CI
**Consequences**: 无法测试浏览器侧逻辑和 pipeline 串联，但纯逻辑层的回归防护已足够；ONNX mock 可能与真实行为不一致，需关注

## Out of Scope

- 集成测试（fixture + pipeline 子流程串联）
- E2E 测试（Playwright）
- CI 集成（GitHub Actions）
- 覆盖率门槛
- translators 模块测试（依赖外部 API）
- inpaint/maskRefinement 模块测试
- content/background 模块测试（依赖 Chrome API）
- runtime 模块测试（依赖 ONNX 运行时环境）
- popup React 组件测试

## Technical Notes

- Vitest 4.1.5 已配置，`"test": "vitest run"` 在 package.json
- 现有测试使用 describe/it/expect 模式
- 项目使用 TypeScript strict mode
## 纯函数清单（按模块）

### typeset/color.ts — 3 pure
`rgbToLab`, `colorDistance`, `resolveColors`

### typeset/columns.ts — 8 pure
`countTextLength`, `charLength`, `splitColumns`, `splitByTextLength`, `resolveSourceColumns`, `resolveTranslatedColumns`, `rebalanceVerticalColumns`, `resolveVerticalPreferredColumns`

### typeset/geometry.ts — 15 pure (已有 2 个旧测试覆盖 convexHull/sortMiniBoxPoints/minAreaRect)
新增覆盖: `quadAngle`, `quadDimensions`, `cloneQuad`, `cloneRegionForTypeset`, `boxToQuad`, `getRegionQuad`, `quadCenter`, `rotatePoint`, `rotateQuad`, `quadBounds`, `scaleQuadFromOrigin`, `mapOffscreenPointToCanvas`, `mapOffscreenRectToCanvasQuad`

### typeset/fontFit.ts — 11 pure
`clampNumber`, `resolveInitialFontSize`, `metricAbs`, `computeVerticalTotalWidth`, `strokeWidth`, `resolveOffscreenGuardPadding`, `resolveVerticalStartY`, `resolveAlignment`, `resolveBoxPadding`, `resolveVerticalContentHeight`, `hasMinorOverflowWrap`

### detect/onnxDetect.ts — 5 pure exported
`rectToQuad`, `inferDirection`, `intersectsOrNear`, `mergeRects`, `connectedComponents`

### heuristicDetect.ts — 0 pure exported（所有 private 纯函数不可直接测）

### ocr/decodeCtc.ts — 2 pure
`decodeCtcGreedy`, `tokenToText`

### ocr/decodeAutoregressive.ts — 2 pure exported
`tokenToTextAutoregressive`, `avgLogProbToConfidence`

### ocr/preprocess.ts — 1 pure exported
`generateTextDirection`（private 纯函数不可直接测）

### ocr/color.ts — 0 pure exported（private 不可测）

### textlineMerge/mergePredicates.ts — 4 pure exported
`buildInternalQuad`, `canMergeRegion`, `splitTextRegion`, `mergeTextRegions`

### textlineMerge/index.ts — 0 pure exported（crypto.randomUUID 不可测）

### readingOrder.ts — 0 pure exported（所有 private 纯函数不可直接测）

### shared/utils.ts — 1 pure
`toErrorMessage`

### pipeline/utils.ts — 9 pure + UnionFind class
`clamp`, `polygonSignedArea`, `polygonArea`, `rectIou`, `nmsBoxes`, `normalizeTextDeep`, `normalizeTextLight`, `convexHull`, `convexHullArea`, `UnionFind`

### 迁移清单
- `src/pipeline/geometry.test.ts` → `tests/pipeline/geometry.test.ts`
- `src/pipeline/typesetGeometry.test.ts` → `tests/pipeline/typeset/typesetGeometry.test.ts`
- `scripts/benchmark/metrics.test.ts` → `tests/benchmark/metrics.test.ts`