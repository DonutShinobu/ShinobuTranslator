# 隔离 Legacy OCR 与 Worker RPC

## Goal

删除旧自回归 OCR runtime、Worker/Node Bridge RPC 和废弃 benchmark 入口，使生产 Worker/Bridge 只包含当前需要的能力，同时保留历史报告、设置兼容和有参考价值的模型转换脚本。

## Requirements

- 建立旧 AR OCR API、模型、benchmark 和调用方清单。
- 区分当前 Paddle 产品路径、仍有明确用途的实验路径和完全无调用路径。
- 已确认当前没有可执行的旧 AR/48px benchmark；现存 npm 入口和浏览器 compare 都明确拒绝该路径。
- 从生产 `onnxWorker.js` 和 Node Bridge 删除 AR decode/color RPC，不建立独立 legacy Worker。
- 同步收敛 `onnxBridge`、Browser/Node Bridge、Worker API types 和实现。
- 删除 `bench:ocr-gpu-argmax` 等废弃 benchmark 命令、占位入口和只服务旧 AR 的 CLI 分支。
- 保留历史 benchmark 报告、冷启动实验文档和旧设置向 `paddleocr_v6_medium` 归一化的兼容 alias。
- 将仍有参考价值的旧模型转换脚本迁入 `scripts/legacy/` 并增加用途/非生产说明。
- 记录 Worker bundle 调整前后字节数及相关性能/质量结果。

## Acceptance Criteria

- [x] 每个旧 AR RPC 都已从生产和 Node runtime 删除，并有调用审计证据。
- [x] Release `onnxWorker.js` 不含无产品用途的 legacy RPC 名称和实现。
- [x] PP-OCRv6 medium 浏览器 smoke、Paddle profile、Node OCR benchmark 和完整 test/build 通过。
- [x] 记录 bundle 大小、Provider、OCR 文本/区域数量和关键耗时前后对比。
- [x] 废弃 benchmark 命令/入口已删除，历史报告与兼容 alias 保留。
- [x] 参考转换脚本位于 `scripts/legacy/`，有明确 README，且不进入生产构建。

## Dependencies

- 必须先完成 `07-11-isolate-benchmark-bridge` 与 `07-11-engineering-quality-gates`。

## Resolved Decision

- 删除旧 AR runtime、Worker/Node Bridge RPC 和废弃 benchmark 入口，不保留独立 legacy Worker。
- 保留历史报告和设置兼容 alias；转换脚本迁入 `scripts/legacy/`。

## Out of Scope

- 引入新的 OCR 模型或重新评估 PP-OCRv6 small/48px。
- 调整 Paddle preprocess、CTC decode 或 batch 策略。

## Notes

- 实现时仍须逐符号审计共享 helper，确保 Paddle 当前路径所需代码不被误删。
