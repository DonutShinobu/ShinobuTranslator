# Directory Structure

> How frontend code is organized in this project.

---

## Overview

This is a Chrome Manifest V3 browser extension for translating manga/comics on Twitter and Pixiv. The project has three separate entry points (content script, background service worker, popup UI) that share common code via Vite rollup chunks.

---

## Directory Layout

```
src/
├── types.ts                    # Central shared type definitions (pipeline domain types)
├── background/
│   └── index.ts                # Chrome extension background service worker entry
├── content/
│   ├── index.ts                # Content script entry (adapter selection + core init)
│   ├── core/
│   │   ├── TranslatorCore.ts   # Main translation lifecycle orchestrator (class-based)
│   │   ├── types.ts            # Content-script-specific types (PhotoState, SiteAdapter)
│   │   ├── ui.ts               # Imperative DOM UI rendering (no React)
│   │   └── utils.ts            # Utility helpers (re-exports toErrorMessage from shared)
│   └── adapters/
│       ├── twitter.ts          # Twitter/X site adapter (implements SiteAdapter)
│       └── pixiv.ts            # Pixiv site adapter (implements SiteAdapter)
├── pipeline/
│   ├── utils.ts                # Shared pipeline utilities (clamp, polygonArea, convexHull, nmsBoxes, rectIou, UnionFind, normalizeTextDeep/Light)
│   ├── orchestrator.ts         # Main pipeline coordinator (runPipeline)
│   ├── detect/                 # Text detection (ONNX + Tesseract + heuristic)
│   │   ├── index.ts            #   Entry: detectTextRegionsWithMask, DetectOutput
│   │   ├── onnxDetect.ts       #   ONNX detection + shared helpers (connectedComponents, mergeRects, makeRegion)
│   │   └── heuristicDetect.ts  #   Tesseract + heuristic fallback
│   ├── ocr/                    # OCR recognition (autoregressive + CTC)
│   │   ├── index.ts            #   Entry: runOcr, OcrResult
│   │   ├── decodeAutoregressive.ts  # Autoregressive beam search decoding
│   │   ├── decodeCtc.ts       #   CTC greedy decoding (fallback path)
│   │   ├── preprocess.ts       #   Perspective transform, region crop, direction inference
│   │   └── color.ts            #   Background/text color extraction
│   ├── translate.ts            # Translation dispatcher
│   ├── inpaint.ts              # Inpainting (text removal from image)
│   ├── typeset.ts              # Typesetting/rendering translated text
│   ├── typeset/                # Typeset geometry calculations (merged old geometry.ts)
│   │   ├── index.ts            #   Entry: computeFullVerticalTypeset, re-exports
│   │   ├── geometry.ts         #   Quad ops, convexHull (re-export), sortMiniBoxPoints, minAreaRect
│   │   ├── columns.ts          #   Column logic, rebalancing, kinsoku (禁則)
│   │   ├── fontFit.ts          #   Font size search, canvas measurement, layout
│   │   └── color.ts            #   Color science, contrast, color selection
│   ├── bubbleDetect.ts         # Speech bubble detection
│   ├── maskRefinement/         # Mask refinement for inpainting
│   │   ├── index.ts            #   Entry: refineTextMask
│   │   └── algorithms.ts       #   Otsu, dilate, polygon clipping, connected components
│   ├── readingOrder.ts         # Reading order sorting
│   ├── textlineMerge/          # Text line merging
│   │   ├── index.ts            #   Entry: mergeTextLines
│   │   └── mergePredicates.ts  #   Merge predicates, MST splitting, InternalQuad types
│   ├── image.ts                # Image file/canvas helpers
│   ├── visualize.ts            # Debug visualization
│   └── bake.ts                 # Benchmark bake/render bridge
├── popup/
│   ├── App.tsx                 # React popup component (settings UI)
│   ├── main.tsx                # React entry point
│   └── styles.css              # Plain CSS for popup
├── workers/
│   └── onnx-worker.ts       # ONNX inference Worker entry (comlink + onnxruntime-web)
├── runtime/
│   ├── onnx.ts                 # ONNX Runtime session management (WebNN/WebGPU/WASM)
│   ├── modelRegistry.ts        # Model manifest loading + session caching
│   └── selfCheck.ts            # Runtime self-diagnostic checks
├── shared/
│   ├── utils.ts                # Global shared utilities (toErrorMessage)
│   ├── config.ts               # Extension settings types + normalization + defaults + LLM config
│   ├── messages.ts             # Chrome runtime message types + send/receive helpers
│   ├── chrome.ts               # Chrome API abstraction (getChromeApi/requireChromeApi)
│   └── assetUrl.ts             # Asset URL resolution (chrome.runtime.getURL polyfill)
└── translators/
    ├── googleWeb.ts             # Google Translate web API
    └── llm.ts                  # LLM batch/individual translation (DeepSeek, GLM, etc.)
```

Top-level files outside `src/`:

```
popup.html          # Popup HTML entry (<div id="root">)
vite.config.ts      # 3-entry rollup build + custom plugins
tsconfig.json       # strict mode, ES2022, react-jsx
public/
  manifest.json     # Chrome Manifest V3 extension manifest
scripts/
  benchmark/        # Benchmark infrastructure (bake, run, render, diff)
```

---

## Module Organization

