# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

Testing is minimal (3 test files). Linting relies on TypeScript strict mode. No ESLint or Prettier configuration exists. Quality is enforced through TypeScript compiler checks and manual review.

---

## Forbidden Patterns

1. **React in content scripts** — Content scripts must use imperative DOM. React reconciliation conflicts with host page DOM.
2. **Unprefixed CSS in content scripts** — Must use `mt-x-` prefix to avoid host page style collisions.
3. **In-memory state in background service worker** — Chrome can kill the service worker at any time. Only `storage.local` for persistence.
4. **`any` type** — Use `unknown` + type guard instead.
5. **Numeric enums** — Use string union types.
6. **External state management libraries** — Don't add Redux/Zustand/MobX. `useState` + Chrome storage is sufficient.
7. **CSS-in-JS / Tailwind** — Use plain CSS files or injected `<style>` elements. No styled-components, no Tailwind.
8. **Adding runtime validation for internal types** — Trust TypeScript for internal code. Only validate at system boundaries.
9. **Long `.then()` chains** — Use async/await instead. `.then()` only for unavoidable Chrome API callback patterns.
10. **`Comlink.transfer()` on input data** — Never transfer input tensors/data to a Worker via `Comlink.transfer()`. Transfer detaches the ArrayBuffer on the sender side, making fallback paths and subsequent uses (e.g., OCR color decode after batch decode) send corrupted/empty data. Use structured clone (comlink default) for inputs; only use `Comlink.transfer()` for outputs where the sender doesn't need the data afterward.
11. **Direct import of onnxWorkerBridge or onnxNodeBridge from pipeline code** — Pipeline modules must import from `./onnxBridge`. Direct `onnxWorkerBridge` import pulls Comlink/Worker/DOM code into Node; direct `onnxNodeBridge` import leaks onnxruntime-node into the browser build.
12. **`require()` in browser-executed code** — `modelRegistry.ts` runs in both browser and Node. Use static `import` for browser-side modules like `resolveAssetUrl`. `require()` is undefined in the Chrome extension and will crash at runtime.
13. **Unexternalized Node-only dynamic imports in Vite config** — If a module is dynamically imported under `isNode`, Vite still resolves it and bundles it as a reachable chunk. Must add to `rollupOptions.external` to prevent leaking into the browser build.
14. **`preferredOutputLocation:"gpu-buffer"` on all WebGPU sessions** — Only apply `preferredOutputLocation:"gpu-buffer"` to sessions whose outputs are consumed via the GPU-preprocessed path. Other sessions' `tensorToTransport` reads `tensor.data` directly, which fails on GPU tensors ("The data is not on CPU"). Restrict by `modelKey`, not by provider.
15. **Omitting `platform` parameter in OCR provider calls** — `OcrProvider.recognize()` takes an optional `platform?: PlatformProvider`. Non-builtin providers (e.g., `paddleocrProvider`) call `platform.createCanvas()`, so passing `undefined` crashes. Always pass `platform` through from the caller.

---

## Required Patterns

1. **`import type` syntax** — Always use `import type { X } from '...'`, not `import { type X }`.
2. **`type` over `interface`** — Use `type` for data types. Only use `interface` for contracts (like `SiteAdapter`).
3. **String union types for status** — `type Status = 'idle' | 'running' | 'done'`, not enum.
4. **`mt:` prefix for Chrome messages** — `mt:get-settings`, `mt:set-settings`, `mt:download-image`.
5. **`mt-x-` prefix for content script CSS** — All classes in `src/content/core/ui.ts`.
6. **Discriminated union for messages** — `type` discriminant field for `RuntimeMessage`, `ok` for `RuntimeResponse`.
7. **Lazy pipeline loading** — Content script uses `import('../../pipeline/orchestrator')` only when user clicks translate. Don't load pipeline eagerly.
8. **`trimStateCache()` after dispose** — Prevent memory leaks on long-scrolling pages.
9. **`async/await` over `.then()` chains** — Use async/await for asynchronous code. `.then()` is acceptable only for Chrome API callbacks where async/await is impractical.
10. **Function declarations for exports** — Prefer `export function foo()` over `export const foo = ()`. Function declarations are hoisted and easier to trace.
11. **Chinese for user-facing messages** — Status text, labels, and error messages shown to users must be in Chinese.
12. **Shared utilities over duplication** — If a function is used in 2+ files, extract to `src/shared/utils.ts` (global) or `src/pipeline/utils.ts` (pipeline-specific). Never copy-paste utility functions across modules.
13. **Sub-directory for 500+ line modules** — When a pipeline module exceeds ~500 lines, split into a sub-directory with `index.ts` as the public API entry point.
14. **Domain-independent extraction for Worker separation** — When moving heavy computation (e.g., ONNX inference) into a Worker, extract domain-independent constants, types, and utility functions into a separate file (e.g., `ocrShared.ts`). This prevents Vite from bundling the heavy library (e.g., onnxruntime-web) into the main thread's shared chunk via transitive imports. The extraction file must NOT import the heavy library.

