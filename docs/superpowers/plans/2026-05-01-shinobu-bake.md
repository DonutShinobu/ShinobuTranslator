# `__shinobu_bake__` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `__shinobu_bake__` browser entry point so `bake-fixtures.ts` can generate benchmark fixtures from local images.

**Architecture:** A single new file `src/pipeline/bake.ts` exports `shinobuBake(dataUrl)` which runs detect → OCR → snapshot pre-merge regions → merge → sort → typeset (with sourceText as translatedText, debug mode on) → assembles result. `src/content/index.ts` mounts it on `window.__shinobu_bake__`.

**Tech Stack:** TypeScript, browser DOM APIs, existing pipeline functions (detect, OCR, merge, sort, typeset)

---

### File Map

| File | Change |
|---|---|
| `src/pipeline/bake.ts` | Create — `shinobuBake()` function and `BakeResultRegion`/`BakeResult` types |
| `src/content/index.ts` | Modify — mount `__shinobu_bake__` on `window` |

---

### Task 1: Create `src/pipeline/bake.ts`

**Files:**
- Create: `src/pipeline/bake.ts`

- [ ] **Step 1: Create bake.ts with types and full implementation**

```typescript
import type { TextRegion } from "../types";
import { imageToCanvas } from "./image";
import { detectTextRegionsWithMask } from "./detect";
import { runOcr } from "./ocr";
import { mergeTextLines } from "./textlineMerge";
import { sortRegionsForRender } from "./readingOrder";
import { drawTypeset } from "./typeset";

type DetectedColumn = {
  centerX: number;
  topY: number;
  bottomY: number;
  width: number;
  height: number;
  text: string;
  charCount: number;
};

type BakeResultRegion = {
  id: string;
  direction: "v";
  box: { x: number; y: number; width: number; height: number };
  quad?: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ];
  sourceText: string;
  fontSize?: number;
  fgColor?: [number, number, number];
  bgColor?: [number, number, number];
  originalLineCount?: number;
  translatedColumns?: string[];
  detectedColumns: DetectedColumn[];
  typesetDebug: {
    fittedFontSize: number;
    columnBoxes: Array<{ x: number; y: number; width: number; height: number }>;
  };
};

type BakeResult = {
  imageWidth: number;
  imageHeight: number;
  regions: BakeResultRegion[];
};

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image from data URL"));
    img.src = dataUrl;
  });
}

function centerInBox(
  inner: { x: number; y: number; width: number; height: number },
  outer: { x: number; y: number; width: number; height: number },
): boolean {
  const cx = inner.x + inner.width / 2;
  const cy = inner.y + inner.height / 2;
  return (
    cx >= outer.x &&
    cx <= outer.x + outer.width &&
    cy >= outer.y &&
    cy <= outer.y + outer.height
  );
}

function toDetectedColumn(region: TextRegion): DetectedColumn {
  return {
    centerX: region.box.x + region.box.width / 2,
    topY: region.box.y,
    bottomY: region.box.y + region.box.height,
    width: region.box.width,
    height: region.box.height,
    text: region.sourceText,
    charCount: [...region.sourceText].length,
  };
}

export async function shinobuBake(dataUrl: string): Promise<BakeResult> {
  const image = await loadImage(dataUrl);
  const canvas = imageToCanvas(image);
  const w = image.naturalWidth;
  const h = image.naturalHeight;

  const detected = await detectTextRegionsWithMask(image);
  const ocrResult = await runOcr(image, detected.regions);

  // Snapshot pre-merge regions for ground truth
  const preMergeRegions = ocrResult.regions.filter((r) => r.direction === "v");

  let regions = mergeTextLines(ocrResult.regions, w, h);
  regions = sortRegionsForRender(regions, canvas);

  // Skip translation: use sourceText as translatedText
  for (const r of regions) {
    r.translatedText = r.sourceText;
  }

  const typesetResult = await drawTypeset(canvas, regions, "ja", {
    debugMode: true,
    renderText: false,
    collectDebugLog: true,
  });

  const debugRegions = typesetResult.debugLog?.regions ?? [];

  const verticalRegions = regions.filter((r) => r.direction === "v");

  const resultRegions: BakeResultRegion[] = verticalRegions.map((merged) => {
    const detectedColumns = preMergeRegions
      .filter((pre) => centerInBox(pre.box, merged.box))
      .map(toDetectedColumn);

    const debugEntry = debugRegions.find((d) => d.regionId === merged.id);

    return {
      id: merged.id,
      direction: "v" as const,
      box: merged.box,
      quad: merged.quad,
      sourceText: merged.sourceText,
      fontSize: merged.fontSize,
      fgColor: merged.fgColor,
      bgColor: merged.bgColor,
      originalLineCount: merged.originalLineCount,
      translatedColumns: merged.translatedColumns,
      detectedColumns,
      typesetDebug: {
        fittedFontSize: debugEntry?.fittedFontSize ?? 0,
        columnBoxes: debugEntry?.columnBoxes ?? [],
      },
    };
  });

  return {
    imageWidth: w,
    imageHeight: h,
    regions: resultRegions,
  };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit src/pipeline/bake.ts`

If there are import resolution issues (depends on tsconfig), run the full project check instead:

Run: `npx tsc --noEmit`

Expected: no errors related to `src/pipeline/bake.ts`

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/bake.ts
git commit -m "feat(bench): add shinobuBake fixture baking function"
```

---

### Task 2: Mount on `window` in content script

**Files:**
- Modify: `src/content/index.ts`

- [ ] **Step 1: Add import and window mount**

Current content of `src/content/index.ts`:

```typescript
import { mountContentApp } from './App';

mountContentApp();
```

Change to:

```typescript
import { mountContentApp } from './App';
import { shinobuBake } from '../pipeline/bake';

(window as any).__shinobu_bake__ = shinobuBake;

mountContentApp();
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/content/index.ts
git commit -m "feat(bench): expose __shinobu_bake__ on window for fixture baking"
```

---

### Task 3: Build and smoke test

- [ ] **Step 1: Build the extension**

Run: `npm run build`

Expected: build succeeds with no errors

- [ ] **Step 2: Commit (if any build config changes were needed)**

Only if Task 3 Step 1 required changes. Otherwise skip.
