# PaddleOCR OCR 层抽象实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 OCR 层抽象为 OcrProvider 接口，引入 PaddleOCR（PP-OCRv5_server_rec）作为可选识别引擎，保持下游流程不变。

**Architecture:** 定义 OcrProvider 接口（必选+可选字段），将现有自研模型包装为 builtin provider，新增 paddleocr provider（ONNX 本地推理）。公共层 `fillMissingOcrFields` 自动补全方向和颜色缺失字段。设置页面增加 OCR 引擎单选按钮。

**Tech Stack:** TypeScript, onnxruntime-web, Web Worker (Comlink), React, chrome.storage.local

---

## 文件结构

| 操作 | 文件路径 | 负责内容 |
|------|---------|---------|
| Create | `src/pipeline/ocr/provider.ts` | OcrProvider 接口定义、OcrRecognizeResult 类型、注册表、fillMissingOcrFields |
| Create | `src/pipeline/ocr/builtinProvider.ts` | 将现有自研 ONNX AR 模型包装为 builtin OcrProvider |
| Create | `src/pipeline/ocr/paddleocrProvider.ts` | PaddleOCR PP-OCRv5_server_rec ONNX 识别 provider |
| Create | `src/pipeline/ocr/colorSampling.ts` | 边缘检测颜色采样补全逻辑（fgColor/bgColor） |
| Modify | `src/pipeline/ocr/index.ts` | runOcr 改为通过 provider 注册表调度，调用 fillMissingOcrFields |
| Modify | `src/shared/config.ts` | ExtensionSettings 增加 ocrEngine 字段 |
| Modify | `src/types.ts` | PipelineConfig 增加 ocrEngine 字段 |
| Modify | `src/popup/App.tsx` | 增加 OCR 引擎单选按钮 UI |
| Modify | `public/models/models.json` | 增加 paddleocr_rec 模型配置 |
| Create | `src/pipeline/ocr/paddleocrPreprocess.ts` | PaddleOCR 识别模型预处理（裁剪、resize、归一化） |
| Create | `src/pipeline/ocr/paddleocrDecode.ts` | PaddleOCR CTC 解码逻辑 |
| Modify | `src/runtime/modelRegistry.ts` | 支持 paddleocr_rec 模型名 |
| Modify | `src/workers/onnx-worker.ts` | 增加 PaddleOCR 推理支持 |
| Modify | `src/runtime/onnxWorkerTypes.ts` | 增加 PaddleOCR 相关类型 |

---

### Task 1: 定义 OcrProvider 接口和补全逻辑

**Files:**
- Create: `src/pipeline/ocr/provider.ts`
- Test: `tests/pipeline/ocr/provider.test.ts`

- [ ] **Step 1: 写失败的测试**

```typescript
// tests/pipeline/ocr/provider.test.ts
import { describe, it, expect } from 'vitest';
import { fillMissingOcrFields, type OcrRecognizeResult } from '../../../src/pipeline/ocr/provider';
import type { QuadPoint, TextDirection } from '../../../src/types';

const quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint] = [
  { x: 10, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 50 }, { x: 10, y: 50 }
];

describe('fillMissingOcrFields', () => {
  it('补全缺失的 direction 为 h（宽 >= 高）', () => {
    const result: OcrRecognizeResult = { text: 'テスト', confidence: 0.9, quad };
    const filled = fillMissingOcrFields([result])[0];
    expect(filled.direction).toBe('h');
  });

  it('补全缺失的 direction 为 v（高 > 宽）', () => {
    const vQuad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint] = [
      { x: 10, y: 10 }, { x: 50, y: 10 }, { x: 50, y: 100 }, { x: 10, y: 100 }
    ];
    const result: OcrRecognizeResult = { text: 'テスト', confidence: 0.9, quad: vQuad };
    const filled = fillMissingOcrFields([result])[0];
    expect(filled.direction).toBe('v');
  });

  it('保留引擎已提供的 direction', () => {
    const result: OcrRecognizeResult = { text: 'テスト', confidence: 0.9, quad, direction: 'v' };
    const filled = fillMissingOcrFields([result])[0];
    expect(filled.direction).toBe('v');
  });

  it('补全缺失的 fgColor 和 bgColor', () => {
    const result: OcrRecognizeResult = { text: 'テスト', confidence: 0.9, quad };
    const filled = fillMissingOcrFields([result])[0];
    expect(filled.fgColor).toBeDefined();
    expect(filled.bgColor).toBeDefined();
    expect(filled.fgColor!.length).toBe(3);
    expect(filled.bgColor!.length).toBe(3);
  });

  it('保留引擎已提供的颜色', () => {
    const result: OcrRecognizeResult = {
      text: 'テスト', confidence: 0.9, quad,
      fgColor: [255, 0, 0], bgColor: [0, 0, 255]
    };
    const filled = fillMissingOcrFields([result])[0];
    expect(filled.fgColor).toEqual([255, 0, 0]);
    expect(filled.bgColor).toEqual([0, 0, 255]);
  });

  it('补全后所有必存字段都存在', () => {
    const result: OcrRecognizeResult = { text: 'テスト', confidence: 0.9, quad };
    const filled = fillMissingOcrFields([result])[0];
    expect(filled.direction).toBeDefined();
    expect(filled.fgColor).toBeDefined();
    expect(filled.bgColor).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/pipeline/ocr/provider.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/pipeline/ocr/provider.ts
import type { QuadPoint, TextDirection } from '../../types';

export type OcrRecognizeResult = {
  text: string;
  confidence: number;
  quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
  direction?: TextDirection;
  fgColor?: [number, number, number];
  bgColor?: [number, number, number];
};

export type OcrProvider = {
  name: string;
  recognize(image: HTMLImageElement, regions: TextRegion[]): Promise<OcrRecognizeResult[]>;
};

import type { TextRegion } from '../../types';

const ocrProviders: Record<string, OcrProvider> = {};

export function registerOcrProvider(provider: OcrProvider): void {
  ocrProviders[provider.name] = provider;
}

export function getOcrProvider(name: string): OcrProvider | undefined {
  return ocrProviders[name];
}

export function inferDirectionFromQuad(quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint]): TextDirection {
  const xs = quad.map(p => p.x);
  const ys = quad.map(p => p.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  return height > width ? 'v' : 'h';
}

export function fillMissingOcrFields(results: OcrRecognizeResult[]): OcrRecognizeResult[] {
  return results.map(r => ({
    ...r,
    direction: r.direction ?? inferDirectionFromQuad(r.quad),
    fgColor: r.fgColor ?? [0, 0, 0],
    bgColor: r.bgColor ?? [255, 255, 255],
  }));
}
```

