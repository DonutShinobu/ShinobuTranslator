# PP-OCRv6 替换实施计划

## 执行清单

1. [x] 将 `PP-OCRv6_small_rec` 转换为 ONNX。实现时改用官方 ONNX 资产，见 `research/2026-06-14-implementation-results.md`。
2. [x] 从 small/medium 的 `inference.yml` 字符字典生成 `public/models/paddleocr_v6_dict.txt`。
3. [x] 验证 small ONNX 元数据：输入形状、输出类别数量，以及 `字典条目数 + 2` 是否匹配。
4. [x] 增加 small 专用模型注册，不改指、不删除当前 v5 路径。
5. [x] 小范围重构 Paddle OCR 识别提供者，让同一套代码可以按模型 id 加载 v5、v6 small 或 v6 medium。
6. [x] 将 v6 small 接入 OCR 引擎选择路径，UI 标签保持中文，并保持已有保存设置兼容。
7. [x] 对 v6 small 执行单元测试、类型检查、build 和浏览器冒烟测试。
8. [x] 如果 small 跑通，再将 `PP-OCRv6_medium_rec` 转换为 ONNX。实现时改用官方 ONNX 资产。
9. [x] 使用同一个 v6 字典验证 medium ONNX 元数据。
10. [x] 增加 medium 专用模型注册和 OCR 选择项。
11. [x] 对 v6 medium 执行同样的验证和浏览器冒烟测试。
12. [x] 新增或扩展浏览器基准测试，使其能在同一样本上运行 v5、v6 small、v6 medium。
13. [x] 记录基准测试结果，并判断速度/体积权衡是否支持保留两个 v6 层级给用户选择。
14. [x] 根据最终产品决策收敛插件选项：保留默认 `48px`，Paddle 只接 `paddleocr_v6_medium`，旧 Paddle 设置值作为兼容别名映射到 medium。

## 决策约束

- small 是本任务唯一的第一实现候选。
- medium 不是并行目标，必须等待 small 成功后再开始。
- 速度比较是本任务交付物之一，不只是冒烟测试附带信息。
- v5 必须保留为可运行基线，不能用 v6 直接覆盖。
- 大型 ONNX 模型文件是否提交，需要在实现后根据实际大小和用户确认决定；规划阶段不提交。

## 建议触达文件

- `public/models/models.json`
- `public/models/paddleocr_v6_dict.txt`
- `src/runtime/modelRegistry.ts`
- `src/pipeline/ocr/paddleocrProvider.ts`
- `src/pipeline/ocr/index.ts`
- `src/types.ts`
- `src/shared/config.ts`
- `src/popup/App.tsx`
- `tests/shared/config.test.ts`
- `benchmark/perf/src/`
- 如果新增基准测试脚本，则更新 `package.json`

## 验证命令

在让每个模型可选择后，执行：

```bash
npm test -- tests/pipeline/ocr/paddleocrDecode.test.ts
npx tsc --noEmit --pretty false
npm run build
```

为每个转换后的 ONNX 模型增加元数据检查：

```bash
node <metadata-check-script> public/models/<model>.onnx public/models/paddleocr_v6_dict.txt
```

build 后执行浏览器冒烟测试/基准测试。具体命令可以在实现时新增，但必须支持选择：

```bash
v5
v6-small
v6-medium
```

## 基准测试验收

最终基准测试报告需要包含：

- fixture/样本路径
- 浏览器和执行后端
- v5 冷启动加载耗时与热识别耗时
- v6 small 冷启动加载耗时与热识别耗时
- v6 medium 冷启动加载耗时与热识别耗时，如果 medium 成功
- 每次运行的区域数量和有效 OCR 数量
- 用于快速基本质量检查的代表性识别文本

## 风险与回滚点

- 如果 small 无法转换为 ONNX，在运行时/UI 改动前停止，并记录转换器失败信息。
- 如果 small 能转换但无法在 ONNX Runtime Web 中运行，则不暴露或移除 v6 UI/模型改动，并记录执行后端/算子失败信息。
- 如果 small 成功但 medium 失败，则只保留 small 作为 v6 候选，并记录 medium 的失败步骤。
- 如果 v6 推理能运行但文本质量明显异常，先检查字典顺序、输出类别数量、RGB/BGR 通道顺序和归一化方式，再考虑改下游流水线。
- 如果 medium 冷启动或模型体积代价过高，则把 medium 作为实验基准测试结果，而不是推荐的用户可见选项。

## 启动实现前检查

运行 `task.py start` 并修改运行时代码前，需要确认：

- 用户批准 small 优先、small 成功后再接 medium 的范围。
- 大型 ONNX 模型文件后续是保持本地实验，还是有意提交到仓库。
- 用户是否提供了比现有 fixture 更合适的日文漫画/条漫基准测试样本。
