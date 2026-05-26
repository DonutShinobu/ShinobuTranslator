# 脱离浏览器的Pipeline独立运行

## Goal

让端到端翻译 pipeline 的 bake 阶段（detect → OCR → merge → JSON 输出）可以在 Node.js 中独立运行，使用 CUDA GPU 加速推理，同时确保浏览器插件中的 pipeline 代码改动自动同步到 Node.js 运行路径。

## Confirmed Facts

1. Pipeline 的浏览器 API 依赖：`document.createElement("canvas")`、`new Image()`、`CanvasRenderingContext2D`、`document.fonts.ready`、`File/FileReader`、`ImageData`
2. ONNX Runtime JS 有统一 API（`onnxruntime-common`），`onnxruntime-web` 和 `onnxruntime-node` 共享 `InferenceSession` 接口
3. ONNX 推理通过 `onnxWorkerBridge.ts` 的 ~8 个函数桥接（Comlink + Web Worker），pipeline 代码不直接操作 session
4. `run-bench.ts` 已用 node-canvas 证明排版几何可在 Node 中运行
5. WSL2 环境有 RTX 5070 Ti + CUDA 驱动，需安装 CUDA Toolkit + cuDNN
6. `bake-fixtures.ts` 硬编码 Windows Chrome 路径，仅限 Windows 运行

## Decisions

- **运行范围**: B — detect → OCR → merge → JSON 结构数据输出，与 `shinobuBake` 对齐
- **架构方案**: D — 轻量 `PlatformProvider`（~5 个工厂方法）+ 条件 ONNX 导入
- **ONNX**: `onnxruntime-node` + CUDA EP，安装 CUDA Toolkit in WSL
- **bake-fixtures.ts**: 完全替代，Node CLI 成为主路径，Chrome CDP 路径保留但不再使用

## Requirements

1. 定义 `PlatformProvider` 接口，包含 `createCanvas()`、`createImage()`、`loadImage()`、`registerFont()`、`waitForFonts()` 等工厂方法
2. 浏览器端实现 `browserPlatform`（原生 DOM API），Node 端实现 `nodePlatform`（node-canvas）
3. pipeline 内部所有 `document.createElement("canvas")` 和 `new Image()` 改为 `platform.createCanvas()` 和 `platform.createImage()()`
4. 创建 `onnxNodeBridge.ts`，实现与 `onnxWorkerBridge.ts` 相同的导出函数集，直接调用 `onnxruntime-node`
5. OCR decode 逻辑（batch decode、single decode、color）从 `onnx-worker.ts` 提取为共享模块，供两个桥接使用
6. `modelRegistry.ts` 根据运行环境条件导入正确的 ONNX 桥接
7. Node 模型加载改为本地文件路径（不再通过 `fetch` + URL）
8. 创建 Node CLI 入口（`benchmark/typeset/src/bake-node.ts`），替代 `bake-fixtures.ts`
9. Node CLI 输出与 `shinobuBake` 相同的 `BakeResult` JSON 格式

## Acceptance Criteria

- [ ] `PlatformProvider` 接口定义完成，TypeScript 编译通过
- [ ] `browserPlatform` 和 `nodePlatform` 实现完成
- [ ] pipeline 中所有 `document.createElement("canvas")` / `new Image()` 替换为 `platform.xxx()`，浏览器路径行为不变
- [ ] `onnxNodeBridge.ts` 实现完成，`InferenceSession.create()` 可用 CUDA EP
- [ ] OCR decode 逻辑提取为共享模块，Worker 和 Node 桥接均可使用
- [ ] `modelRegistry.ts` 条件导入工作，浏览器路径继续用 web worker，Node 路径用直接调用
- [ ] Node CLI 可接收图片路径，输出 `BakeResult` JSON
- [ ] Node CLI 在 WSL2 + CUDA 环境下运行，推理使用 GPU 加速
- [ ] 现有浏览器插件功能不受影响（回归测试通过）

## Out of Scope

- 翻译阶段（LLM API 调用）在 Node 中运行
- inpaint + typeset 全流程在 Node 中运行
- `run-bench.ts` 排版 benchmark 改动（已在 Node 中工作）
- CI/CD 自动化 benchmark 流程