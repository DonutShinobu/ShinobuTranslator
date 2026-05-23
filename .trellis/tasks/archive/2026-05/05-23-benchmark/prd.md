# 统一 benchmark 目录结构

## Goal

将 `benchmark/`（排版质量基准）和 `scripts/benchmark/`（颜色算法诊断/对比）合并到一个 `benchmark/` 目录下，按测试域分子目录，消除命名混淆和文件散落。

## Requirements

* 按 `benchmark/typeset/` 和 `benchmark/color/` 两个顶级子目录组织，每个域自包含（fixtures/src/images 等）
* 排版相关文件移入 `benchmark/typeset/`
* 颜色相关文件移入 `benchmark/color/`
* `benchmark/reports/` 保留为统一报告输出（两个域共享）
* npm scripts 更新到新路径
* import 路径全部更新
* 单元测试引用路径更新
* 现有功能不中断
* 共享工具（chrome-cdp、visualize、render-result 等）先放 `typeset/src/`，后续颜色需要时再抽

## Target Directory Structure

```
benchmark/
  reports/                   ← 统一报告输出（不变）
  typeset/
    bench.config.json        ← 从 benchmark/ 根目录移入
    fixtures/                ← 原 benchmark/fixtures/（排版 ground truth）
    images/                  ← 原 benchmark/images/（漫画原图）
    fonts/                   ← 原 benchmark/fonts/（思源字体）
    src/                     ← 原 scripts/benchmark/ 排版脚本
      run-bench.ts
      metrics.ts
      bake-fixtures.ts
      diff-baseline.ts
      render-result.ts
      chrome-cdp.ts
      visualize.ts
      types.ts
  color/
    fixtures/                ← 原 scripts/benchmark/fixtures/color/
    src/                     ← 原 scripts/benchmark/ 颜色脚本
      color-diagnostic.ts
      color-comparison.ts
      color-utils.ts
      color-types.ts
      alg-a-fix-hasbg.ts
      alg-d-histogram-bimodal.ts
```

## Acceptance Criteria

* [ ] `scripts/benchmark/` 目录不存在
* [ ] `npm run bench` / `bench:render` / `bench:diff` / `bench:bake` 正常运行
* [ ] `npm run color:diagnostic` / `color:comparison` 正常运行
* [ ] `npx vitest run tests/benchmark/` 通过
* [ ] 无悬空 import

## Definition of Done

* 目录结构统一完成
* 所有 npm scripts 更新
* 所有 import 路径更新
* 测试通过
* git 历史清晰（用 git mv 而非删除+新建）

## Decision (ADR-lite)

**Context**: `scripts/benchmark/` 混合了排版脚本和颜色脚本，与根目录 `benchmark/` 的排版数据/配置命名混淆。
**Decision**: 按测试域分 `benchmark/typeset/` 和 `benchmark/color/` 顶级子目录，每个域自包含。共享工具先放 `typeset/src/`。
**Consequences**: 未来新增 benchmark 域（如检测精度、翻译质量）只需加一个顶级子目录。共享工具后续可能需要抽 `benchmark/shared/`，但不提前抽象。

## Out of Scope

* 新增颜色 fixture 图片
* 修改颜色算法逻辑
* 修改排版 benchmark 逻辑
* 抽取共享模块到 `benchmark/shared/`

## Technical Notes

### 需要更新 ROOT 路径的文件

* `scripts/benchmark/run-bench.ts:17` — `ROOT = resolve(import.meta.dirname, "../..")`，移到 `benchmark/typeset/src/` 后需改为 `"../../../.."`
* `bench.config.json` 中的路径（fixturesDir、imagesDir、reportsDir）需适配新位置

### 需要更新 import 路径的文件

* `tests/benchmark/color-alg-diagnostic.test.ts` — 引用 `../../scripts/benchmark/alg-a-fix-hasbg` 等需改为 `../../benchmark/color/src/alg-a-fix-hasbg`
* 排版脚本间的相互引用（run-bench → metrics, types 等）
* 颜色脚本间的相互引用（color-comparison → color-utils, color-types, alg-a, alg-d 等）

### 文件分类

**排版（→ typeset/src/）**: `run-bench.ts`, `metrics.ts`, `bake-fixtures.ts`, `diff-baseline.ts`, `render-result.ts`, `chrome-cdp.ts`, `visualize.ts`, `types.ts`
**颜色（→ color/src/）**: `color-diagnostic.ts`, `color-comparison.ts`, `color-utils.ts`, `color-types.ts`, `alg-a-fix-hasbg.ts`, `alg-d-histogram-bimodal.ts`
