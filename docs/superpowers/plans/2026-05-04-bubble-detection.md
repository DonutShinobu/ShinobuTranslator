# 气泡检测 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 集成 YOLOv8m-seg 气泡检测模型，让排版使用气泡边界而非文字 bounding box，解决翻译文字多时字体过小的问题。

**Architecture:** 在 detect 之后、OCR 之前插入 bubble detect 阶段。新模型通过现有 modelRegistry 管理，新建 bubbleDetect.ts 处理推理和后处理。匹配结果（bubbleBox/bubbleMask）附加到 TextRegion，排版时用气泡空间替代文字 box。

**Tech Stack:** ONNX Runtime (已有)、YOLOv8m-seg ONNX 模型、Canvas API

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/types.ts` | Modify | TextRegion 新增 bubbleBox/bubbleMask 字段 |
| `public/models/manifest.json` | Modify | 新增 bubble 模型条目 |
| `src/runtime/modelRegistry.ts` | Modify | 模型名称联合类型加入 `"bubble"` |
| `src/pipeline/bubbleDetect.ts` | Create | 预处理、推理、NMS、mask 解码、region 匹配 |
| `src/pipeline/orchestrator.ts` | Modify | 插入 bubble detect 阶段 |
| `src/pipeline/typesetGeometry.ts` | Modify | bubbleBox 替换排版空间 |
| `src/pipeline/visualize.ts` | Modify | 未匹配 region 的可视化反馈 |

---

### Task 1: TextRegion 类型扩展

**Files:**
- Modify: `src/types.ts:15-30`

- [ ] **Step 1: 在 TextRegion 中新增 bubbleBox 和 bubbleMask 字段**

```typescript
// src/types.ts — TextRegion 类型中新增两个可选字段（加在 translatedColumns 之后）:
  bubbleBox?: Rect;
  bubbleMask?: ImageData;
```

- [ ] **Step 2: 确认类型检查通过**

Run: `npx tsc --noEmit`
Expected: 无新错误（新字段为可选，不影响现有代码）

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(types): add bubbleBox and bubbleMask to TextRegion"
```

---

### Task 2: 模型注册

**Files:**
- Modify: `public/models/manifest.json`
- Modify: `src/runtime/modelRegistry.ts:74,88-89`

- [ ] **Step 1: manifest.json 新增 bubble 模型条目**

在 `models` 对象中的 `"inpaint"` 条目之后新增：

```json
    "bubble": {
      "name": "bubble",
      "task": "bubble-segmentation",
      "url": "/models/bubble.onnx",
      "input": [640, 640],
      "runtime": ["webgpu", "webnn", "wasm"]
    }
```

- [ ] **Step 2: modelRegistry.ts 的模型名称联合类型加入 "bubble"**

`src/runtime/modelRegistry.ts` 第 74 行 `getModel` 和第 88 行 `getModelSession` 的 `name` 参数类型从：
```typescript
name: 'detector' | 'ocr' | 'inpaint'
```
改为：
```typescript
name: 'detector' | 'ocr' | 'inpaint' | 'bubble'
```

- [ ] **Step 3: 确认类型检查通过**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add public/models/manifest.json src/runtime/modelRegistry.ts
git commit -m "feat(registry): add bubble segmentation model to manifest"
```

---

### Task 3: bubbleDetect.ts — 预处理与推理

**Files:**
- Create: `src/pipeline/bubbleDetect.ts`

- [ ] **Step 1: 创建 bubbleDetect.ts，实现预处理和推理入口**

```typescript
import * as ort from "onnxruntime-web";
import { getModelSession } from "../runtime/modelRegistry";
import type { Rect, TextRegion } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BubbleDetection = {
  box: Rect;
  score: number;
  mask: ImageData;
};

export type BubbleDetectResult = {
  bubbles: BubbleDetection[];
};

// ---------------------------------------------------------------------------
// Preprocessing — letterbox to 640x640, CHW float32 [0,1]
// ---------------------------------------------------------------------------

type LetterboxResult = {
  input: Float32Array;
  size: number;
  ratio: number;
  padX: number;
  padY: number;
};

