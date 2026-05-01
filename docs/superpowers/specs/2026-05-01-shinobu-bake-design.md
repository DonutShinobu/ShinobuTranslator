# `__shinobu_bake__` Fixture Baking Entry Point

## Purpose

Provide a browser-side function that the Playwright-based `bake-fixtures.ts` script can call to run detect → OCR → typeset on a local image and return structured data for benchmark fixtures. Only vertical text regions are supported.

## Context

The typeset benchmark has two phases:

1. **Bake** (low frequency): run the full pipeline on test images, freeze the results as `.fixture.json`
2. **Bench** (high frequency): re-run typeset geometry with current code, compare against frozen fixtures

`bake-fixtures.ts` already exists and calls `window.__shinobu_bake__(dataUrl)`. This spec covers the implementation of that function.

## Pipeline

```
dataUrl: string
  → load as HTMLImageElement
  → detectTextRegionsWithMask(image)
  → runOcr(image, regions)
  → snapshot pre-merge regions (for ground truth)
  → mergeTextLines(regions, width, height)
  → sortRegionsForRender(regions, canvas)
  → set each region's translatedText = sourceText (skip translation)
  → drawTypeset(canvas, regions, 'ja', { debugMode: true, renderText: false, collectDebugLog: true })
  → assemble and return result
```

Key differences from the normal pipeline:
- No translation — `translatedText` is set to `sourceText`
- No inpainting/mask refinement — not needed for geometry benchmarking
- Typeset runs with `collectDebugLog: true` to capture `columnBoxes` and `fittedFontSize`
- Pre-merge regions are captured before `mergeTextLines` for ground truth

## Ground Truth Construction

Ground truth columns come from **pre-merge detector/OCR regions**. Each pre-merge region represents a single vertical text column as detected in the original image.

### Association: pre-merge → merged region

For each merged region, find all pre-merge regions whose bbox center point falls inside the merged region's box. This is simple and sufficient — edge cases where a center falls outside are not expected given how `mergeTextLines` builds its output box as a convex hull of inputs.

### `detectedColumns` shape (per merged region)

```typescript
Array<{
  centerX: number;   // preMergeBox.x + preMergeBox.width / 2
  topY: number;      // preMergeBox.y
  bottomY: number;   // preMergeBox.y + preMergeBox.height
  width: number;     // preMergeBox.width
  height: number;    // preMergeBox.height
  text: string;      // preMergeRegion.sourceText
  charCount: number; // [...preMergeRegion.sourceText].length
}>
```

## Typeset Debug Extraction

From `drawTypeset`'s `debugLog.regions`, match each merged region by `regionId` to extract:

```typescript
typesetDebug: {
  fittedFontSize: number;           // from TypesetDebugRegionLog.fittedFontSize
  columnBoxes: TypesetDebugColumnBox[];  // from TypesetDebugRegionLog.columnBoxes
}
```

## Return Value

```typescript
{
  imageWidth: number;
  imageHeight: number;
  regions: Array<{
    id: string;
    direction: "v";
    box: Rect;
    quad?: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
    sourceText: string;
    fontSize?: number;
    fgColor?: [number, number, number];
    bgColor?: [number, number, number];
    originalLineCount?: number;
    translatedColumns?: string[];
    detectedColumns: Array<{
      centerX: number;
      topY: number;
      bottomY: number;
      width: number;
      height: number;
      text: string;
      charCount: number;
    }>;
    typesetDebug: {
      fittedFontSize: number;
      columnBoxes: Array<{ x: number; y: number; width: number; height: number }>;
    };
  }>;
}
```

Only vertical regions (`direction === "v"`) are included. Horizontal regions are filtered out.

## File Structure

| File | Change |
|---|---|
| `src/pipeline/bake.ts` | New. Core `shinobuBake(dataUrl)` function |
| `src/content/index.ts` | Add: `import { shinobuBake } from '../pipeline/bake'; (window as any).__shinobu_bake__ = shinobuBake;` |

## Loading the Image

`shinobuBake` receives a base64 data URL. It creates an `HTMLImageElement`, sets `src` to the data URL, and waits for `onload`. This runs in the browser context (content script), so standard DOM APIs are available.

## Error Handling

- If detect or OCR throws, let the error propagate — `bake-fixtures.ts` will catch and log it
- If no vertical regions are found after filtering, return an empty `regions` array (not an error)

## Scope Exclusions

- Horizontal text regions
- Translation
- Inpainting / mask refinement
- Font registration (handled by the bench runner, not bake)
