# 重构架构边界与工程护栏

## Goal

在不改变用户可见翻译、截图、阅读模式、调试和排版行为的前提下，收紧生产构建边界，补齐重构护栏，并逐步降低 Background、Content、排版与 ONNX/OCR 模块的耦合和维护风险。

## User Value

- 防止任意网页探测或调用仅供 benchmark 使用的扩展内部能力。
- 降低后续修改翻译流水线、排版、OAuth、截图和模型运行时的回归风险。
- 保持当前本地优先、懒加载和浏览器/Node 共用算法的产品能力。

## Confirmed Facts

- 当前分支为 `codex/architecture-boundary-refactor`。
- 当前工作区仅有未跟踪的 `benchmark/images/`，不属于本任务范围，不得纳入提交。
- `src/` 的静态 import 图没有文件级循环依赖，目录级分层总体成立。
- Release Content Script 当前包含 `window.postMessage` benchmark bridge，并注入 `<all_urls>`。
- `tsconfig.json` 只覆盖 `src/`；测试和 benchmark TypeScript 没有统一纳入 `tsc` 类型检查。
- 关键入口和热点文件已明显超出项目规范建议的约 500 行拆分阈值，包括 `background/index.ts`、`TranslatorCore.ts`、`content/core/ui.ts`、`pipeline/typeset.ts` 和 `pipeline/typeset/fontFit.ts`。
- 当前发布 OCR 主路径为 PP-OCRv6 medium，但旧自回归 OCR RPC 仍进入浏览器 Worker 和 Node Bridge。
- 仓库中没有仍可执行的旧 AR/48px benchmark：`bench:ocr-gpu-argmax` 直接报废弃错误，浏览器 compare 明确拒绝 legacy 模式；剩余引用为 Bridge/Worker 实现、兼容 alias、转换脚本、单元工具和历史报告。
- 用户已决定删除旧 AR runtime、Worker/Node Bridge RPC 和废弃 benchmark 入口；保留历史报告与旧设置兼容 alias，并把仍有参考价值的模型转换脚本迁入 `scripts/legacy/`。
- 当前缺少对 Background 消息路由、`runPipeline` 编排、`TranslatorCore` 生命周期、整体 `drawTypeset` 和 Worker RPC 的直接行为测试。
- `AGENTS.md` 和 `.trellis/spec/frontend/directory-structure.md` 存在与当前实现不一致的说明。

## Requirements

- 生产 Release 构建不得向宿主网页暴露 benchmark bake/render bridge 或 ready 探测信号。
- benchmark 烘焙与渲染能力必须保留，但迁移到仅供测试使用的受控入口或独立构建。
- 建立覆盖应用源码、测试和 benchmark 的 TypeScript 检查入口，并将测试、类型检查和构建纳入可重复质量门禁。
- 在拆分核心模块前补充行为保持型测试，锁定消息路由、流水线阶段、Content 状态流、排版输出和 Worker 契约。
- 排版模块消除 `pipeline/typeset.ts` 与 `pipeline/typeset/` 同名边界，横排和竖排采用对称的布局/渲染职责划分，并缩小内部实现的公共导出面。
- Background 入口只保留 Chrome listener 注册和高层路由；设置、日志、OAuth、图片服务、Gemini/LLM 代理与菜单注册按领域拆分。
- `TranslatorCore` 只保留页面生命周期和适配器协调；翻译运行、状态存储、阅读模式、截图和 UI 组件按职责拆分，Content Script 继续使用原生 DOM。
- 删除旧自回归 OCR runtime、Worker/Node Bridge RPC 和废弃 benchmark 入口；保留历史报告、兼容 alias，并将仍有参考价值的转换脚本迁入 `scripts/legacy/`，同时记录 bundle 变化。
- 重构不得改变当前用户设置键、Chrome 消息 discriminant、模型清单格式、`TextRegion`/`PipelineArtifacts` 等跨层契约，除非设计文档明确提供兼容迁移。
- 更新受本次变更影响的 AGENTS/Trellis 规范，使其与最终目录、模型清单和构建方式一致。

## Child Task Map

父任务只维护需求源、跨任务约束、依赖关系和最终集成验收，不直接承载产品代码实现。

