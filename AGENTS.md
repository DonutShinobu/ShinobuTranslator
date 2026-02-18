# AGENTS.md - ShinobuTranslator

## Project Overview

ShinobuTranslator is a browser extension that translates manga images on X/Twitter. The translation pipeline runs locally in the browser and includes text detection, OCR, translation, inpainting, and typesetting.

## Build Commands

```bash
npm run dev       # Vite development mode
npm run build     # TypeScript compile + Vite production build
npm run preview   # Preview production build
```

Additional check:

```bash
npx tsc --noEmit  # Type check only
```

## Current Code Structure

```text
src/
  background/
    index.ts            # Extension background service worker
  content/
    index.ts            # Content-script entry
    App.tsx             # Overlay UI and translation flow on X/Twitter image viewer
  popup/
    main.tsx            # Popup entry
    App.tsx             # Popup settings UI
    styles.css          # Popup styles
  pipeline/
    orchestrator.ts     # Pipeline orchestration and stage progress
    detect.ts           # Text detection
    ocr.ts              # OCR
    translate.ts        # Translation stage
    inpaint.ts          # Inpainting
    typeset.ts          # Typesetting and text rendering
    visualize.ts        # Debug visualizations
    maskRefinement.ts   # Mask refinement
    readingOrder.ts     # Reading order sorting
    textlineMerge.ts    # Text line merge utilities
    image.ts            # Image helpers
  runtime/
    onnx.ts             # ONNX runtime provider setup
    modelRegistry.ts    # Model loading and cache
    selfCheck.ts        # Runtime self checks
  translators/
    googleWeb.ts        # Google web translator
    llm.ts              # OpenAI-compatible LLM translator
  shared/
    config.ts           # Extension settings schema/defaults
    messages.ts         # Runtime message types/helpers
    chrome.ts           # Chrome API helpers
    assetUrl.ts         # Runtime asset URL helpers
  types.ts              # Shared pipeline and UI types

public/
  manifest.json         # Extension manifest (MV3)
  models/manifest.json  # Model registry for runtime
  models/*              # ONNX models and OCR dictionary
  ort/*                 # onnxruntime-web wasm/webgpu assets
  fonts/*               # Embedded CJK font assets
```

## Development Notes

- Use `import type` for type-only imports.
- Prefer `type` over `interface` unless extension/inheritance is needed.
- Use `async/await`; avoid long `.then()` chains.
- Keep exported functions as function declarations when practical.
- Keep user-facing messages in Chinese.
- Follow strict TypeScript settings in `tsconfig.json`.

## Runtime and Models

- Runtime uses `onnxruntime-web` with provider fallback (WebNN/WebGPU/WASM depending on environment support).
- Register every model in `public/models/manifest.json` before usage.
- Load model sessions through `src/runtime/modelRegistry.ts`.

## Security Notes

- API keys are entered by users in popup settings at runtime.
- Never commit keys or secrets.
- Extension host permissions are defined in `public/manifest.json`.
