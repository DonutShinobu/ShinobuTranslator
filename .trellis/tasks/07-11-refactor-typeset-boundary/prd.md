# 重构 Typeset 模块边界

## Goal

在排版输出完全兼容的前提下，消除 `pipeline/typeset.ts` 与 `pipeline/typeset/` 同名边界，建立清晰的公共入口和对称的横竖排布局/渲染结构。

## Requirements

- 外部模块统一从 `src/pipeline/typeset/index.ts` 使用显式公共 API。
- 将 `drawTypeset` 移入 typeset 目录；不保留文件/目录同名入口。
- 横排和竖排均将布局计算与 Canvas 渲染分离。
- `fontFamily` 通过参数/上下文显式传递，不使用模块级可变状态。
- `fontFit.ts` 按共同测量、横排、竖排、源几何/边界职责拆分，必要时保留兼容 facade。
- `index.ts` 不再 `export *` 全部内部实现，只导出生产调用方需要的 API 和稳定类型。
- 不改变字号、字距、行距、列数、禁则、方向或颜色算法。

## Acceptance Criteria

- [x] 不再存在顶层 `src/pipeline/typeset.ts` 与目录同名冲突。
- [x] `drawTypeset` 对既有 fixtures 的输出、debug schema 和关键几何指标保持兼容。
- [x] 横排和竖排均有独立可测试的 layout result。
- [x] 不存在模块级可变字体状态。
- [x] 公共导出列表为显式、受控集合。
- [x] typeset 单测、fixture audit、render、benchmark、完整 test/build 通过。

## Dependencies

- 必须先完成 `07-11-engineering-quality-gates`。

## Out of Scope

- 调整排版视觉参数或修复新的排版质量问题。
- 改变 `TextRegion`、typeset debug schema 或 fixture 真值顺序。

## Notes

- 所有移动先由 characterization tests 锁定行为；算法优化必须另建任务。