注意：`fgColor` 和 `bgColor` 的默认值 `[0,0,0]` 和 `[255,255,255]` 是占位符，会在 Task 3 中替换为边缘检测采样逻辑。当前先确保接口和补全框架可用。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/pipeline/ocr/provider.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/ocr/provider.ts tests/pipeline/ocr/provider.test.ts
git commit -m "feat: 定义 OcrProvider 接口和 fillMissingOcrFields 补全逻辑"
```

---

### Task 2: 包装自研模型为 builtin OcrProvider

**Files:**
- Create: `src/pipeline/ocr/builtinProvider.ts`
- Modify: `src/pipeline/ocr/index.ts`

- [ ] **Step 1: 创建 builtinProvider**

将 `src/pipeline/ocr/index.ts` 中现有的 `runOcrByOnnxWithSession` 的结果组装逻辑提取为 provider 的 `recognize` 方法。核心思路：provider 返回 `OcrRecognizeResult[]`（包含自研模型的所有字段），不再直接组装 `TextRegion[]`。

```typescript
// src/pipeline/ocr/builtinProvider.ts
import type { OcrProvider, OcrRecognizeResult } from './provider';
import type { TextRegion } from '../../types';
import { runOcrByOnnxInternal } from './index';

export const builtinOcrProvider: OcrProvider = {
  name: 'builtin',
  async recognize(image: HTMLImageElement, regions: TextRegion[]): Promise<OcrRecognizeResult[]> {
    return runOcrByOnnxInternal(image, regions);
  },
};
```

- [ ] **Step 2: 修改 index.ts — 提取内部函数并重构 runOcr**

在 `src/pipeline/ocr/index.ts` 中：

1. 将 `runOcrByOnnxWithSession` 中最终组装结果的逻辑（lines 298-313）改为返回 `OcrRecognizeResult[]`，而不是 `TextRegion[]`
2. 导出一个新函数 `runOcrByOnnxInternal` 供 builtinProvider 调用
3. 修改顶层 `runOcr` 函数：通过 provider 注册表选择引擎，调用 `recognize`，再调用 `fillMissingOcrFields`，最后组装 `TextRegion[]`

具体改动：

```typescript
// src/pipeline/ocr/index.ts — 修改后的顶层 runOcr
import { registerOcrProvider, getOcrProvider, fillMissingOcrFields } from './provider';
import { builtinOcrProvider } from './builtinProvider';

registerOcrProvider(builtinOcrProvider);