| Child | Deliverable | Dependencies |
|---|---|---|
| `07-11-isolate-benchmark-bridge` | 从 Release Content Script 移除 benchmark bridge，提供受控浏览器 benchmark 入口 | 无，可优先实施 |
| `07-11-engineering-quality-gates` | 覆盖 app/tests/benchmark 的类型检查、CI/Release 门禁和共享行为护栏 | 无；其完成是后续结构重构的前置条件 |
| `07-11-refactor-typeset-boundary` | 统一 Typeset 公共入口，拆分横竖排布局/渲染/调试，收敛导出 | 依赖 `engineering-quality-gates` |
| `07-11-refactor-background-services` | 将 Background 消息、设置、日志、OAuth、图片和菜单按领域拆分 | 依赖 `engineering-quality-gates` |
| `07-11-refactor-content-core-ui` | 拆分 TranslatorCore、状态、翻译运行、阅读/截图控制器和原生 DOM UI | 依赖 `engineering-quality-gates`；保持消息契约后可与 Background 子任务独立实施 |
| `07-11-isolate-legacy-ocr-runtime` | 删除旧 AR OCR runtime/RPC 与废弃 benchmark，迁移转换脚本并验证 Paddle/Node/bundle | 依赖 `isolate-benchmark-bridge` 与 `engineering-quality-gates` |
| `07-11-sync-architecture-specs` | 更新 AGENTS/Trellis 架构、模型和构建规范 | 依赖所有实现型子任务完成 |

## Acceptance Criteria

- [x] Release `content.js` 不包含 `__shinobu_bake*` / `__shinobu_render*` benchmark 消息桥，benchmark 仍可通过受控入口完成 bake/render。
- [x] 应用源码、测试和 benchmark TypeScript 均有明确的类型检查命令且通过。
- [x] `npm run test` 与 `npm run build` 通过，并有 CI/Release 质量门禁执行这些检查。
- [x] Background、Content 和 Typeset 的公共入口保持稳定，用户可见行为无回归。
- [x] 新增关键行为测试覆盖消息路由、流水线阶段错误/产物、Content 状态切换、排版整体验证和 Worker RPC 边界。
- [x] `drawTypeset` 不再依赖模块级可变字体状态；排版内部公共导出面收敛。
- [x] 旧自回归 OCR runtime/RPC 与废弃 benchmark 入口已删除，历史报告和兼容 alias 保留，转换脚本已迁入 `scripts/legacy/`，并有构建体积对比和回滚说明。
- [x] `benchmark/images/` 及其他任务外文件不进入任何任务提交。
- [x] `AGENTS.md` 和相关 Trellis 目录规范与最终实现一致。

## Constraints

- 采用渐进、行为保持型重构；禁止一次性重写整个架构。
- 保持 Manifest V3、Content Script 原生 DOM、流水线按点击懒加载和 ONNX provider fallback。
- 每个阶段应能独立验证和回滚，避免把所有目录迁移压成一个不可审查的大提交。

## Out of Scope

- 新增翻译器、模型或站点支持。
- 改变翻译 Prompt、OCR/排版算法参数或用户交互设计。
- 将 Content Script 改写为 React。
- 纳入或整理未跟踪的 `benchmark/images/`。
- 单纯为缩短行数而拆分 `App.tsx`、`onnx-worker.ts`、`shared/config.ts` 或 `shared/messages.ts`。
- 全面替换 Vite Content Script 插件；本任务只允许为隔离 benchmark bridge 做必要的构建调整与断言。

## Resolved Decisions

- 不保留独立 legacy/benchmark Worker。
- 删除旧 AR runtime、Worker/Node Bridge RPC 和废弃 benchmark 入口。
- 保留历史 benchmark 报告和旧设置向 `paddleocr_v6_medium` 归一化的兼容 alias。
- 将 `export_ocr_ar_to_onnx.py`、`split-ocr-encoder-decoder.mjs` 等仍有参考价值的转换脚本迁入 `scripts/legacy/`，并提供用途说明。

## Notes

- 本任务属于复杂任务；必须补齐 `design.md` 与 `implement.md`，经用户审阅后才能执行 `task.py start`。
