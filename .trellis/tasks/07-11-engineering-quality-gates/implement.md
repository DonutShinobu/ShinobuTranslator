# 工程质量门禁实施计划

## 1. 配置基线

- [x] 记录基线：app typecheck、517 项测试和 Release build 通过；tests/benchmark 此前未进入显式 typecheck。
- [x] 添加 tests/benchmark tsconfig，并修复 4 个测试与 9 个活跃 benchmark 类型错误。
- [x] 添加 `typecheck:*`、`typecheck` 和 `check` 脚本。

## 2. 行为与产物护栏

- [x] 新增 orchestrator 正常阶段顺序与 stage timing 测试。
- [x] 覆盖 translate/erase/original 模式及跳过阶段。
- [x] 覆盖阶段失败时 `PipelineStageError.artifacts`。
- [x] 扩展 Release 产物检查，统一验证必需文件、禁止字符串和全部 JS 语法。

## 3. 自动化

- [x] 新增 PR/push CI workflow。
- [x] Release workflow 在模型下载后、打包前调用统一核心门禁。
- [x] CI 的源码/构建门禁不要求未提交 ONNX；Release 先下载模型，再运行相同门禁并额外验证模型清单资产。

## 4. 验证

- [x] app/tests/benchmark 全部 typecheck 通过。
- [x] `npm run check` 中 35 个测试文件、521 项测试通过。
- [x] Release 与 benchmark build、产物断言均通过。
- [x] 两个 workflow YAML 可解析，`git diff --check` 通过，用户的 `benchmark/images/` 未纳入变更。

## 5. 回滚点

- [x] tsconfig/scripts、测试、CI workflow 保持为可独立审查和回滚的文件组；未在用户确认前自动提交。
- [x] 所有新门禁沿用 strict/noUnused 配置，没有降低严格度或排除活跃源码。
