# 工程质量门禁设计

## 1. TypeScript 配置

采用分用途配置而非一个超大 include：

- `tsconfig.json` 或 `tsconfig.app.json`：产品 `src/`。
- `tsconfig.tests.json`：`src/` + `tests/`，包含 Vitest/Node 所需类型。
- `tsconfig.benchmark.json`：`src/` + `benchmark/**/*.ts`，包含 Node、DOM、WebGPU 类型。

提供稳定脚本：`typecheck:app`、`typecheck:tests`、`typecheck:benchmark`、`typecheck`、`check`。具体是否保留 `tsc -b` 由实现时以最小配置重复为准，但不得让测试/benchmark 继续逃逸类型检查。

## 2. 测试分工

- 本任务：建立 orchestrator 编排测试、产物断言基础设施和统一命令。
- Typeset 子任务：整体 draw/layout characterization。
- Background 子任务：typed router/领域 handler 测试。
- Content 子任务：state/controller 生命周期测试。
- OCR 子任务：Worker RPC/生产 bundle 测试。

## 3. CI/Release

- 新增 PR/push CI，执行依赖安装、typecheck、test、build、产物断言。
- Release workflow 在 ZIP 创建和上传之前运行同等核心门禁。
- 真实浏览器耗时 benchmark 不作为每次 CI 硬门禁；保留手动/专项命令。

## 4. Orchestrator 测试边界

优先使用 Vitest module mocks 或最小依赖注入锁定：阶段顺序、process mode 分支、并行阶段汇总、`PipelineStageError` 的 stage/detail/artifacts。测试不验证模型质量。

## 5. 失败与兼容

- 新类型检查暴露的既有错误必须显式修复或记录，禁止用扩大 `skipLibCheck`、`any` 或排除目录绕过。
- CI 只调用仓库脚本，避免本地和远端命令漂移。
