# Typeset 模块边界实施计划

## 1. Characterization

- [x] 增加 `drawTypeset` 横排/竖排整体测试、独立 horizontal layout 测试和 debug schema 断言。
- [x] 保存基线：strict audit 114/114；综合分 0.9352、Column IoU 0.8426、字号误差 0.0098、列数匹配 100%。
- [x] 保持现有字体、布局常量和关键输出不变。

## 2. 统一入口

- [x] 将顶层 `pipeline/typeset.ts` 移为目录内 `drawTypeset.ts`，顶层同名文件已删除。
- [x] 生产导入统一通过目录 `index.ts` 获取 `drawTypeset`。
- [x] 入口移动保持算法不变，并由 characterization test 覆盖。

## 3. 对称布局/渲染

- [x] 将现有 vertical compute 从旧 index 迁到 `verticalLayout.ts`。
- [x] 从 `drawTypeset` 提取 `horizontalLayout.ts` 及显式 `FullHorizontalTypesetResult`。
- [x] 拆分 horizontal/vertical Canvas render、composite 和 debug mapping。
- [x] 横竖 Layout Result 均承载渲染/debug 所需几何，debug 复用真实结果。

## 4. 字体与 fit 收口

- [x] 移除模块级可变 `fontFamily`，改为每次调用解析并显式传递。
- [x] 按 font metrics/horizontal/vertical/source geometry 建立职责模块，原实现收口到内部 `fontFitCore.ts`。
- [x] `fontFit.ts` 仅做显式兼容 re-export，不承载实现逻辑。
- [x] `index.ts` 仅显式导出 `drawTypeset`、`DrawTypesetOptions` 和 `DrawTypesetResult`。

## 5. 验证

- [x] Typeset/geometry/columns/orientation 共 228 项相关测试通过。
- [x] `bench:audit-fixtures -- --strict`：114/114 可用、0 rejected。
- [x] 真实浏览器 `bench:render` 14 张 fixture 全部完成，`bench` 指标与基线逐项一致。
- [x] 完整 `npm run check`：三套 typecheck、36 个测试文件/523 项测试、Release build 全通过。
- [x] 结构断言与 `git diff --check` 通过，用户的 `benchmark/images/` 未纳入变更。

## 6. 回滚点

- [x] 入口、layout、render/debug、fontFit facade 保持为清晰的文件级变更组；未在用户确认前自动提交。
- [x] 所有验证以原基线为准，没有修改算法常量掩盖结构回归。
