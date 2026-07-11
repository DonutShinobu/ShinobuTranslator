# 补齐重构类型检查与行为护栏

## Goal

为后续结构重构建立统一、可重复的类型检查、测试、构建和 CI/Release 质量门禁，并补齐跨模块编排的基础行为测试。

## Requirements

- 应用源码、`tests/` 和 `benchmark/` TypeScript 均由显式 tsconfig/命令检查。
- `npm run test`、类型检查和构建形成统一 `check` 入口。
- 新增 push/PR CI；Release 在打包前执行同等核心门禁。
- 增加 `runPipeline` 阶段顺序、模式分支和 `PipelineStageError.artifacts` 行为测试。
- 增加 Release 构建产物检查框架，供 benchmark bridge 与 Worker 子任务复用。
- 后续结构子任务必须先添加自己的 characterization tests，再移动实现。

## Acceptance Criteria

- [x] app/tests/benchmark 类型检查命令全部通过。
- [x] `npm run check`（或最终同义命令）按固定顺序执行类型检查、测试和构建。
- [x] CI 在 push/PR 上运行，Release workflow 在上传 ZIP 前运行核心检查。
- [x] orchestrator 行为测试覆盖正常路径、erase/original/translate 分支和阶段错误 artifacts。
- [x] 构建产物断言可在本地和 CI 中运行。

## Dependencies

- 无。
- `refactor-typeset-boundary`、`refactor-background-services`、`refactor-content-core-ui` 和 `isolate-legacy-ocr-runtime` 启动前必须完成本任务。

## Out of Scope

- 在本任务内拆分 Background、Content、Typeset 或 Worker 实现。
- 强制执行所有耗时较长的真实浏览器 benchmark；CI 只运行稳定、可重复的核心门禁。

## Notes

- 各结构子任务负责其领域的新增行为测试，本任务负责统一入口和基础编排护栏。