### Adding a new Worker entry point
Create `src/workers/<name>-worker.ts`, import comlink + domain-specific libraries, define an API class with methods, call `Comlink.expose(apiInstance)` at the end. Add the entry to `vite.config.ts` `rollupOptions.input` as `'<name>Worker': resolve(__dirname, 'src/workers/<name>-worker.ts')`. Add `'<name>Worker.js'` to `web_accessible_resources` in `public/manifest.json`. On the main thread, create the Worker via `new Worker(chrome.runtime.getURL('<name>Worker.js'))` and wrap with `Comlink.wrap<ApiType>(worker)`.

### Adding a new site adapter
Create `src/content/adapters/<site>.ts`, implement the `SiteAdapter` interface (`match`, `findImages`, `createUiAnchor`, `applyImage`, `observe`), export as named const, and register in `src/content/index.ts`.

### Adding a new pipeline stage
Create `src/pipeline/<stage>.ts` (or `src/pipeline/<stage>/index.ts` for complex stages), add its output type to `src/types.ts` if shared, and wire it into `orchestrator.ts`'s `runPipeline`.

### Adding a sub-module to an existing pipeline stage
When a pipeline module grows beyond ~500 lines, split it into a sub-directory with `index.ts` as the public entry. Internal sub-modules are named by responsibility (e.g., `decodeAutoregressive.ts`, `algorithms.ts`). The `index.ts` re-exports the public API so external imports (`from "../pipeline/ocr"`) remain unchanged.

### Adding a new translator
Create `src/translators/<translator>.ts`, implement the translate function signature, and register in `src/pipeline/translate.ts`.

### Adding a new popup setting
Add the field to `ExtensionSettings` in `src/shared/config.ts`, set a default in `DEFAULT_SETTINGS`, add UI in `src/popup/App.tsx`, and wire the save/load through `src/shared/messages.ts`.

### Adding a shared utility function
- **Globally shared** (used across pipeline/runtime/content/background): `src/shared/utils.ts`
- **Pipeline-specific** (used across pipeline modules): `src/pipeline/utils.ts`
- **Module-internal** (used only within one sub-directory): keep in the relevant sub-module file

---

## Naming Conventions

- **Files**: camelCase for multi-word modules. Single-word files use lowercase (`detect/`, `ocr/`, `image.ts`).
- **Sub-directories**: Named by pipeline stage (`detect/`, `ocr/`, `typeset/`). Entry point is always `index.ts`.
- **Test files**: Colocated with source, `.test.ts` suffix (`geometry.test.ts`, `typesetGeometry.test.ts`).
- **Entry points**: Always `index.ts` (background, content, popup, and pipeline sub-directories all use this pattern). Workers use `<name>-worker.ts`.
- **Worker files**: Named `<name>-worker.ts` in `src/workers/`, with corresponding `<name>Worker.ts` bridge and `<name>WorkerTypes.ts` transport types in `src/runtime/`.
- **Types files**: `types.ts` at top-level and sub-level (`src/types.ts`, `src/content/core/types.ts`).
- **Adapters**: Named by site (`twitter.ts`, `pixiv.ts`), exported as `const <site>Adapter: SiteAdapter`.
- **CSS classes in content script**: `mt-x-` prefix (`mt-x-overlay-inline`, `mt-x-control`, `mt-x-status`).
- **CSS classes in popup**: No prefix, plain class names (`.popup`, `.panel`, `.checkbox-row`).
- **Chrome messages**: `mt:` prefix discriminant (`mt:get-settings`, `mt:set-settings`, `mt:download-image`).

---

## Pipeline Sub-directory Convention

Pipeline modules follow a consistent pattern when split into sub-directories:

| Pattern | Description |
|---------|-------------|
| `index.ts` | Public API entry — re-exports main function + types |
| `*Detect.ts` / `*Decode.ts` / `*Algorithm.ts` | Core algorithm by strategy |
| `preprocess.ts` | Input transformation / preprocessing |
| `color.ts` | Color-related extraction / science |
| `geometry.ts` | Geometric operations (quad, hull, rect) |
| `algorithms.ts` | Shared algorithm-level functions |
| `mergePredicates.ts` | Predicates / matching / splitting logic |

External imports always target the directory (e.g., `from "../pipeline/detect"`) which resolves to `index.ts`.

---

## Shared Utilities Convention

| Location | Scope | Examples |
|----------|-------|---------|
| `src/shared/utils.ts` | All modules | `toErrorMessage` |
| `src/pipeline/utils.ts` | Pipeline modules only | `clamp`, `polygonArea`, `convexHull`, `nmsBoxes`, `rectIou`, `UnionFind`, `normalizeTextDeep`, `normalizeTextLight` |

**Rules:**
- Never duplicate a utility function across files. If it's used in 2+ files, extract to the appropriate utils file.
- `normalizeText` has two semantic variants: `normalizeTextDeep` (replaces newlines + collapses whitespace) and `normalizeTextLight` (trims only). Choose the one matching your use case.
- `connectedComponents` has 3 different return types across the codebase. Do NOT unify — each variant serves a different pipeline stage with different filtering/area semantics.

---

## Examples

- Well-organized sub-directory module: `src/pipeline/ocr/` — `index.ts` orchestrates, sub-modules by responsibility (decode, preprocess, color)
- Well-organized shared utility: `src/pipeline/utils.ts` — pure functions, no side effects, used across pipeline modules
- Well-organized adapter module: `src/content/adapters/twitter.ts` — single responsibility, clear interface contract
