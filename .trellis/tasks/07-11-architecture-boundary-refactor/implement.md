# 架构边界重构总实施计划

> 父任务不直接实施产品代码。以下清单用于控制子任务启动顺序、集成门禁和最终验收。

## 0. 规划门禁

- [x] 用户已批准父任务与全部子任务规划，并要求依次完成所有任务。
- [x] 用户已决定删除旧 AR runtime/RPC 与废弃 benchmark，不保留 legacy Worker；保留历史报告并迁移转换脚本。
- [x] 所有任务记录 `branch=codex/architecture-boundary-refactor`、`base_branch=master`。

## 1. 独立边界修复

- [x] 完成 `07-11-isolate-benchmark-bridge`。
- [x] 验证 Release `content.js` 不含 benchmark 协议字符串。
- [x] 验证受控 benchmark 页面仍可 bake/render。

## 2. 工程护栏

- [x] 完成 `07-11-engineering-quality-gates`。
- [x] app/tests/benchmark 类型检查、单测、构建和 CI 门禁全部通过。
- [x] 建立后续子任务可复用的行为保持测试模式。

## 3. 可独立结构重构

- [x] 完成 `07-11-refactor-typeset-boundary`。
- [x] 完成 `07-11-refactor-background-services`。
- [x] 完成 `07-11-refactor-content-core-ui`。
- [x] 每个任务启动前确认 `engineering-quality-gates` 已完成。
- [x] 每个任务完成后单独运行相关测试和完整 build，不把修复推迟到下一子任务。

## 4. Runtime/OCR 收口

- [x] 确认 benchmark bridge 与质量门禁子任务均完成。
- [x] 完成 `07-11-isolate-legacy-ocr-runtime`。
- [x] 记录 `onnxWorker.js` 调整前后字节数、Paddle 浏览器 profile 和 Node benchmark。
- [x] 确认历史报告与设置兼容 alias 保留，转换脚本位于 `scripts/legacy/`，废弃 benchmark 命令和入口已删除。

## 5. 规范同步与集成

- [x] 完成 `07-11-sync-architecture-specs`。
- [x] 检查所有子任务验收项全部关闭；父任务仅剩提交后确认任务外文件未进入 commit。
- [x] 运行 `npm run typecheck`（最终脚本名以质量门禁子任务产物为准）。
- [x] 运行 `npm run test`。
- [x] 运行 `npm run build`。
- [x] 运行 Content/Worker 构建产物检查。
- [x] 运行浏览器 pipeline、UI jank、Paddle profile 中与改动相关的 smoke。
- [x] 检查 `git diff --check`、提交边界和 `benchmark/images/` 未被暂存。

## 6. 审阅与启动规则

- [x] 用户已批准本规划，可以按依赖逐个启动子任务。
- [x] 子任务按依赖逐个启动；父任务保持规划/集成所有者身份。
- [x] 若子任务需要改变稳定契约，返回父任务规划并更新设计，不在实现中静默扩大范围。