export async function runOcr(
  image: HTMLImageElement,
  detectedRegions: TextRegion[],
  providerName?: string
): Promise<OcrResult> {
  const provider = getOcrProvider(providerName ?? 'builtin');
  if (!provider) {
    throw new Error(`OCR 引擎未注册: ${providerName ?? 'builtin'}`);
  }
  const rawResults = await provider.recognize(image, detectedRegions);
  const filledResults = fillMissingOcrFields(rawResults);

  // 将 OcrRecognizeResult[] 映射回 TextRegion[]
  const regions: TextRegion[] = filledResults.map((r, i) => ({
    id: detectedRegions[i]?.id ?? `ocr-${i}`,
    box: detectedRegions[i]?.box ?? { x: 0, y: 0, width: 0, height: 0 },
    quad: r.quad,
    direction: r.direction,
    prob: r.confidence,
    fgColor: r.fgColor,
    bgColor: r.bgColor,
    sourceText: r.text,
    translatedText: '',
  }));

  return {
    regions,
    actualProvider: ...,
    debug: ...,
  };
}
```

`runOcrByOnnxInternal` 需要从现有 `runOcrByOnnxWithSession` 的最终组装逻辑中提取，返回 `OcrRecognizeResult[]`。需要把 `actualProvider` 和 `debug` 信息也传出，以便 `runOcr` 组装 `OcrResult`。

- [ ] **Step 3: 运行现有测试确认不破坏**

Run: `npx vitest run tests/pipeline/ocr/`
Expected: PASS（所有现有 OCR 测试仍通过）

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/ocr/builtinProvider.ts src/pipeline/ocr/index.ts
git commit -m "feat: 包装自研模型为 builtin OcrProvider，重构 runOcr 使用 provider 注册表"
```

---

### Task 3: 边缘检测颜色采样

**Files:**
- Create: `src/pipeline/ocr/colorSampling.ts`
- Modify: `src/pipeline/ocr/provider.ts`
- Test: `tests/pipeline/ocr/colorSampling.test.ts`

- [ ] **Step 1: 写失败的测试**

```typescript
// tests/pipeline/ocr/colorSampling.test.ts
import { describe, it, expect } from 'vitest';
import { sampleEdgeColors, sampleCornerBgColor } from '../../../src/pipeline/ocr/colorSampling';

// 创建一个模拟的裁剪区域像素数据：
// 黑字白底 — 左半边全是白色(255)，右半边有黑色(0)文字笔画
function createTestImageData(width: number, height: number, fgR: number, fgG: number, fgB: number, bgR: number, bgG: number, bgB: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  // 全部填充背景色
  for (let i = 0; i < data.length; i += 4) {
    data[i] = bgR; data[i + 1] = bgG; data[i + 2] = bgB; data[i + 3] = 255;
  }
  // 中心区域填充前景色（模拟文字）
  const cx = Math.floor(width / 2);
  const cy = Math.floor(height / 2);
  for (let y = cy - 2; y <= cy + 2; y++) {
    for (let x = cx - 5; x <= cx + 5; x++) {
      const idx = (y * width + x) * 4;
      data[idx] = fgR; data[idx + 1] = fgG; data[idx + 2] = fgB; data[idx + 3] = 255;
    }
  }
  return data;
}

describe('sampleEdgeColors', () => {
  it('从黑字白底图像中采样出近黑色的 fgColor', () => {
    const width = 40, height = 20;
    const pixelData = createTestImageData(width, height, 0, 0, 0, 255, 255, 255);
    const fgColor = sampleEdgeColors(pixelData, width, height);
    // 边缘像素应该检测到黑色笔画边界
    expect(fgColor).toBeDefined();
    expect(fgColor![0]).toBeLessThan(50);
  });

  it('返回 null 时像素数据不足以检测边缘', () => {
    // 纯色图像（无边缘）
    const width = 10, height = 10;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i += 4) {
      data[i] = 128; data[i + 1] = 128; data[i + 2] = 128; data[i + 3] = 255;
    }
    const fgColor = sampleEdgeColors(pixelData, width, height);
    // 纯色图没有边缘，应返回 null 或 fallback
    expect(fgColor).toBeDefined(); // fallback 到某种合理值
  });
});

describe('sampleCornerBgColor', () => {
  it('从四角采样出白色背景', () => {
    const width = 40, height = 20;
    const pixelData = createTestImageData(width, height, 0, 0, 0, 255, 255, 255);
    const bgColor = sampleCornerBgColor(pixelData, width, height);
    expect(bgColor).toEqual([255, 255, 255]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/pipeline/ocr/colorSampling.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/pipeline/ocr/colorSampling.ts

/**
 * Sobel 边缘检测 + 阈值过滤，取高梯度像素的颜色均值作为 fgColor。
 * 输入是裁剪后 quad 区域的 RGBA 像素数据。
 */
export function sampleEdgeColors(
  pixelData: Uint8ClampedArray,
  width: number,
  height: number
): [number, number, number] | null {
  if (width < 3 || height < 3) {
    return null;
  }

  // 计算 Sobel 梯度
  const gradientThreshold = 30;
  let rSum = 0, gSum = 0, bSum = 0, count = 0;

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      // Sobel Gx 和 Gy
      const idx = (y * width + x) * 4;
      const idxLeft = (y * width + (x - 1)) * 4;
      const idxRight = (y * width + (x + 1)) * 4;
      const idxUp = ((y - 1) * width + x) * 4;
      const idxDown = ((y + 1) * width + x) * 4;

      // 用灰度做梯度计算
      const grayCenter = grayAt(pixelData, idx);
      const grayLeft = grayAt(pixelData, idxLeft);
      const grayRight = grayAt(pixelData, idxRight);
      const grayUp = grayAt(pixelData, idxUp);
      const grayDown = grayAt(pixelData, idxDown);

      const gx = grayRight - grayLeft;
      const gy = grayDown - grayUp;
      const gradient = Math.sqrt(gx * gx + gy * gy);

      if (gradient >= gradientThreshold) {
        rSum += pixelData[idx];
        gSum += pixelData[idx + 1];
        bSum += pixelData[idx + 2];
        count++;
      }
    }
  }

  if (count === 0) {
    return null;
  }

  return [
    Math.round(rSum / count),
    Math.round(gSum / count),
    Math.round(bSum / count),
  ];
}

/**
 * 从四角像素采样 bgColor（角落通常是纯背景）。
 */
export function sampleCornerBgColor(
  pixelData: Uint8ClampedArray,
  width: number,
  height: number
): [number, number, number] {
  const corners = [
    0,                           // (0, 0)
    (width - 1) * 4,             // (width-1, 0)
    ((height - 1) * width) * 4,  // (0, height-1)
    ((height - 1) * width + width - 1) * 4, // (width-1, height-1)
  ];

  let rSum = 0, gSum = 0, bSum = 0;
  for (const idx of corners) {
    rSum += pixelData[idx];
    gSum += pixelData[idx + 1];
    bSum += pixelData[idx + 2];
  }

  return [
    Math.round(rSum / 4),
    Math.round(gSum / 4),
    Math.round(bSum / 4),
  ];
}

function grayAt(data: Uint8ClampedArray, idx: number): number {
  return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/pipeline/ocr/colorSampling.test.ts`
