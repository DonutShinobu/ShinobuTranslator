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
│   │   └── utils.ts            # Utility helpers (formatDuration, downloadJson)
│   └── adapters/
│       ├── twitter.ts          # Twitter/X site adapter (implements SiteAdapter)
│       └── pixiv.ts            # Pixiv site adapter (implements SiteAdapter)
├── pipeline/
│   ├── orchestrator.ts         # Main pipeline coordinator (runPipeline)
│   ├── detect.ts               # Text detection (ONNX + Tesseract + heuristic)
│   ├── ocr.ts                  # OCR recognition (autoregressive + CTC)
│   ├── translate.ts            # Translation dispatcher
│   ├── inpaint.ts              # Inpainting (text removal from image)
│   ├── typeset.ts              # Typesetting/rendering translated text
│   ├── typesetGeometry.ts      # Typeset geometry calculations
│   ├── geometry.ts             # Shared geometry utilities
│   ├── bubbleDetect.ts         # Speech bubble detection
│   ├── maskRefinement.ts       # Mask refinement for inpainting
│   ├── readingOrder.ts         # Reading order sorting
│   ├── textlineMerge.ts        # Text line merging
│   ├── image.ts                # Image file/canvas helpers
│   ├── visualize.ts            # Debug visualization
│   └── bake.ts                 # Benchmark bake/render bridge
├── popup/
│   ├── App.tsx                 # React popup component (settings UI)
│   ├── main.tsx                # React entry point
│   └── styles.css              # Plain CSS for popup
├── runtime/
│   ├── onnx.ts                 # ONNX Runtime session management (WebNN/WebGPU/WASM)
│   ├── modelRegistry.ts        # Model manifest loading + session caching
│   └── selfCheck.ts            # Runtime self-diagnostic checks
├── shared/
│   ├── config.ts               # Extension settings types + normalization + defaults
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

### Adding a new site adapter
Create `src/content/adapters/<site>.ts`, implement the `SiteAdapter` interface (`match`, `findImages`, `createUiAnchor`, `applyImage`, `observe`), export as named const, and register in `src/content/index.ts`.

### Adding a new pipeline stage
Create `src/pipeline/<stage>.ts`, add its output type to `src/types.ts` if shared, and wire it into `orchestrator.ts`'s `runPipeline`.

### Adding a new translator
Create `src/translators/<translator>.ts`, implement the translate function signature, and register in `src/pipeline/translate.ts`.

### Adding a new popup setting
Add the field to `ExtensionSettings` in `src/shared/config.ts`, set a default in `DEFAULT_SETTINGS`, add UI in `src/popup/App.tsx`, and wire the save/load through `src/shared/messages.ts`.

---

## Naming Conventions

- **Files**: camelCase for multi-word modules (`textlineMerge.ts`, `maskRefinement.ts`, `bubbleDetect.ts`). Single-word files use lowercase (`detect.ts`, `ocr.ts`, `image.ts`).
- **Test files**: Colocated with source, `.test.ts` suffix (`geometry.test.ts`, `typesetGeometry.test.ts`).
- **Entry points**: Always `index.ts` (background, content, popup all use this pattern).
- **Types files**: `types.ts` at top-level and sub-level (`src/types.ts`, `src/content/core/types.ts`).
- **Adapters**: Named by site (`twitter.ts`, `pixiv.ts`), exported as `const <site>Adapter: SiteAdapter`.
- **CSS classes in content script**: `mt-x-` prefix (`mt-x-overlay-inline`, `mt-x-control`, `mt-x-status`).
- **CSS classes in popup**: No prefix, plain class names (`.popup`, `.panel`, `.checkbox-row`).
- **Chrome messages**: `mt:` prefix discriminant (`mt:get-settings`, `mt:set-settings`, `mt:download-image`).

---

## Examples

- Well-organized adapter module: `src/content/adapters/twitter.ts` — single responsibility, clear interface contract
- Well-organized pipeline stage: `src/pipeline/detect.ts` — pure functions, local types, imported into orchestrator
- Well-organized shared module: `src/shared/messages.ts` — discriminated union types, type guards, send/receive helpers