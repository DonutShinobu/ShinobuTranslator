# 架构边界重构总设计

## 1. 设计目标

父任务通过多个可独立验收的子任务完成渐进式重构。任何子任务都不得以“最终会在另一个子任务修好”为理由提交破损的中间状态。

## 2. 目标边界

```text
Host page
  -> Content entry（不含 benchmark 公共桥）
      -> TranslatorCore（页面生命周期）
          -> Translation runner / state / controllers / DOM UI
          -> Pipeline public APIs

Background entry
  -> typed message router
      -> settings / diagnostics / oauth / image / provider services

Pipeline
  -> detect / OCR / translate / mask / inpaint / typeset
      -> runtime inference bridge

Benchmark build
  -> benchmark-only extension page
      -> pipeline bake/render APIs
```

## 3. 依赖图

```text
isolate-benchmark-bridge ─────────────┐
                                     ├─> isolate-legacy-ocr-runtime
engineering-quality-gates ─┬─────────┘
                           ├─> refactor-typeset-boundary
                           ├─> refactor-background-services
                           └─> refactor-content-core-ui

all implementation children ─> sync-architecture-specs ─> parent integration review
```

树结构表示所有权，不表示执行顺序；上图依赖必须写入子任务文档并在启动子任务前检查。

## 4. 跨任务稳定契约

- Chrome runtime message 的 `mt:*` discriminant 和请求/响应形状保持兼容。
- `ExtensionSettings` storage key、默认值和 normalize 语义保持兼容。
- `TextRegion`、`PipelineConfig`、`PipelineArtifacts`、`PipelineProgress` 保持兼容。
- `public/models/models.json` 保持当前模型事实源。
- Release 仍为 Manifest V3；Content Script 继续使用原生 DOM。
- 本地流水线继续按用户点击懒加载，不引入页面加载时模型预热。
- Browser 与 Node benchmark 必须使用同一生产算法实现；只隔离入口和遗留 RPC，不复制算法。

## 5. 集成策略

- 所有子任务使用同一分支 `codex/architecture-boundary-refactor`，但每个子任务形成独立、可回滚的提交组。
- 先建立质量门禁，再移动高风险模块；benchmark bridge 因生产边界风险可独立优先修复。
- Background 与 Content 通过稳定消息契约解耦，不在两个子任务中同时重写协议。
- Typeset 重构以移动和显式依赖传递为主，不修改字号、字距、换列或颜色算法。
- Legacy OCR 子任务按已确认决策删除生产 AR runtime/RPC 和废弃 benchmark；仍需先用调用关系确定哪些共享 helper 属于 Paddle 当前路径，禁止基于文件名误删。

## 6. 验证与回滚

- 每个子任务必须有自己的测试、构建和任务范围 `git diff` 检查。
- 每个子任务完成后记录提交点；后续集成失败时优先 revert 单个子任务提交，不回滚已验证的其他边界。
- 父任务最终运行完整 typecheck、test、build、浏览器 smoke 和关键 benchmark。
- `benchmark/images/` 永远保持任务外，不得被任何子任务暂存。

## 7. 延后项

- Popup 组件化、Worker 纯内部文件整理、Vite 插件全面替换分别在本任务完成后重新评估。
- 若某延后项成为当前子任务的必要前置，必须先更新父 PRD/design 并重新请求范围确认。
- 不建立独立 legacy Worker；历史报告保留，转换脚本集中到 `scripts/legacy/`。