Expected: PASS

- [ ] **Step 5: 更新 provider.ts 的 fillMissingOcrFields**

修改 `fillMissingOcrFields`，接受 `image` 参数，使用边缘检测采样：

```typescript
// src/pipeline/ocr/provider.ts — 更新 fillMissingOcrFields
import { sampleEdgeColors, sampleCornerBgColor } from './colorSampling';

export function fillMissingOcrFields(
  results: OcrRecognizeResult[],
  image?: HTMLImageElement
): OcrRecognizeResult[] {
  return results.map(r => {
    let fgColor = r.fgColor;
    let bgColor = r.bgColor;

    if (!fgColor || !bgColor) {
      if (image) {
        const croppedPixels = cropQuadRegion(image, r.quad);
        if (croppedPixels) {
          if (!fgColor) {
            fgColor = sampleEdgeColors(croppedPixels.data, croppedPixels.width, croppedPixels.height) ?? [0, 0, 0];
          }
          if (!bgColor) {
            bgColor = sampleCornerBgColor(croppedPixels.data, croppedPixels.width, croppedPixels.height);
          }
        } else {
          fgColor = fgColor ?? [0, 0, 0];
          bgColor = bgColor ?? [255, 255, 255];
        }
      } else {
        fgColor = fgColor ?? [0, 0, 0];
        bgColor = bgColor ?? [255, 255, 255];
      }
    }

    return {
      ...r,
      direction: r.direction ?? inferDirectionFromQuad(r.quad),
      fgColor,
      bgColor,
    };
  });
}

function cropQuadRegion(
  image: HTMLImageElement,
  quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint]
): { data: Uint8ClampedArray; width: number; height: number } | null {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const xs = quad.map(p => p.x);
  const ys = quad.map(p => p.y);
  const minX = Math.floor(Math.min(...xs));
  const minY = Math.floor(Math.min(...ys));
  const maxX = Math.ceil(Math.max(...xs));
  const maxY = Math.ceil(Math.max(...ys));
  const width = maxX - minX;
  const height = maxY - minY;

  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(image, minX, minY, width, height, 0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);
  return { data: imageData.data, width, height };
}
```

- [ ] **Step 6: 运行所有 OCR 测试确认通过**

