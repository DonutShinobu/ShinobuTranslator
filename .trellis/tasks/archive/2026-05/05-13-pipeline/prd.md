# pipeline架构重构：消除重复代码与拆分巨型文件

## Goal

对 `src/pipeline/` 下的巨型文件按职责拆分为子目录模块，消除跨文件重复代码，提升可维护性和可测试性。纯内部重构，不改变外部行为。

## Requirements

### R1: 提取共享工具函数

- 创建 `src/shared/utils.ts`，提取全局共享函数：`toErrorMessage`
  - 当前在 7 处重复实现：messages.ts、onnx.ts、selfCheck.ts、detect.ts、ocr.ts、background/index.ts、content/core/utils.ts
  - selfCheck.ts 中的 `errText` 是同义函数，统一为 `toErrorMessage`
- 创建 `src/pipeline/utils.ts`，提取管线特有函数：
  - `clamp`（5处重复：detect.ts、inpaint.ts、readingOrder.ts、maskRefinement.ts、typesetGeometry.ts）
  - `connectedComponents`（3处重复：detect.ts、readingOrder.ts、maskRefinement.ts）
  - `polygonArea`（3处重复：detect.ts、textlineMerge.ts、maskRefinement.ts）
  - `convexHull`（2处重复：geometry.ts、textlineMerge.ts）
  - `nmsBoxes`（2处重复：detect.ts、bubbleDetect.ts）
  - `rectIou`（2处重复：detect.ts、bubbleDetect.ts）
  - `UnionFind`（textlineMerge.ts 中，通用数据结构）
  - `normalizeText`（2处重复但语义不同，需统一为一份实现：detect.ts 版本 strip newlines+whitespace，ocr.ts 版本只 trim。取 detect.ts 版本作为权威实现）

### R2: 拆分 detect.ts (1244行)

```
detect/
  index.ts           — 编排入口 detectTextRegionsWithMask（约150行）
  onnxDetect.ts      — ONNX 检测全流程（session创建+推理+后处理，约400行）
  heuristicDetect.ts — 启发式/Tesseract 回退检测（约350行）
  nms.ts             — NMS + mask→regions 转换（约200行）
```

- `nms.ts` 独立是因为 `bubbleDetect.ts` 也用到 NMS，拆出来共享
- `index.ts` 只做编排：尝试 ONNX，失败则回退 heuristic

### R3: 拆分 ocr.ts (1740行)

```
ocr/
  index.ts                — 编排入口 runOcr（约300行）
  decodeAutoregressive.ts — 自回归 beam search 解码（约500行）
  decodeCtc.ts            — CTC 解码（约200行，回退路径）
  preprocess.ts           — 透视变换、区域裁剪、方向推断（约300行）
  color.ts                — 背景色/文字色提取（约150行）
```

- 自回归解码是主力路径；CTC 是旧模型格式的回退分支

### R4: 拆分 typesetGeometry.ts (1749行)

```
typeset/
  index.ts     — 排版入口函数 computeFullVerticalTypeset / computeFullHorizontalTypeset（约400行）
  geometry.ts  — quad操作、凸包、区域扩展（约300行）
  columns.ts   — 分栏逻辑、列平衡、禁则处理（约400行）
  fontFit.ts   — 字号搜索、canvas测量、行宽计算（约300行）
  color.ts     — 颜色科学、对比度（约200行）
```

- 旧 `geometry.ts`(174行) 合并入 `typeset/geometry.ts`，然后删掉旧文件
- 旧 `geometry.ts` 中的 `convexHull` 和 `sortMiniBoxPoints` 归入 `typeset/geometry.ts`

### R5: 拆分 textlineMerge.ts (891行)

```
textlineMerge/
  index.ts           — 编排入口（约300行）
  mergePredicates.ts — 合并谓词、MST分裂逻辑（约400行）
```

- UnionFind 数据结构移入 `pipeline/utils.ts`

### R6: 拆分 maskRefinement.ts (718行)

```
maskRefinement/
  index.ts       — 编排入口（约300行）
  algorithms.ts  — Otsu阈值、膨胀、多边形裁剪（约350行）
```

### R7: 清理 TranslatorCore 重复逻辑

- 删除 `src/content/core/TranslatorCore.ts:55-91` 中的4个重复函数
- 改为 `import { resolveLlmBaseUrl, resolveLlmModel, validateActiveSettings, toPipelineConfig } from "../../shared/config"`

### R8: 不拆的文件

- `readingOrder.ts` (551行) — 职责单一，不拆
- `typeset.ts` (897行) — 与 typesetGeometry 紧密耦合，拆分 typesetGeometry 后复杂度自然下降，暂不动
- `inpaint.ts` (364行) — 较小
- `bubbleDetect.ts` (340行) — 较小
- `orchestrator.ts` (402行) — 编排层，保持不变
- `bake.ts` (178行) — 较小
- `image.ts`、`translate.ts`、`visualize.ts` — 较小

## Acceptance Criteria

