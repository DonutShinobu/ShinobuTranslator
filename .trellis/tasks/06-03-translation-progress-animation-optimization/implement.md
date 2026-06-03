# 实施计划：翻译进度动画优化

## 前置确认

- 用户已确认开始实施，直到解决药丸动画卡顿；药丸动画视觉效果不能改变。
- 进入实现前运行 `task.py start`，并加载 `trellis-before-dev`。

## 推荐实施顺序

1. 观测基础设施
   - 添加翻译运行期 long animation frame / long task 采样。
   - 将采样数据与当前 pipeline stage 关联。
   - 添加 rAF frame delta sampler，记录 max / p95 / 慢帧数量 / 连续慢帧。
   - 调试开启时在完成结果或 console 输出结构化摘要。

2. UI render 采样
   - 包装 `renderUi()` / `renderScreenshotResultUi()` 调用耗时。
   - 记录 stageText 变化次数和 render 最大耗时。
   - 暂不改变旧动画行为。

3. Pipeline 子阶段标记
   - 为 detect postprocess、OCR preprocess、inpaint pre/decode/resize/compose、canvasToBlob 增加分段耗时。
   - 保留现有 stageTimings，不改变业务结果。

4. Worker roundtrip 采样
   - 包装 `createSession`、`runInference`、`runOcrSplitBatchDecode`、`runDetectWithGpuPreprocess`。
   - 估算输入/输出 bytes，记录 duration。
   - 用时间戳与 LoAF/long task 对齐。

5. 输出与分析
   - 生成 `ProgressJankReport`。
   - 把报告附加到 debug log，或在开发/调试开关下 console 输出。
   - 用固定样本跑 baseline，并按 design.md 的归因规则给出下一步实验建议。

6. 后续逐项优化实验（第一轮之后）
   - UI 静默对照。
   - 主线程 cooperative yielding。
   - 最大子阶段 worker 迁移。
   - 每项实验前后对比同一份 jank report。
   - UI 静默对照仅用于诊断，不作为最终保留改动。

## 验证命令

```bash
npx tsc --noEmit
npm run build
```

可选：

```bash
npm run bench:browser-pipeline-smoke
npm run bench:browser-x-current
```

## 重点检查文件

- `src/content/core/ui.ts`
- `src/content/core/TranslatorCore.ts`
- `src/content/core/types.ts`
- `src/pipeline/orchestrator.ts`
- `src/pipeline/ocr/index.ts`
- `src/pipeline/ocr/preprocess.ts`
- `src/pipeline/inpaint.ts`
- `src/pipeline/detect/onnxDetect.ts`
- `src/pipeline/maskRefinement/*`
- `src/runtime/onnxWorkerBridge.ts`
- `src/workers/onnx-worker.ts`

## 回滚点

- 第一轮观测代码必须可通过开关关闭，关闭后不影响翻译行为。
- 不改药丸动画视觉效果；任何临时 UI 对照实验都不能作为最终改动保留。
- 后续每个优化实验独立 diff，方便按报告回滚或保留。