Run: `npx vitest run tests/pipeline/ocr/`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/ocr/colorSampling.ts src/pipeline/ocr/provider.ts tests/pipeline/ocr/colorSampling.test.ts
git commit -m "feat: 边缘检测颜色采样，fillMissingOcrFields 使用图像采样补全颜色"
```

---

### Task 4: 设置页面增加 OCR 引擎选项

**Files:**
- Modify: `src/shared/config.ts`
- Modify: `src/types.ts`
- Modify: `src/popup/App.tsx`

- [ ] **Step 1: 修改 ExtensionSettings 类型**

在 `src/shared/config.ts` 中：

1. 增加 `OcrEngine` 类型：
```typescript
export type OcrEngine = 'builtin' | 'paddleocr';
```

2. 在 `ExtensionSettings` 类型中增加 `ocrEngine` 字段：
```typescript
export type ExtensionSettings = {
  ...existing fields...
  ocrEngine: OcrEngine;
};
```

3. 在 `defaultExtensionSettings` 中增加默认值：
```typescript
export const defaultExtensionSettings: ExtensionSettings = {
  ...existing defaults...
  ocrEngine: 'builtin',
};
```

4. 在 `normalizeSettings` 中增加 `ocrEngine` 的归一化：
```typescript
function normalizeOcrEngine(value: unknown): OcrEngine {
  if (value === 'paddleocr') return 'paddleocr';
  return 'builtin';
}
```

5. 在 `toPipelineConfig` 中传入 `ocrEngine`：
```typescript
export function toPipelineConfig(settings: ExtensionSettings): PipelineConfig {
  return {
    ...existing fields...
    ocrEngine: settings.ocrEngine,
  };
}
```

- [ ] **Step 2: 修改 PipelineConfig 类型**

在 `src/types.ts` 中增加：
```typescript
export type PipelineConfig = {
  ...existing fields...
  ocrEngine: 'builtin' | 'paddleocr';
};
```

- [ ] **Step 3: 修改 Popup UI**

在 `src/popup/App.tsx` 中，在"翻译服务"panel 后面增加一个" OCR 引擎"panel：

```tsx
<section className="panel">
  <div className="radio-group">
    <span>OCR 引擎</span>
    <label className="radio-row">
      <input
        type="radio"
        name="ocrEngine"
        value="builtin"
        checked={settings.ocrEngine === 'builtin'}
        onChange={() => updateField('ocrEngine', 'builtin')}
        disabled={loading}
      />
      <span className="radio-label">内置模型</span>
    </label>
    <label className="radio-row">
      <input
        type="radio"
        name="ocrEngine"
        value="paddleocr"
        checked={settings.ocrEngine === 'paddleocr'}
        onChange={() => updateField('ocrEngine', 'paddleocr')}
        disabled={loading}
      />
      <span className="radio-label">PaddleOCR</span>
    </label>
  </div>
</section>
```

- [ ] **Step 4: 运行构建确认不报错**

Run: `npm run build`
Expected: 构建成功，无 TypeScript 错误

- [ ] **Step 5: Commit**

```bash
git add src/shared/config.ts src/types.ts src/popup/App.tsx
git commit -m "feat: 设置页面增加 OCR 引擎单选按钮（内置/PaddleOCR）"
```

---

### Task 5: 将 ocrEngine 传入 pipeline

**Files:**
- Modify: `src/pipeline/orchestrator.ts`
- Modify: `src/content/core/TranslatorCore.ts`（如果需要）

- [ ] **Step 1: 修改 orchestrator 使用 ocrEngine**

在 `src/pipeline/orchestrator.ts` 的 `runPipeline` 函数中，将 `config.ocrEngine` 传入 `runOcr`：

```typescript
const ocrResult = await runOcr(image, latestRegions, config.ocrEngine);
```

确认 TranslatorCore 调用链路正确传递 PipelineConfig（当前已通过 `toPipelineConfig` 转换，应该自动包含 `ocrEngine`）。

- [ ] **Step 2: 运行构建确认**

Run: `npm run build`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/orchestrator.ts
git commit -m "feat: orchestrator 传入 ocrEngine 配置给 runOcr"
```

---

### Task 6: PaddleOCR 模型配置和预处理

**Files:**
- Modify: `public/models/models.json`
- Create: `src/pipeline/ocr/paddleocrPreprocess.ts`
- Modify: `src/runtime/modelRegistry.ts`

- [ ] **Step 1: 增加 PaddleOCR 模型配置**

在 `public/models/models.json` 中增加 paddleocr_rec 模型配置：

```json
{
  "paddleocr_rec": {
    "name": "paddleocr_rec",
    "task": "paddleocr-recognition",
    "url": "/models/paddleocr_v5_server_rec.onnx",
    "input": [48, 320],
    "runtime": ["webgpu", "webnn", "wasm"],
    "dictUrl": "/models/paddleocr_v5_dict.txt",
    "normalize": "minus_one_to_one"
  }
}
```

注意：实际模型文件和字典文件需要从 MeKo-Christian/paddleocr-onnx 下载并放入 `public/models/`。字典需要从 PaddleOCR PP-OCRv5 的配置中提取。这一步暂时用占位配置，后续下载模型文件后更新。

- [ ] **Step 2: 修改 modelRegistry 支持新模型名**

在 `src/runtime/modelRegistry.ts` 的 `getModel` 和 `getModelSession` 函数签名中，扩展 `name` 参数类型：

