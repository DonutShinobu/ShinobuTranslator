# Implement — 脱离浏览器的Pipeline独立运行

## Implementation Checklist

### Phase 1: PlatformProvider 接口 + 浏览器实现

1. 创建 `src/runtime/platform.ts` — 定义 `PlatformProvider`、`PipelineCanvas`、`PipelineRenderingContext`、`PipelineImageData` 等结构类型
2. 创建 `src/runtime/browserPlatform.ts` — 用原生 DOM API 实现 PlatformProvider（`document.createElement("canvas")`、`new Image()`、`document.fonts.ready`）
3. **验证**: TypeScript 编译通过，类型定义正确覆盖 pipeline 使用的方法

### Phase 2: Pipeline Canvas/Image 调用替换

4. `src/pipeline/image.ts` — `fileToImage` 和 `imageToCanvas` 改为接收 `platform` 参数
5. `src/pipeline/ocr/index.ts` — 内部 `document.createElement("canvas")` 改为 `platform.createCanvas()`
6. `src/pipeline/detect/onnxDetect.ts` — 内部 canvas 创建改为 `platform.createCanvas()`
7. `src/pipeline/bubbleDetect.ts` — canvas/ImageData 相关调用改为 platform
8. `src/pipeline/inpaint.ts` — `composeInpaintResult` 中的 canvas 创建改为 platform
9. `src/pipeline/bake.ts` — `shinobuBake` 和 `shinobuRender` 接收 `platform` 参数，`loadImage` 改为 `platform.loadImage()`
10. `src/pipeline/orchestrator.ts` — `runPipeline` 创建 `browserPlatform` 并传入各阶段
11. `src/pipeline/typeset.ts` — `document.createElement("canvas")` 和 `document.fonts.ready` 改为 platform
12. **验证**: 浏览器插件功能不变——加载图片、检测文字、OCR、inpaint、typeset 全流程回归测试通过

### Phase 3: Node Platform 实现

13. 创建 `src/runtime/nodePlatform.ts` — 用 node-canvas 实现 PlatformProvider（`createCanvas` → `node-canvas.createCanvas`、`loadImage` → `node-canvas.loadImage`、`registerFont` → `node-canvas.registerFont`）
14. **验证**: `nodePlatform.createCanvas()` 和 `nodePlatform.loadImage()` 可工作，canvas 绑定 CJK 字体渲染正确

### Phase 4: ONNX Node Bridge

15. 提取 OCR decode 逻辑从 `onnx-worker.ts` 到 `src/runtime/ocrDecode/` 模块：
    - `batchDecode.ts` — `runOcrBatchDecode` 算法
    - `singleDecode.ts` — `runOcrSingleDecode` 算法
    - `colorDecode.ts` — `runOcrColorBatch` / `runOcrColorSingle` 算法
    - `decodeShared.ts` — 共享类型和辅助函数
16. 定义 `InferenceSessionLike` 接口（`run(feeds) → outputs`）
17. `onnx-worker.ts` 改为调用 `ocrDecode/` 模块（传入 Comlink-wrapped session）
18. 创建 `src/runtime/onnxNodeBridge.ts`：
    - `createSession` — `onnxruntime-node` InferenceSession.create，默认 CUDA EP
    - `runInference` — 直接 session.run()
    - OCR 函数 — 调用 `ocrDecode/` 模块（传入原生 session）
    - `probeRuntime` — 检测 CUDA 可用性
    - session 缓存用进程内 Map
19. `modelRegistry.ts` — 条件导入：`isNode ? onnxNodeBridge : onnxWorkerBridge`
20. Node 环境下模型 URL 解析改为本地文件路径
21. **验证**: `onnxNodeBridge.createSession('detector', localPath, ['cuda'])` 成功创建 CUDA session

### Phase 5: Node CLI 入口

22. 安装 CUDA Toolkit + cuDNN in WSL（前置依赖）
23. 安装 `onnxruntime-node` 为可选依赖（`npm install onnxruntime-node --save-optional`）
24. 创建 `benchmark/typeset/src/bake-node.ts`：
    - 接收图片路径参数
    - 用 `nodePlatform` + `onnxNodeBridge` 运行 detect → OCR → merge → bake
    - 输出与 `shinobuBake` 相同格式的 `BakeResult` JSON
    - 生成 fixture 文件（含 sha256、ground truth columns、bake info）
25. 添加 npm script: `bench:bake-node`
26. **验证**: `npm run bench:bake-node` 在 WSL2 + CUDA 下成功运行，输出 fixture JSON，推理使用 GPU

### Phase 6: 验证与清理

27. 运行完整浏览器插件回归测试——确保所有 pipeline 功能不变
28. 对比 Node bake 输出与 Chrome CDP bake 输出——确认格式一致
29. 保留 `bake-fixtures.ts` 和 `chrome-cdp.ts` 但标注为 deprecated，删除相关 npm script
30. 更新 `run-bench.ts` 如有需要（当前已在 Node 中工作）

## Validation Commands

```bash
# Phase 2 验证: 浏览器回归
npm run build && 手动测试插件功能

# Phase 4 验证: ONNX Node bridge
node -e "const ort = require('onnxruntime-node'); ort.InferenceSession.create('public/models/detector.onnx', { executionProviders: ['cuda'] }).then(s => console.log('CUDA OK', s.inputNames))"

# Phase 5 验证: Node CLI bake
npm run bench:bake-node

# Phase 6 验证: 对比输出
diff <(node bake-node output) <(chrome-cdp bake output)
```

## Risky Files / Rollback Points

- `src/pipeline/orchestrator.ts` — pipeline 主入口，改动影响所有浏览器功能。改动前确保备份。
- `src/runtime/onnxWorkerBridge.ts` — 浏览器 ONNX 桥接，改动需保留 Comlink/Worker 机制不变
- `src/runtime/modelRegistry.ts` — 条件导入改动，可能影响浏览器路径的模型加载
- `src/workers/onnx-worker.ts` — OCR decode 提取后此文件需重构，是最大的单文件改动

## Follow-up Checks before task.py start

- [ ] CUDA Toolkit + cuDNN 已在 WSL 中安装（`nvcc --version` 和 `ldconfig -p | grep cudnn` 可验证）
- [ ] `onnxruntime-node` npm install 成功（CUDA binary 下载无 404）
- [ ] node-canvas CJK 字体渲染在当前环境可用（运行 `run-bench.ts` 验证）