15. **Stable CSS selectors for external sites** — Pixiv uses hashed (`sc-xxx`) class names from styled-components that change every deployment. Only use GTM-prefixed classes (`.gtm-manga-viewer-*`, `.gtm-expand-full-size-illust`) or `data-*` attributes as selectors. Hashed classes are not forward-compatible.

16. **Dual-mode site adapters** — When a site has multiple viewing modes (e.g., Pixiv normal vs reading mode, `#1` hash), the adapter must detect the mode and the TranslatorCore must handle two distinct UI paths: per-image overlay (normal) and global bottom-bar UI (reading mode). The `findImages()` method should return empty for the "global UI" mode so no per-image overlays are created.

17. **Batch operation race-condition guard** — When running a batch operation (e.g., translate-all) that applies state changes and background sync runs (via MutationObserver), the sync handler must check a running flag to avoid overwriting the batch's newly-applied state. Example: `syncReadingMode` checks `translateAllRunning` to always show translated images during translate-all, regardless of `globalTranslateMode`.

18. **Virtual rendering requires URL-based discovery** — Sites with lazy-loaded/virtual-rendered images (only visible elements have real `<img>` tags) cannot use DOM-based image discovery for batch operations. Batch operations (e.g., translate-all) must construct URLs from a base pattern extracted from any visible link, not iterate `<img>` elements.

19. **Cache limits sized for maximum workload** — `photoStateCacheLimit` must be large enough for the maximum realistic workload (200 for Pixiv manga with 50+ pages). A limit smaller than the batch size causes `trimStateCache` to evict and `disposeState` to revoke blob URLs that are still displayed, resulting in broken images.

20. **PlatformProvider for cross-platform pipeline** — Pipeline code must NOT directly use `document.createElement("canvas")`, `new Image()`, `document.fonts.ready`, or `fetch()`. Instead, use `platform.createCanvas()`, `platform.createImage()`, `platform.waitForFonts()`, and the ONNX bridge via `onnxBridge.ts`. This ensures pipeline code works identically in browser (DOM) and Node (node-canvas + onnxruntime-node).

21. **Vite externalization for Node-only modules** — Any module that is dynamically imported under an `isNode` guard (e.g., `onnxruntime-node`, `onnxNodeBridge`) MUST be listed in `vite.config.ts` `rollupOptions.external`. Vite/Rollup still resolves and bundles reachable dynamic imports, producing an unwanted chunk (848KB for onnxNodeBridge) in the browser extension output. Externalization prevents this leak.

22. **node-canvas registerFont limitation** — `node-canvas`'s `registerFont()` only supports `.ttf`, `.otf`, and `.ttc` formats. It does NOT support `.woff2`. When running pipeline code in Node, you must have `.ttf` versions of fonts available (system fonts or separate font files). The browser path uses `.woff2` via CSS `@font-face`, which is unaffected.

23. **Conditional import via onnxBridge** — Pipeline code must import ONNX functions from `./onnxBridge`, not directly from `./onnxWorkerBridge` or `./onnxNodeBridge`. Direct imports of `onnxWorkerBridge` pull Comlink/Worker/DOM code into Node; direct imports of `onnxNodeBridge` pull onnxruntime-node into the browser build. The `onnxBridge` module uses `isNode` detection to dynamically import the correct bridge at runtime.

24. **Static imports for browser-side modules** — In `modelRegistry.ts`, `resolveAssetUrl` must be a static import (`import { resolveAssetUrl } from '../shared/assetUrl'`), not a `require()` call. `require` is undefined in the browser environment and will crash the Chrome extension. Node-specific imports (fs, path) use dynamic `await import()` since they're only called on the Node path.