```typescript
export async function getModel(name: 'detector' | 'ocr' | 'inpaint' | 'bubble' | 'paddleocr_rec'): Promise<ManifestModel>
export async function getModelSession(name: 'detector' | 'ocr' | 'inpaint' | 'bubble' | 'paddleocr_rec', preferred?: RuntimeProvider[]): Promise<WorkerSessionHandle>
```

- [ ] **Step 3: 创建 PaddleOCR 预处理模块**

PaddleOCR 识别模型的预处理与自研模型不同。PP-OCRv5_rec 的输入通常是 `[3, 48, W]`，W 是动态宽度。

```typescript
// src/pipeline/ocr/paddleocrPreprocess.ts
import type { TextRegion, QuadPoint } from '../../types';

export type PaddleOcrInputData = {
  data: Float32Array;
  dims: number[];
  resizedWidth: number;
};

export function buildPaddleOcrInput(
  image: HTMLImageElement,
  region: TextRegion,
  inputHeight: number,
  maxInputWidth: number,
  normalize: 'zero_to_one' | 'minus_one_to_one'
): PaddleOcrInputData {
  // 1. 从 image 裁剪 region.box 区域
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const { x, y, width, height } = region.box;

  canvas.width = width;
  canvas.height = height;
  ctx.drawImage(image, x, y, width, height, 0, 0, width, height);

  // 2. Resize 到 inputHeight 高度，宽度按比例缩放（不超过 maxInputWidth）
  const ratio = inputHeight / height;
  const resizedWidth = Math.max(1, Math.min(maxInputWidth, Math.round(ratio * width)));

  const resizeCanvas = document.createElement('canvas');
  resizeCanvas.width = resizedWidth;
  resizeCanvas.height = inputHeight;
  const resizeCtx = resizeCanvas.getContext('2d')!;
  resizeCtx.drawImage(canvas, 0, 0, resizedWidth, inputHeight);

  // 3. 提取像素并归一化
  const imageData = resizeCtx.getImageData(0, 0, resizedWidth, inputHeight);
  const pixels = imageData.data;

  const floatData = new Float32Array(3 * inputHeight * resizedWidth);
  for (let i = 0; i < pixels.length / 4; i++) {
    const srcIdx = i * 4;
    const r = pixels[srcIdx];
    const g = pixels[srcIdx + 1];
    const b = pixels[srcIdx + 2];

    if (normalize === 'minus_one_to_one') {
      floatData[i] = r / 127.5 - 1;
      floatData[inputHeight * resizedWidth + i] = g / 127.5 - 1;
      floatData[2 * inputHeight * resizedWidth + i] = b / 127.5 - 1;
    } else {
      floatData[i] = r / 255;
      floatData[inputHeight * resizedWidth + i] = g / 255;
      floatData[2 * inputHeight * resizedWidth + i] = b / 255;
    }
  }

  return {
    data: floatData,
    dims: [1, 3, inputHeight, resizedWidth],
    resizedWidth,
  };
}
```

- [ ] **Step 4: 运行构建确认**

Run: `npm run build`
Expected: 构建成功

- [ ] **Step 5: Commit**

```bash
git add public/models/models.json src/runtime/modelRegistry.ts src/pipeline/ocr/paddleocrPreprocess.ts
git commit -m "feat: PaddleOCR 模型配置和预处理模块"
```

---

### Task 7: PaddleOCR CTC 解码

**Files:**
- Create: `src/pipeline/ocr/paddleocrDecode.ts`
- Test: `tests/pipeline/ocr/paddleocrDecode.test.ts`

PaddleOCR PP-OCRv5_rec 使用 CTC 解码（不是 AR），需要独立的 CTC 解码逻辑。

- [ ] **Step 1: 写失败的测试**