- [ ] `npm run build` 通过，无 TypeScript 错误
- [ ] `npm run test` 通过，现有测试不受影响
- [ ] 所有重复函数已消除，各函数只有唯一实现
- [ ] 5个大文件 + 1个中文件已完成拆分，目录结构符合上述方案
- [ ] TranslatorCore 不再包含与 config.ts 重复的函数
- [ ] 旧单文件（detect.ts、ocr.ts、typesetGeometry.ts、textlineMerge.ts、maskRefinement.ts、geometry.ts）已删除
- [ ] 所有 import 路径已更新
- [ ] 外部行为无变化（纯重构）

## Definition of Done

- build + test 绿色
- 无遗留的死 import 或未使用的导出
- 每个 utils 函数和拆分模块的 export 列表清晰

## Technical Approach

### 执行顺序（有依赖关系）

1. 创建 `src/shared/utils.ts`（提取 toErrorMessage）
2. 创建 `src/pipeline/utils.ts`（提取 clamp、connectedComponents、polygonArea、convexHull、nmsBoxes、rectIou、UnionFind、normalizeText）
3. 替换所有文件中的重复调用 → import from utils
4. 拆分 detect.ts → detect/ 目录
5. 拆分 ocr.ts → ocr/ 目录
6. 拆分 typesetGeometry.ts → typeset/ 目录（合并旧 geometry.ts）
7. 拆分 textlineMerge.ts → textlineMerge/ 目录
8. 拆分 maskRefinement.ts → maskRefinement/ 目录
9. 清理 TranslatorCore 重复逻辑 → import from config.ts
10. 删除旧单文件
11. 更新所有 import 路径（orchestrator.ts、bake.ts、visualize.ts 等）
12. 运行 build + test 验证无破坏性变更
13. 运行 benchmark 做最终验证

### 验证策略

- 每步拆分后跑 `npm run build` + `npm run test` 做增量验证
- 全部拆完后跑 benchmark 做最终功能回归验证
- 不在重构期间补新测试（重构后代码更清晰，更容易写测试）

### 目录结构（重构后）

```
src/pipeline/
  detect/              ← 子目录
    index.ts
    onnxDetect.ts
    heuristicDetect.ts
    nms.ts
  ocr/                 ← 子目录
    index.ts
    decodeAutoregressive.ts
    decodeCtc.ts
    preprocess.ts
    color.ts
  typeset/             ← 子目录
    index.ts
    geometry.ts
    columns.ts
    fontFit.ts
    color.ts
  textlineMerge/       ← 子目录
    index.ts
    mergePredicates.ts
  maskRefinement/      ← 子目录
    index.ts
    algorithms.ts
  image.ts             ← 单文件（不动）
  translate.ts         ← 单文件（不动）
  visualize.ts         ← 单文件（不动）
  bake.ts              ← 单文件（不动）
  orchestrator.ts      ← 单文件（不动）
  bubbleDetect.ts      ← 单文件（不动）
  inpaint.ts           ← 单文件（不动）
  typeset.ts           ← 单文件（不动）
  readingOrder.ts      ← 单文件（不动）
  utils.ts             ← 新增

src/shared/
  utils.ts             ← 新增
  config.ts            ← 保留，TranslatorCore 改为 import 此文件
  messages.ts          ← 保留，删除内部 toErrorMessage
  chrome.ts            ← 不动
  assetUrl.ts          ← 不动
```

## Decision (ADR-lite)

**Context**: pipeline 模块存在 5 个 700+ 行的巨型文件和大量跨文件重复代码，影响可维护性、可测试性，且阻碍后续改进（Web Worker 迁移、测试编写）。

**Decision**: 按职责拆分为子目录模块（index.ts 编排 + 子模块），提取共享工具函数到 utils 文件。采用"大模块子目录 + 小模块单文件"的混合结构。外部 import 路径不变（子目录的 index.ts 作为入口）。

**Consequences**:
- 正面：文件职责清晰、重复消除、未来可按子模块独立测试和移入 Worker
- 风险：拆分过程中 import 路径更新量大，需每步 build 验证
- 不改变：外部行为、API 接口、管线执行结果

## Out of Scope

- Web Worker 迁移（依赖本次拆分，但不在本次范围内）
- 新增单元测试（重构后再补）
- 安全问题修复（API Key 路由、postMessage origin 校验）
- 性能优化（canvas 复用、bundle 代码分割）
- 类型安全改进（消除 `as` 强转、统一类型命名）
- 错误处理改进（消除空 catch、添加重试机制）
- ESLint / Prettier 配置
- 硬编码常量外置为配置
- 依赖管理（移除 playwright、条件加载 tesseract.js）

## Technical Notes

- `normalizeText` 在 detect.ts 和 ocr.ts 中语义不同：detect 版本 strip newlines+whitespace，ocr 版本只 trim。统一取 detect.ts 的完整版本，ocr.ts 调用处需确认兼容性
- 旧 `geometry.ts` 的 `convexHull` 与 `textlineMerge.ts` 的 `convexHull` 是重复实现，合并入 `typeset/geometry.ts` 后删掉 textlineMerge 中的版本
- `nmsBoxes` 在 detect.ts 和 bubbleDetect.ts 中重复，拆入 `detect/nms.ts` 后 bubbleDetect.ts 需 import 它
- Vite 的模块解析会自动处理 `detect/index.ts`，import `from "../../pipeline/detect"` 无需修改
