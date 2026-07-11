# Typeset 模块边界设计

## 1. 公共入口

唯一生产入口为 `src/pipeline/typeset/index.ts`，显式导出：

- `drawTypeset`
- `DrawTypesetOptions` / `DrawTypesetResult`（最终名称以现有契约为准）
- 其他确有生产调用方的稳定类型

测试可直接导入内部模块，但目录入口不再 `export *`。

## 2. 内部结构

```text
typeset/
├─ index.ts
├─ drawTypeset.ts
├─ horizontalLayout.ts
├─ verticalLayout.ts
├─ renderHorizontal.ts
├─ renderVertical.ts
├─ composite.ts
├─ debug.ts
├─ fontMetrics.ts
├─ sourceGeometry.ts
├─ columns.ts
├─ geometry.ts
├─ color.ts
└─ verticalOrientation.ts
```

实现可分阶段到达该形态；如果一次拆分 `fontFit.ts` 风险过高，可先保留 facade，但 facade 只做显式 re-export，不继续承载新增逻辑。

## 3. 数据流

`TextRegion + translated text + measure context + font family` -> horizontal/vertical layout result -> render result -> composite -> optional debug mapping。

Layout result 必须包含渲染和 debug 所需的全部几何，避免 debug 重新计算并与真实渲染漂移。

## 4. 行为兼容

- 保持源列/译文列、break reason、segment source、vertical item 和 debug schema。
- 保持 source geometry 不可靠时的降级规则。
- 字体族在 `drawTypeset` 每次调用中解析并显式传下去。
- 不在目录重构中调整任何视觉常量。

## 5. 迁移策略

先测试、后纯移动、再提取横排、再拆 fontFit、最后收敛导出。每一步都能运行 Typeset 单测和 fixture benchmark，避免同时移动文件并改变算法。

## 6. 回滚

保留阶段性 facade 和小提交；指标或像素输出回归时回滚最近一次提取，而不是修改参数“调回去”。