```typescript
// tests/pipeline/ocr/paddleocrDecode.test.ts
import { describe, it, expect } from 'vitest';
import { decodePaddleCtc } from '../../../src/pipeline/ocr/paddleocrDecode';

describe('decodePaddleCtc', () => {
  it('解码简单的 CTC 输出：重复合并 + blank 去除', () => {
    // 模拟 logits: 3 个时间步，5 个字符类 (blank + 4 chars)
    // blank=0, 'A'=1, 'B'=2, 'C'=3, 'D'=4
    const logits = new Float32Array([
      // t0: blank 0.8, A 0.1, B 0.05, C 0.03, D 0.02
      0.8, 0.1, 0.05, 0.03, 0.02,
      // t1: blank 0.1, A 0.8, B 0.05, C 0.03, D 0.02
      0.1, 0.8, 0.05, 0.03, 0.02,
      // t2: blank 0.1, A 0.05, B 0.8, C 0.03, D 0.02
      0.1, 0.05, 0.8, 0.03, 0.02,
    ]);
    const result = decodePaddleCtc(logits, 3, 5, ['blank', 'A', 'B', 'C', 'D']);
    expect(result.text).toBe('AB');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('连续相同字符不合并（blank 间隔应保留重复）', () => {
    // t0: A, t1: blank, t2: A → 结果应为 "AA"
    const logits = new Float32Array([
      0.1, 0.9, 0.0, 0.0, 0.0,  // t0: A
      0.9, 0.1, 0.0, 0.0, 0.0,  // t1: blank
      0.1, 0.9, 0.0, 0.0, 0.0,  // t2: A
    ]);
    const result = decodePaddleCtc(logits, 3, 5, ['blank', 'A', 'B', 'C', 'D']);
    expect(result.text).toBe('AA');
  });

  it('连续相同字符无 blank 间隔应合并', () => {
    // t0: A, t1: A → 合并为 "A"
    const logits = new Float32Array([
      0.1, 0.9, 0.0, 0.0, 0.0,
      0.1, 0.9, 0.0, 0.0, 0.0,
    ]);
    const result = decodePaddleCtc(logits, 2, 5, ['blank', 'A', 'B', 'C', 'D']);
    expect(result.text).toBe('A');
  });

  it('纯 blank 输出返回空字符串', () => {
    const logits = new Float32Array([
      0.9, 0.1, 0.0, 0.0, 0.0,
      0.9, 0.1, 0.0, 0.0, 0.0,
    ]);
    const result = decodePaddleCtc(logits, 2, 5, ['blank', 'A', 'B', 'C', 'D']);
    expect(result.text).toBe('');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/pipeline/ocr/paddleocrDecode.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: 写实现**

```typescript
// src/pipeline/ocr/paddleocrDecode.ts

export type PaddleCtcResult = {
  text: string;
  confidence: number;
  tokenIds: number[];
};

/**
 * PaddleOCR CTC greedy 解码。
 * logits 是 2D Float32Array，shape [timeSteps, numClasses]。
 * charset: 索引 0 是 blank，其余是字符。
 */
