# Legacy OCR 与 Worker RPC 隔离设计

## 1. 当前边界

当前产品 OCR Provider 统一到 `paddleocr_v6_medium`，但生产 Browser/Node Bridge 和 Worker API 仍暴露旧 AR batch/split/single/color decode，导致 `decodeAutoregressive.ts`、`gpuArgmax.ts`、`ocr/color.ts` 等进入 Release Worker。

## 2. 审计分类

对每个 RPC/模块标记：

- `product`：当前 Manifest/设置/Provider 可达。
- `benchmark-required`：有具名、可执行 benchmark 命令依赖。
- `historical-only`：只有旧测试、脚本或无调用。

当前仓库没有 `benchmark-required` 的旧 AR runtime。`historical-only` runtime/RPC 删除；历史报告保留为静态证据。

## 3. 已选目标形态

从 Worker API types、Browser/Node Bridge、Worker、测试和旧辅助模块中删除 AR RPC；不建立 legacy Worker。删除废弃 benchmark 命令和拒绝 legacy 模式的占位入口/分支。历史报告与实验文档保持原路径；有参考价值的模型转换脚本迁入 `scripts/legacy/` 并标注不属于当前产品路径。

## 4. 稳定生产 API

保留：session create/run/dispose、Paddle 当前路径所需推理、GPU detector preprocess、runtime self-check，以及经证据确认的 graph-capture probe。具体保留列表由调用审计锁定。

## 5. 验证维度

- Worker 字节数和旧 RPC 字符串。
- Paddle OCR region/text/provider/debug。
- Node OCR benchmark。
- 浏览器 cold/warm profile。
- detector/inpaint/session lifecycle。

## 6. 兼容与回滚

保留旧设置值到 Paddle medium 的 normalize alias，避免已安装用户配置失效。先移除 API 调用面，再移除实现文件；若 Paddle/Node 回归，可恢复最近一组提交并查明误删的共享 helper，但不得把整套 legacy 实现重新静态导入生产 Worker作为长期回滚。