25. **Floating screenshot overlay for generic translation** — Screenshot translation and generic context-menu translation must capture a `ScreenshotSelection` and render both original and translated images through the floating overlay UI. Do not replace arbitrary host `<img>`, background-image, canvas, or nested media DOM in the generic path; site adapters own DOM replacement only when the target layout is known and controlled. The overlay close button owns the pill and floating image lifecycle together, and the running state should show the original capture immediately so users can visually compare original vs translated output.

26. **Pure screenshot geometry helpers** — Keep screenshot element candidate ranking, wheel layer switching, viewport/crop conversion, move, and resize math in `src/content/core/screenshot.ts` as pure functions with Vitest coverage. `ui.ts` may read DOM rects and draw visual affordances, but the accepted `ScreenshotRect` stays rectangular in CSS pixels even when the selection border is visually rounded.

27. **Content-script import rewriting must parse bindings** - The Vite content-script compatibility plugin rewrites static ESM imports into classic-script-safe dynamic imports. Never rewrite named imports with a blanket text replacement like `bindings.replace(/\bas\b/g, ':')`: minification can legally produce a local identifier named `as`, turning `b as as` into invalid code such as `b : :`. Parse each binding into `{ imported, local }`, generate namespace property reads, and run `node --check dist/content.js` after build changes that touch the plugin or content-script import graph.

28. **Floating result controls must use CSS edge anchors during zoom animations** — When the floating screenshot/image result host animates `left/top/width/height`, overlay controls that should stay right-aligned or bottom-aligned must be positioned with CSS edge semantics such as `right: 0` or `top: calc(100% + 8px)`. Do not compute a one-time `left = targetWidth - controlWidth` from the final style width; that makes the pill drift during transitions because the visual host size is still animating.

## Scenario: Chrome Extension Shortcuts

### 1. Scope / Trigger

- Trigger: adding or changing browser-level extension shortcuts.
- Applies to `public/manifest.json`, `src/background/index.ts`, `src/shared/chrome.ts`, `src/shared/messages.ts`, `src/content/**`, and `src/popup/**`.

### 2. Signatures

- Manifest commands:
  ```json
  {
    "commands": {
      "command-name": {
        "suggested_key": { "default": "Alt+Q" },
        "description": "Chinese user-facing description"
      }
    }
  }
  ```
- Chrome API abstraction:
  ```typescript
  commands?: {
    getAll?: (callback: (commands: Array<{ name?: string; shortcut?: string }>) => void) => void;
    onCommand?: {
      addListener: (listener: (command: string, tab?: { id?: number }) => void) => void;
    };
  };
  ```
- Background-to-content messages must remain `mt:` discriminated unions, e.g. `{ type: 'mt:shortcut-translate-hover' }`.

### 3. Contracts

- Browser-level shortcuts are declared in `manifest.json` `commands`.
- Background listens to `chrome.commands.onCommand` and forwards to the triggering tab with `chrome.tabs.sendMessage`.
- Command forwarding is best-effort: if the tab id is missing or the content script is unavailable, ignore the failure.
- Popup reads the actual binding with `chrome.commands.getAll()` and opens `chrome://extensions/shortcuts` with `chrome.tabs.create()`.
- Popup must not present a fake editable shortcut input: Chrome does not allow extension pages to write browser-level command shortcuts.

### 4. Validation & Error Matrix

- `commands.getAll` missing -> popup shows a Chinese read error, no settings write.
- Command shortcut empty -> popup shows `未绑定` and a short warning that it may be occupied or cleared.
- `tabs.create` missing or errors -> popup status shows a Chinese error.
- `onCommand` receives an unknown command -> do nothing.
- Content target missing -> content script returns an error response and shows lightweight in-page feedback when user-triggered.

### 5. Good/Base/Bad Cases

- Good: manifest command, shared message type, background forwarder, content handler, popup status, and message guard test all use the same command/message names.
- Base: shortcut is registered and popup displays the actual `shortcut` returned by Chrome.
- Bad: popup saves an internal string such as `Alt+Q` and claims it changed the browser shortcut.

### 6. Tests Required