export function decodePaddleCtc(
  logits: Float32Array,
  timeSteps: number,
  numClasses: number,
  charset: string[]
): PaddleCtcResult {
  const tokenIds: number[] = [];
  const probs: number[] = [];
  let prevToken = -1;

  for (let t = 0; t < timeSteps; t++) {
    // 找每步最大概率的 token
    let maxIdx = 0;
    let maxProb = logits[t * numClasses];
    for (let c = 1; c < numClasses; c++) {
      const prob = logits[t * numClasses + c];
      if (prob > maxProb) {
        maxProb = prob;
        maxIdx = c;
      }
    }

    // CTC 规则：blank(0) 跳过，连续相同 token 无 blank 间隔则合并
    if (maxIdx === 0) {
      prevToken = -1; // blank 切断重复合并
      continue;
    }
    if (maxIdx === prevToken) {
      probs[probs.length - 1] = (probs[probs.length - 1] + maxProb) / 2;
      continue;
    }
    tokenIds.push(maxIdx);
    probs.push(maxProb);
    prevToken = maxIdx;
  }

  const text = tokenIds.map(id => charset[id] ?? '').join('');
  const confidence = probs.length > 0
    ? Math.exp(probs.reduce((sum, p) => sum + Math.log(Math.max(p, 1e-10)), 0) / probs.length)
    : 0;

  return { text, confidence, tokenIds };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/pipeline/ocr/paddleocrDecode.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/ocr/paddleocrDecode.ts tests/pipeline/ocr/paddleocrDecode.test.ts
git commit -m "feat: PaddleOCR CTC greedy 解码"
```

---

### Task 8: PaddleOCR Provider 实现

**Files:**
- Create: `src/pipeline/ocr/paddleocrProvider.ts`
- Modify: `src/workers/onnx-worker.ts`
- Modify: `src/runtime/onnxWorkerTypes.ts`
- Modify: `src/runtime/onnxWorkerBridge.ts`

- [ ] **Step 1: 创建 paddleocrProvider**

```typescript
// src/pipeline/ocr/paddleocrProvider.ts
import type { OcrProvider, OcrRecognizeResult } from './provider';
import type { TextRegion } from '../../types';
import { getModel, getModelSession } from '../../runtime/modelRegistry';
import { buildPaddleOcrInput } from './paddleocrPreprocess';
import { loadCharset } from './ocrShared';
import { decodePaddleCtc } from './paddleocrDecode';
import { runPaddleOcrInference } from '../../runtime/onnxWorkerBridge';

export const paddleocrProvider: OcrProvider = {
  name: 'paddleocr',
  async recognize(image: HTMLImageElement, regions: TextRegion[]): Promise<OcrRecognizeResult[]> {
    const model = await getModel('paddleocr_rec');
    const sessionHandle = await getModelSession('paddleocr_rec', model.runtime ?? ['webgpu', 'webnn', 'wasm']);
    const charset = await loadCharset(model.dictUrl);
    if (!charset) {
      throw new Error('PaddleOCR 字典加载失败');
    }

    const inputHeight = model.input[0];
    const inputWidth = model.input[1];
    const results: OcrRecognizeResult[] = [];

    for (const region of regions) {
      const inputData = buildPaddleOcrInput(
        image, region, inputHeight, inputWidth, model.normalize ?? 'minus_one_to_one'
      );

      // 通过 Worker 运行推理
      const logits = await runPaddleOcrInference(
        sessionHandle.sessionId,
        inputData.data,
        inputData.dims
      );

      // CTC 解码
      const timeSteps = inputData.resizedWidth; // PaddleOCR rec 输出长度与输入宽度相关
      const numClasses = charset.length;
      const decoded = decodePaddleCtc(logits, timeSteps, numClasses, charset);

      if (decoded.confidence < 0.2 || decoded.text.trim() === '') {
        continue;
      }

      results.push({
        text: decoded.text,
        confidence: decoded.confidence,
        quad: region.quad ?? [
          { x: region.box.x, y: region.box.y },
          { x: region.box.x + region.box.width, y: region.box.y },
          { x: region.box.x + region.box.width, y: region.box.y + region.box.height },
          { x: region.box.x, y: region.box.y + region.box.height },
        ],
      });
    }

    return results;
  },
};
```

- [ ] **Step 2: 增加 Worker 推理支持**

在 `src/runtime/onnxWorkerTypes.ts` 中增加 PaddleOCR 推理类型。

在 `src/workers/onnx-worker.ts` 中增加 `runPaddleOcrInference` 函数：接受 sessionId + image tensor，运行 `session.run()`，返回 logits Float32Array。

在 `src/runtime/onnxWorkerBridge.ts` 中增加 `runPaddleOcrInference` 桥接函数。

- [ ] **Step 3: 在 runOcr 中注册 paddleocr provider**

在 `src/pipeline/ocr/index.ts` 中：

```typescript
import { paddleocrProvider } from './paddleocrProvider';
registerOcrProvider(paddleocrProvider);
```

- [ ] **Step 4: 运行构建确认**

Run: `npm run build`
Expected: 构建成功

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/ocr/paddleocrProvider.ts src/workers/onnx-worker.ts src/runtime/onnxWorkerTypes.ts src/runtime/onnxWorkerBridge.ts src/pipeline/ocr/index.ts
git commit -m "feat: PaddleOCR provider 完整实现（预处理+CTC解码+推理）"
```

---

### Task 9: 下载 PaddleOCR ONNX 模型文件

**Files:**
- Download: `public/models/paddleocr_v5_server_rec.onnx`
- Create: `public/models/paddleocr_v5_dict.txt`

- [ ] **Step 1: 从 MeKo-Christian/paddleocr-onnx 下载模型**

```bash
# 从 GitHub Release 下载 PP-OCRv5_server_rec ONNX 模型
wget -O public/models/paddleocr_v5_server_rec.onnx \
  https://github.com/MeKo-Christian/paddleocr-onnx/releases/download/v1.0.0/PP-OCRv5_server_rec.onnx
```

- [ ] **Step 2: 提取 PaddleOCR 字典文件**

PP-OCRv5_rec 的字典需要从 PaddleOCR 官方仓库获取。字典包含所有支持的字符（中文简繁、日文、英文等）。

```bash
# 从 PaddleOCR 官方获取 PP-OCRv5 字典
wget -O public/models/paddleocr_v5_dict.txt \
  https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/ppocr/utils/ppocr_keys_v1.txt
```

注意：具体字典文件名和 URL 需要根据 PP-OCRv5 的实际配置确认。可能需要使用 `ppocr_keys_v1.txt` 或更新的字典文件。

- [ ] **Step 3: 验证模型文件大小**

```bash
ls -lh public/models/paddleocr_v5_server_rec.onnx
wc -l public/models/paddleocr_v5_dict.txt
```

Expected: 模型约 84MB，字典数千行

- [ ] **Step 4: Commit**

```bash
git add public/models/paddleocr_v5_server_rec.onnx public/models/paddleocr_v5_dict.txt
git commit -m "chore: 下载 PaddleOCR PP-OCRv5_server_rec ONNX 模型和字典"
```

---

### Task 10: 集成测试

**Files:**
- Modify: 测试配置文件（如有）

- [ ] **Step 1: 手动测试 builtin 引擎**

使用内置模型运行完整 pipeline，确认行为与改动前完全一致。

- [ ] **Step 2: 手动测试 PaddleOCR 引擎**

1. 在设置中选择 PaddleOCR 引擎
2. 对漫画图片运行翻译
3. 验证：识别文字正确、颜色补全合理、排版渲染正常
4. 检查竖排文字方向推断是否正确

- [ ] **Step 3: 运行完整测试套件**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 4: Commit 最终状态**

```bash
git add -A
git commit -m "feat: OCR 层抽象 + PaddleOCR 引擎集成完成"
```