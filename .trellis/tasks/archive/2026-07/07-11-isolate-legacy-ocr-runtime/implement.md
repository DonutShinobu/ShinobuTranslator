# Legacy OCR 与 Worker RPC 隔离实施计划

## 1. 调用审计

- [x] 列出所有 AR decode/color RPC 的定义、调用、测试、benchmark 和模型依赖。
- [x] 对每项标记 product/benchmark-required/historical-only。
- [x] 记录基线 `onnxWorker.js` 字节数与协议字符串。
- [x] 用户已决定删除旧 AR runtime/RPC 与废弃 benchmark，不建立 legacy Worker。

## 2. Characterization

- [x] 增加当前 Paddle Worker contract 测试。
- [x] 记录浏览器 Paddle smoke/profile 与 Node OCR 基线。
- [x] 固定 detector preprocess、session lifecycle 和 self-check 行为。

## 3. 收敛 API

- [x] 从 `OnnxWorkerApi` 和 transport types 移除无生产调用 RPC。
- [x] 同步收敛 `onnxBridge`、`onnxWorkerBridge`、`onnxNodeBridge` 和 Worker expose。
- [x] 删除 historical-only 解码/颜色/GPU argmax 实现及对应废弃 benchmark。
- [x] 删除 package 中的废弃 benchmark 命令和 benchmark runner 中只服务旧 AR 的入口/CLI 分支。
- [x] 保留历史报告、实验文档和设置 normalize alias。
- [x] 将仍有参考价值的 AR 模型导出/拆分脚本迁入 `scripts/legacy/`，补充 README。

## 4. 验证

- [x] 构建 Release，确认旧 RPC 字符串和 legacy entry 不存在。
- [x] 对比 Worker bundle 字节数。
- [x] 运行 Paddle decode/provider tests、浏览器 OCR smoke、Paddle profile、Node OCR benchmark。
- [x] 运行完整 typecheck/test/build 和产物断言。
- [x] 检查模型清单、当前 OCR aliases 和任务外文件未意外变化。

## 5. 回滚点

- [x] Legacy API types、Bridge/Worker、实现与 benchmark 清理作为独立边界提交 `3a359bd`，可整体回滚且不影响后续结构提交。
- [x] 未发现性能或质量回归；如后续回滚，只恢复审计中具名的最小能力，不整体恢复 legacy runtime。