- Add or update `tests/shared/messages.test.ts` for every new `mt:` message discriminant.
- Run targeted tests for touched pure helpers and message guards.
- Run `npm run build` because manifest/background/content/popup changes cross entry points.

### 7. Wrong vs Correct

#### Wrong

```typescript
// Stores a value, but does not change Chrome's real command shortcut.
updateField('shortcut', 'Alt+Q');
```

#### Correct

```typescript
chrome.commands.getAll((commands) => {
  const shortcut = commands.find((command) => command.name === 'command-name')?.shortcut ?? '';
});
chrome.tabs.create({ url: 'chrome://extensions/shortcuts', active: true });
```

## Content Script Adapter Patterns

### SiteAdapter Optional Reading Mode Methods

When extending `SiteAdapter` for reading-mode-only features, use optional `?` methods so existing adapters (Twitter) are unaffected:

```typescript
export interface SiteAdapter {
  // Required methods (unchanged)
  match(): boolean;
  findImages(): ImageTarget[];
  createUiAnchor(target: ImageTarget): HTMLElement;
  applyImage(target: ImageTarget, url: string): void;
  observe(onChange: () => void): () => void;

  // Optional reading-mode methods — only implemented by Pixiv adapter
  isReadingMode?(): boolean;
  findAllPageUrls?(): UrlTarget[];
  getVisiblePages?(): ImageTarget[];
  getTotalPageCount?(): number;
  createBottomBarAnchor?(): HTMLElement | null;
  applyImageByKey?(key: string, url: string): void;
}
```

### Pixiv Bottom Bar Anchor Insertion

The reading mode bottom bar controls area has this structure:
```
controls-flex-container
  DIV (wraps direction toggle button)
    BUTTON.gtm-manga-viewer-change-direction
  BUTTON.gtm-manga-viewer-share-button
```

Insert translation buttons before the direction toggle wrapper:
```typescript
const directionToggle = document.querySelector('.gtm-manga-viewer-change-direction');
const wrapper = directionToggle.parentElement;
wrapper.before(anchor); // anchor appears to the LEFT of direction toggle
```

---

## Testing Requirements

### Framework: Vitest
- Configured in `package.json`: `"test": "vitest run"`
- Test files colocated with source: `*.test.ts` suffix

### Current test coverage
- `src/pipeline/geometry.test.ts` — Geometry utility functions (convexHull, sortMiniBoxPoints, minAreaRect — now imports from `./typeset/geometry`)
- `src/pipeline/typesetGeometry.test.ts` — Typeset geometry calculations (queryMaskMaxY — now imports from `./typeset/index`)
- `src/content/core/screenshot.test.ts` — Screenshot crop/viewport conversion, element candidate ordering, wheel layer switching, and move/resize geometry
- `benchmark/typeset/src/metrics.test.ts` — Benchmark metrics

### Test patterns
- Pure function testing — no DOM mocking, no React component testing
- `describe` blocks group by function name
- `it` blocks describe behavior in plain English
- Helper factories defined inside test files (e.g., `createMask()`, `createMockCtx()`)
- Standard vitest imports: `import { describe, it, expect } from "vitest"`

### What to test
- **Pipeline math/geometry functions** — Always test pure calculations
- **Message type guards** — Test `isRuntimeMessage()` with valid and invalid inputs
- **Pipeline stage outputs** — Test stage functions with controlled inputs when feasible
- **Don't test** Chrome extension integration, DOM rendering, or ONNX model inference (too environment-dependent)

---

## Code Review Checklist

- [ ] No `any` types — all types are explicit or properly narrowed
- [ ] Content script uses imperative DOM, not React
- [ ] CSS classes in content script have `mt-x-` prefix
- [ ] No state management library imports
- [ ] `import type` used for type-only imports
- [ ] `type` used for data types, `interface` only for contracts
- [ ] String unions for status types, not enums
- [ ] Background doesn't hold in-memory state that should persist
- [ ] Pipeline imports are lazy-loaded in content script
- [ ] No `Comlink.transfer()` on input data to Workers (only on outputs)
- [ ] Worker-extracted shared files don't import heavy libraries (e.g., onnxruntime-web)
- [ ] Memory cleanup: `trimStateCache()` / `URL.revokeObjectURL()` called where needed