function preprocessLetterbox(image: HTMLImageElement, size: number): LetterboxResult {
  const w = image.naturalWidth;
  const h = image.naturalHeight;
  const ratio = Math.min(size / w, size / h);
  const newW = Math.round(w * ratio);
  const newH = Math.round(h * ratio);
  const padX = Math.round((size - newW) / 2);
  const padY = Math.round((size - newH) / 2);

  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("气泡检测预处理失败：无法创建画布");

  ctx.fillStyle = "#7f7f7f";
  ctx.fillRect(0, 0, size, size);
  ctx.drawImage(image, padX, padY, newW, newH);

  const data = ctx.getImageData(0, 0, size, size).data;
  const input = new Float32Array(3 * size * size);
  const hw = size * size;
  for (let i = 0, p = 0; i < hw; i += 1, p += 4) {
    input[i] = data[p] / 255;
    input[hw + i] = data[p + 1] / 255;
    input[2 * hw + i] = data[p + 2] / 255;
  }
  return { input, size, ratio, padX, padY };
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

async function runBubbleInference(image: HTMLImageElement): Promise<{
  output0: Float32Array;
  output0Shape: readonly number[];
  output1: Float32Array;
  output1Shape: readonly number[];
  prep: LetterboxResult;
}> {
  const handle = await getModelSession("bubble");
  const size = 640;
  const prep = preprocessLetterbox(image, size);

  const inputName = handle.session.inputNames[0] ?? "images";
  const feeds: Record<string, ort.Tensor> = {
    [inputName]: new ort.Tensor("float32", prep.input, [1, 3, size, size]),
  };
  const outputs = await handle.session.run(feeds);

  const outputNames = handle.session.outputNames;
  const out0 = outputs[outputNames[0]];
  const out1 = outputs[outputNames[1]];
  if (!out0 || !out1) {
    throw new Error("气泡检测模型输出张量缺失");
  }

  return {
    output0: out0.data as Float32Array,
    output0Shape: out0.dims,
    output1: out1.data as Float32Array,
    output1Shape: out1.dims,
    prep,
  };
}
```

- [ ] **Step 2: 确认类型检查通过**

Run: `npx tsc --noEmit`
Expected: PASS（文件已导入但尚未被其他文件引用，不影响）

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/bubbleDetect.ts
git commit -m "feat(bubble): add preprocessing and inference for bubble detection"
```

---

### Task 4: bubbleDetect.ts — 后处理（NMS + mask 解码）

**Files:**
- Modify: `src/pipeline/bubbleDetect.ts`

- [ ] **Step 1: 在 bubbleDetect.ts 中添加 NMS 和 mask 解码**

在 `runBubbleInference` 函数之后追加：

```typescript
// ---------------------------------------------------------------------------
// NMS
// ---------------------------------------------------------------------------

function rectIou(a: Rect, b: Rect): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}

type ScoredBox = { box: Rect; score: number; index: number };

function nmsBoxes(items: ScoredBox[], iouThreshold: number): ScoredBox[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const kept: ScoredBox[] = [];
  for (const current of sorted) {
    let suppressed = false;
    for (const prev of kept) {
      if (rectIou(current.box, prev.box) > iouThreshold) {
        suppressed = true;
        break;
      }
    }
    if (!suppressed) kept.push(current);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Decode output0 → boxes + scores + mask coefficients
// ---------------------------------------------------------------------------

const CONF_THRESHOLD = 0.5;
const IOU_THRESHOLD = 0.5;

type RawDetection = {
  box: Rect;
  score: number;
  maskCoeffs: Float32Array;
};

function decodeDetections(
  output0: Float32Array,
  shape: readonly number[],
  prep: LetterboxResult,
  imgW: number,
  imgH: number,
): RawDetection[] {
  // output0 shape: [1, 37, N] — need to transpose to [N, 37]
  // 37 = 4(box) + 1(score) + 32(mask coefficients)
  const channels = shape[1]; // 37
  const numCandidates = shape[2]; // N

  const detections: ScoredBox[] = [];
  const coeffsMap = new Map<number, Float32Array>();

  for (let i = 0; i < numCandidates; i++) {
    const cx = output0[0 * numCandidates + i];
    const cy = output0[1 * numCandidates + i];
    const w = output0[2 * numCandidates + i];
    const h = output0[3 * numCandidates + i];
    const score = output0[4 * numCandidates + i];

    if (score < CONF_THRESHOLD) continue;

    // letterbox coords → original image coords
    const x1 = (cx - w / 2 - prep.padX) / prep.ratio;
    const y1 = (cy - h / 2 - prep.padY) / prep.ratio;
    const bw = w / prep.ratio;
    const bh = h / prep.ratio;

    const clampedX = Math.max(0, Math.min(x1, imgW));
    const clampedY = Math.max(0, Math.min(y1, imgH));
    const clampedW = Math.min(bw, imgW - clampedX);
    const clampedH = Math.min(bh, imgH - clampedY);

    if (clampedW <= 0 || clampedH <= 0) continue;

    const box: Rect = { x: clampedX, y: clampedY, width: clampedW, height: clampedH };
    detections.push({ box, score, index: i });

    const coeffs = new Float32Array(32);
    for (let c = 0; c < 32; c++) {
      coeffs[c] = output0[(5 + c) * numCandidates + i];
    }
    coeffsMap.set(i, coeffs);
  }

  const kept = nmsBoxes(detections, IOU_THRESHOLD);

  return kept.map((d) => ({
    box: d.box,
    score: d.score,
    maskCoeffs: coeffsMap.get(d.index)!,
  }));
}

// ---------------------------------------------------------------------------
// Decode proto masks → per-instance ImageData
// ---------------------------------------------------------------------------

function decodeMasks(
  detections: RawDetection[],
  output1: Float32Array,
  output1Shape: readonly number[],
  prep: LetterboxResult,
  imgW: number,
  imgH: number,
): ImageData[] {
  // output1 shape: [1, 32, maskH, maskW]
  const numProtos = output1Shape[1]; // 32
  const maskH = output1Shape[2]; // 160
  const maskW = output1Shape[3]; // 160

  const masks: ImageData[] = [];

  for (const det of detections) {
    // Linear combination: coeffs[32] × protos[32, maskH, maskW] → [maskH, maskW]
    const combined = new Float32Array(maskH * maskW);
    for (let p = 0; p < numProtos; p++) {
      const coeff = det.maskCoeffs[p];
      const protoOffset = p * maskH * maskW;
      for (let j = 0; j < maskH * maskW; j++) {
        combined[j] += coeff * output1[protoOffset + j];
      }
    }

    // Sigmoid
    for (let j = 0; j < combined.length; j++) {
      combined[j] = 1 / (1 + Math.exp(-combined[j]));
    }

    // Crop to box region in letterbox space, then map to original image
    // Box in letterbox space:
    const lbx1 = det.box.x * prep.ratio + prep.padX;
    const lby1 = det.box.y * prep.ratio + prep.padY;
    const lbx2 = (det.box.x + det.box.width) * prep.ratio + prep.padX;
    const lby2 = (det.box.y + det.box.height) * prep.ratio + prep.padY;

    // Scale to mask space (mask is 160x160 for 640x640 input = 1/4)
    const scaleX = maskW / prep.size;
    const scaleY = maskH / prep.size;
    const mx1 = Math.max(0, Math.floor(lbx1 * scaleX));
    const my1 = Math.max(0, Math.floor(lby1 * scaleY));
    const mx2 = Math.min(maskW, Math.ceil(lbx2 * scaleX));
    const my2 = Math.min(maskH, Math.ceil(lby2 * scaleY));

    // Create full-image-size binary mask
    const imageData = new ImageData(imgW, imgH);
    const pixels = imageData.data;

    for (let iy = 0; iy < imgH; iy++) {
      // Map original image y → mask y
      const mfy = (iy * prep.ratio + prep.padY) * scaleY;
      const miy = Math.floor(mfy);
      if (miy < my1 || miy >= my2) continue;

      for (let ix = 0; ix < imgW; ix++) {
        const mfx = (ix * prep.ratio + prep.padX) * scaleX;
        const mix = Math.floor(mfx);
        if (mix < mx1 || mix >= mx2) continue;

        const val = combined[miy * maskW + mix];
        if (val > 0.5) {
          const idx = (iy * imgW + ix) * 4;
          pixels[idx] = 255;
          pixels[idx + 1] = 255;
          pixels[idx + 2] = 255;
          pixels[idx + 3] = 255;
        }
      }
    }

    masks.push(imageData);
  }

  return masks;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function detectBubbles(image: HTMLImageElement): Promise<BubbleDetectResult> {
  const { output0, output0Shape, output1, output1Shape, prep } = await runBubbleInference(image);
  const imgW = image.naturalWidth;
  const imgH = image.naturalHeight;

  const detections = decodeDetections(output0, output0Shape, prep, imgW, imgH);
  const masks = decodeMasks(detections, output1, output1Shape, prep, imgW, imgH);

  const bubbles: BubbleDetection[] = detections.map((det, i) => ({
    box: det.box,
    score: det.score,
    mask: masks[i],
  }));

  return { bubbles };
}
```

- [ ] **Step 2: 确认类型检查通过**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/bubbleDetect.ts
git commit -m "feat(bubble): add NMS, box decoding, and mask decoding"
```

---

### Task 5: bubbleDetect.ts — Region 匹配

**Files:**
- Modify: `src/pipeline/bubbleDetect.ts`

- [ ] **Step 1: 添加 matchRegionsToBubbles 函数**

在 `detectBubbles` 函数之后追加：

```typescript
// ---------------------------------------------------------------------------
// Region ↔ Bubble matching
// ---------------------------------------------------------------------------

export function matchRegionsToBubbles(
  regions: TextRegion[],
  bubbles: BubbleDetection[],
): { unmatchedCount: number; unmatchedRegionIds: string[] } {
  const unmatchedRegionIds: string[] = [];

  for (const region of regions) {
    const cx = region.box.x + region.box.width / 2;
    const cy = region.box.y + region.box.height / 2;

    let bestBubble: BubbleDetection | null = null;
    let bestArea = Infinity;

    for (const bubble of bubbles) {
      const area = bubble.box.width * bubble.box.height;
      if (area >= bestArea) continue;

      // Check if center point is inside bubble mask
      const px = Math.round(cx);
      const py = Math.round(cy);
      const maskW = bubble.mask.width;
      const maskH = bubble.mask.height;
      if (px < 0 || px >= maskW || py < 0 || py >= maskH) continue;

      const idx = (py * maskW + px) * 4;
      if (bubble.mask.data[idx + 3] > 0) {
        bestBubble = bubble;
        bestArea = area;
      }
    }

    if (bestBubble) {
      region.bubbleBox = { ...bestBubble.box };
      region.bubbleMask = bestBubble.mask;
    } else {
      unmatchedRegionIds.push(region.id);
    }
  }

  return {
    unmatchedCount: unmatchedRegionIds.length,
    unmatchedRegionIds,
  };
}
```

- [ ] **Step 2: 确认类型检查通过**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/bubbleDetect.ts
git commit -m "feat(bubble): add region-to-bubble matching"
```

---

### Task 6: Orchestrator 集成

**Files:**
- Modify: `src/pipeline/orchestrator.ts`

- [ ] **Step 1: 在 orchestrator.ts 中导入 bubble detect**

在文件顶部 import 区域添加：

```typescript
import { detectBubbles, matchRegionsToBubbles } from "./bubbleDetect";
```

- [ ] **Step 2: 在 detect 阶段之后、OCR 之前插入 bubble detect 阶段**

在 `stageTimings.push({ stage: "detect", ... })` 之后（约第 158 行后），`report(onProgress, "ocr", ...)` 之前，插入：

```typescript
  report(onProgress, "bubble", "气泡检测");
  try {
    const t0 = performance.now();
    const bubbleResult = await detectBubbles(image);
    const matchResult = matchRegionsToBubbles(latestRegions, bubbleResult.bubbles);
    if (matchResult.unmatchedCount > 0) {
      console.warn(
        `[bubble] ${matchResult.unmatchedCount} 个文字区域未匹配到气泡:`,
        matchResult.unmatchedRegionIds,
      );
    }
    stageTimings.push({ stage: "bubble", label: "气泡检测", durationMs: performance.now() - t0 });
  } catch (error) {
    throw new PipelineStageError("气泡检测", toErrorDetail(error), buildArtifacts());
  }
```

- [ ] **Step 3: 确认类型检查通过**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/orchestrator.ts
git commit -m "feat(pipeline): integrate bubble detection stage after text detection"
```

---

### Task 7: 排版空间替换

**Files:**
- Modify: `src/pipeline/typesetGeometry.ts:1475-1530`

- [ ] **Step 1: 在 computeFullVerticalTypeset 中，cloneRegionForTypeset 之后用 bubbleBox 替换 box**

在 `src/pipeline/typesetGeometry.ts` 的 `computeFullVerticalTypeset` 函数中，找到以下代码（约第 1488 行）：

```typescript
  const cloned = cloneRegionForTypeset(inputRegion);
```

在其之后、`if (preferredColumns ...)` 之前插入：

```typescript
  if (cloned.bubbleBox) {
    cloned.box = { ...cloned.bubbleBox };
  }
```

- [ ] **Step 2: 在 expandRegionBeforeRender 中同样处理 bubbleBox**

在 `src/pipeline/typesetGeometry.ts` 的 `expandRegionBeforeRender` 函数中，找到（约第 1339 行）：

```typescript
  const expanded = cloneRegionForTypeset(region);
```

在其之后插入：

```typescript
  if (expanded.bubbleBox) {
    expanded.box = { ...expanded.bubbleBox };
  }
```

- [ ] **Step 3: 确认类型检查通过**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/typesetGeometry.ts
git commit -m "feat(typeset): use bubble box for layout space when available"
```

---

### Task 8: 日志可视化 — 未匹配 region 反馈

**Files:**
- Modify: `src/pipeline/visualize.ts`

- [ ] **Step 1: 修改 drawRegions 支持高亮未匹配气泡的 region**

在 `src/pipeline/visualize.ts` 中，修改 `drawRegions` 函数。在绘制每个 region 的循环内，检查是否有 `bubbleBox`，如果没有则用不同颜色标记。

找到第 22 行的 `for` 循环开头：

```typescript
  for (let i = 0; i < regions.length; i += 1) {
    const region = regions[i];
    const { x, y, width, height } = region.box;
```

替换为：

```typescript
  for (let i = 0; i < regions.length; i += 1) {
    const region = regions[i];
    const { x, y, width, height } = region.box;

    const hasBubble = !!region.bubbleBox;
    if (!hasBubble) {
      ctx.strokeStyle = "#ff9500";
      ctx.fillStyle = "rgba(255,149,0,0.18)";
    } else {
      ctx.strokeStyle = "#ff3b30";
      ctx.fillStyle = "rgba(255,59,48,0.14)";
    }
```

同时删除函数开头的全局颜色设置（第 16-18 行）：

```typescript
  ctx.strokeStyle = "#ff3b30";
  ctx.fillStyle = "rgba(255,59,48,0.14)";
  ctx.lineWidth = 2;
```

替换为：

```typescript
  ctx.lineWidth = 2;
```

最后在标签绘制末尾（第 53 行附近），将硬编码的 `ctx.fillStyle = "rgba(255,59,48,0.14)"` 改为条件恢复（已由循环顶部处理，无需额外改动）。

- [ ] **Step 2: 确认类型检查通过**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/visualize.ts
git commit -m "feat(visualize): highlight regions without matched bubbles in orange"
```

---

### Task 9: 模型文件放置与端到端验证

**Files:**
- 无代码改动

- [ ] **Step 1: 下载 ONNX 模型文件**

从 https://huggingface.co/kitsumed/yolov8m_seg-speech-bubble 下载 `.onnx` 文件，放置到 `public/models/bubble.onnx`。

- [ ] **Step 2: 构建验证**

Run: `npx tsc --noEmit`
Expected: PASS，无类型错误

- [ ] **Step 3: 运行插件，用一张漫画页面测试完整 pipeline**

验证：
1. 气泡检测阶段正常执行，stageTimings 中出现 "气泡检测" 条目
2. 有气泡的文字区域 region.bubbleBox 被填充
3. 无气泡的文字区域（音效词等）console 中有 warn 日志
4. 排版时翻译文字更多的列不再过度缩小字体
5. 可视化中未匹配 region 显示橙色
