# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

项目使用集中式 Vitest 测试，覆盖 background router/services、content store/controllers/UI、pipeline、runtime 契约、benchmark helper 和 shared message/config。当前没有 ESLint 或 Prettier；工程门禁由三套 TypeScript project、Vitest、Release build 和产物边界断言组成。提交前的标准命令是 `npm run check`。

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
10. **`Comlink.transfer()` on reusable input data** — Transferring detaches the sender's ArrayBuffer and breaks retries or later consumers. Use structured clone for reusable inputs; only transfer outputs or explicitly throwaway input copies.
11. **Direct import of onnxWorkerBridge or onnxNodeBridge from pipeline code** — Pipeline modules must import from `./onnxBridge`. Direct `onnxWorkerBridge` import pulls Comlink/Worker/DOM code into Node; direct `onnxNodeBridge` import leaks onnxruntime-node into the browser build.
12. **`require()` in browser-executed code** — `modelRegistry.ts` runs in both browser and Node. Use static `import` for browser-side modules like `resolveAssetUrl`. `require()` is undefined in the Chrome extension and will crash at runtime.
13. **Unexternalized Node-only dynamic imports in Vite config** — If a module is dynamically imported under `isNode`, Vite still resolves it and bundles it as a reachable chunk. Must add to `rollupOptions.external` to prevent leaking into the browser build.
14. **`preferredOutputLocation:"gpu-buffer"` on all WebGPU sessions** — Only apply `preferredOutputLocation:"gpu-buffer"` to sessions whose outputs are consumed via the GPU-preprocessed path. Other sessions' `tensorToTransport` reads `tensor.data` directly, which fails on GPU tensors ("The data is not on CPU"). Restrict by `modelKey`, not by provider.
15. **Omitting `platform` parameter in OCR provider calls** — `paddleocrProvider` uses `platform.createCanvas()`; always pass the Browser/Node platform through from the caller.
16. **Production imports of benchmark entry code** — `src/benchmark/browserEntry.ts` and `benchmark/` are benchmark-only. Content/background/popup must not import them or expose `window.__shinobuBenchmark__`.
17. **Legacy OCR domain RPC in the ONNX Worker** — Worker/Bridge must not regain AR batch/split/single decode or AR color RPC. Product OCR uses generic inference plus Paddle CTC on the caller side.

---

## Required Patterns

1. **`import type` syntax** — Always use `import type { X } from '...'`, not `import { type X }`.
2. **`type` over `interface`** — Use `type` for data types. Only use `interface` for contracts (like `SiteAdapter`).
3. **String union types for status** — `type Status = 'idle' | 'running' | 'done'`, not enum.
4. **`mt:` prefix for Chrome messages** — `mt:get-settings`, `mt:set-settings`, `mt:download-image`.
5. **`mt-x-` prefix for content script CSS** — All classes owned by `src/content/core/ui/styles.ts` and related UI modules.
6. **Discriminated union for messages** — `type` discriminant field for `RuntimeMessage`, `ok` for `RuntimeResponse`.
7. **Lazy pipeline loading** — Content script uses `import('../../pipeline/orchestrator')` only when user clicks translate. Don't load pipeline eagerly.
8. **`PhotoStateStore` for per-image lifecycle** — Create/delete state through the store so eviction and Blob URL cleanup cannot be skipped.
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

29. **Context-menu image overlays must keep a live image anchor until user manipulation** - For generic right-click image translation, pass the source `HTMLImageElement` through to the floating overlay path and keep the result host synchronized from `element.getBoundingClientRect()` plus scroll offsets while the overlay is still attached. Prefer the normal outside right-top/right-bottom pill placement whenever the source image top or bottom edge can support it. For images taller than the viewport where neither normal edge placement is reachable, place the pill inside the visible image area on the right side and recompute that fallback every sync: horizontal placement follows the visible image edge, while vertical placement sticks to the visible image area's top (usually viewport top) until normal outside placement becomes reachable. Use rAF-based tracking while attached because site viewers often pan images with CSS transforms that do not fire `scroll` or `ResizeObserver`. Once the user drags or wheel-zooms the floating result, detach from the source image but keep rAF tracking the result host itself; in manual result mode, avoid keeping the pill inside the image while an outside top position is approaching, prefer the viewport-clamped outside-top position, and lock the first reachable normal outside placement (`normal-top` or `normal-bottom`) so later movement does not fall back to sticky. Do not add a viewport-bottom-clamped fallback before `normal-bottom` is truly reachable, because it causes the pill to jump to the bottom inside the image. Mode transitions should enable CSS transition before writing the new overlay position and should animate with nonlinear easing plus duration derived from travel distance.

30. **Source-geometry vertical advance must correct quantization before wrapping** - When vertical typesetting uses source column geometry (`useDefaultAdvanceBase` / `sourceGeometryProfileUsed`), the target glyph advance comes from whole-column geometry. Apply a small quantization correction before integer rounding (`sourceGeometryAdvanceQuantizationBiasPx`) so per-glyph `Math.round` does not accumulate upward and force a source column to wrap. The target advance baseline must use real glyph count (`countTextGlyphs`), not weighted text length (`countTextLength`): the vertical layout loop advances once per glyph, so small kana/punctuation counted as half-width will overestimate available advance and can split a source column. Do not add a region-specific fallback that rewrites model/source column break behavior; tune the font-size and glyph-advance rules, then validate with `npm run bench:render` and `npm run bench`.

31. **Thin composition roots** — `src/background/index.ts` wires `BackgroundServices` into the router；`src/content/core/TranslatorCore.ts` wires store/controllers/UI。新增业务逻辑应进入具名 service/controller，而不是重新堆进入口。

32. **Release boundary assertion** — `npm run build` 必须运行 `check:artifacts`。修改 Vite entry、Content import graph、Worker API 或 benchmark bridge 时，同步更新 `scripts/check-release-boundaries.mjs` 与对应契约测试。

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

## Scenario: Translation Progress Animation Responsiveness

### 1. Scope / Trigger

- Trigger: changing content-script progress UI, pipeline progress reporting, or heavy pipeline stages that run while the pill/spinner is visible.
- Applies to `src/content/core/ui/`, `src/content/core/TranslatorCore.ts`, `src/content/core/progressJank.ts`, `src/pipeline/orchestrator.ts`, and pipeline stages that perform main-thread image/canvas work.

### 2. Signatures

- Progress jank reports must preserve the existing top-level frame/UI/stage fields and may add diagnostic fields:

```typescript
type ProgressJankReport = {
  observerSupport: ProgressJankObserverSupport;
  frame: ProgressJankFrameStats;
  workerHeartbeat: ProgressJankWorkerHeartbeatStats;
  longFrames: ProgressJankLongFrame[];
};
```

### 3. Contracts

- The progress pill must keep its dimensions, Chinese labels, running state semantics, and `mt-x-` CSS namespace.
- Diagnose before optimizing: capture `requestAnimationFrame`, Long Animation Frame, Long Task, UI render, worker roundtrip, and worker heartbeat data before changing detector/OCR/inpaint/typeset control flow.
- Worker heartbeat is diagnostic-only. Use it to distinguish main-thread rAF stalls from broader browser/GPU scheduling stalls; do not treat it as proof that animation isolation or pipeline changes are safe.
- Do not create full-size detection/OCR preview canvases during normal translation unless a visible feature or explicit debug output consumes them. Large `drawImage`/`getImageData`/`toBlob` work can produce long frames even when model inference is workerized.
- If LoAF/heartbeat data proves a specific main-thread loop is the cause, cooperative yielding or worker offload may be tried in a narrow follow-up diff. Do not introduce broad pipeline yielding as a first response.
- Treat WebGPU/worker boundaries as possible animation jank sources even when `longtask` counts are low. Long animation frames with low blocking duration can still make the spinner look choppy because rendering/compositing is delayed.

### 4. Validation & Error Matrix

| Condition | Symptom | Fix |
|-----------|---------|-----|
| Normal pipeline draws full-size intermediate debug canvases | OCR/detect boundaries show 100ms+ long tasks on large images | Skip default preview canvases or move debug rendering behind an explicit debug path |
| Main rAF is choppy but worker heartbeat is smooth | DOM/main-thread work is likely starving visual updates | Inspect the correlated LoAF scripts and main-thread task markers before choosing a narrow experiment |
| Main rAF and worker heartbeat are both choppy | Worker-only animation is unlikely to solve the root cause | Inspect WebGPU/ORT/browser scheduling and host-page/GPU contention |
| Worker calls show large output bytes and LoAFs with low blocking duration | Main-thread yielding does not fully fix spinner jank | Reduce worker payload, move postprocess into worker, or test provider/GPU contention |

### 5. Good/Base/Bad Cases

- Good: `[shinobu:jank]` shows UI render max under ~25ms and remaining spikes are attributed to specific stage/worker/canvas boundaries.
- Base: rAF p95 stays near a normal frame interval while occasional spikes are documented and tied to model/canvas boundaries.
- Bad: changing pill copy, disabling the spinner, or hiding animation to mask pipeline jank.
- Bad: adding more `setTimeout` animation logic in `renderUi()` while long frames come from WebGPU or full-size canvas work.

### 6. Tests Required

- Run `npx tsc --noEmit`.
- Run `npm run test`.
- Run `npm run build`.
- After content-script or worker-boundary changes, run `node --check dist/content.js`, `node --check dist/chunks/orchestrator.js`, `node --check dist/chunks/onnxWorkerBridge.js`, and `node --check dist/onnxWorker.js`.
- Run a real-browser pipeline smoke or hover/context-image UI smoke and inspect `[shinobu:jank]` for frame stats, stage stats, UI render stats, worker calls, and long tasks.

## Scenario: Nano Banana Full-Image Translation

### 1. Scope / Trigger

- Trigger: changing the Nano Banana/Gemini App image pipeline, popup provider UI, model selection, prompt handling, or image replacement behavior.
- Applies to `src/shared/config.ts`, `src/popup/App.tsx`, `src/content/core/TranslatorCore.ts`, `src/background/geminiAppClient.ts`, `src/shared/messages.ts`, and related tests.

### 2. Signatures

```typescript
type GeminiAppImageTranslateMessage = {
  type: 'mt:gemini-app-image-translate';
  image: {
    base64: string;
    contentType: string;
    filename: string;
  };
};

type GeminiApiImageTranslateMessage = {
  type: 'mt:gemini-api-image-translate';
  image: {
    base64: string;
    contentType: string;
    filename: string;
  };
};
```

### 3. Contracts

- The Gemini-backed LLM provider is labeled `Nano Banana` in the popup provider selector. Do not split Gemini App and official Gemini API into separate providers in the selector.
- Nano Banana exposes auth as a segmented control on the same provider: `Gemini 登录` maps to `llmProfiles.gemini.authMode === 'gemini_app'`, and `API Key` maps to `llmProfiles.gemini.authMode === 'api_key'`.
- `usesNanoBananaImagePipeline(settings)` is true for every `translator === 'llm' && llmProvider === 'gemini'` full-image path. `usesGeminiAppImagePipeline(settings)` is only the Gemini App/login path. `usesGeminiApiImagePipeline(settings)` is only the official API key path.
- Nano Banana has exactly one image translation path: full-image end-to-end translation.
- Popup may expose a Nano Banana model segmented control for supported Gemini App image models, currently `Nano Banana 2` and `Nano Banana Pro`.
- Popup shows the same Nano Banana model segmented control (`Nano Banana 2` / `Nano Banana Pro`) in both `gemini_app` and `api_key` auth modes.
- Popup shows Gemini App login status only in `gemini_app` auth mode.
- Popup shows the API Key field only in `api_key` auth mode.
- Do not add a full/local range toggle in popup settings.
- Popup caches the last successful Gemini App login check as a boolean UI hint only. Do not store cookies, tokens, or account identifiers.
- When the cached Gemini App status is unauthenticated and the user has selected Nano Banana with `gemini_app` auth mode, opening the popup auto-checks Gemini App login status once.
- When the cached Gemini App status is authenticated, opening the popup does not auto-check again; the user can refresh it with the explicit check button.
- Auto-check Gemini App login status only for `gemini_app` auth mode; API Key mode must not open or check Gemini App.
- The Nano Banana prompt field is labeled `提示词` and exposes a compact refresh icon button that resets it to `optimizedGeminiAppPromptTemplate`.
- The default Nano Banana prompt must constrain edits to dialogue text and sound-effect text, not all text-like regions broadly.
- Stage timing details must be locked off for Nano Banana because the web-app image path cannot provide reliable local stage details.
- Content sends the complete original image to Nano Banana and uses the returned image directly.
- Content must not run local text detection, bubble detection, OCR, local translation, mask compositing, transparent overlay generation, or paste-back logic for Nano Banana.
- The background prompt is always `geminiAppPromptTemplate` with `{targetLang}` replacement for both Gemini App and Gemini API auth modes.
- Background model headers and returned metadata must reflect `geminiAppModel`; do not keep a hard-coded Pro label when `Nano Banana 2` is selected.
- Official API mode maps the shared Nano Banana model selection to official model ids before sending `generateContent`: `Nano Banana 2` -> `gemini-3.1-flash-image`, `Nano Banana Pro` -> `gemini-3-pro-image`. It uses `x-goog-api-key`, passes the original image as `inlineData`, and extracts the first returned `inlineData` image.
- Reading-mode batch translation remains blocked for Nano Banana unless explicit rate limiting and user confirmation are added.

### 4. Validation & Error Matrix

| Condition | Required behavior |
|-----------|-------------------|
| Prompt template normalizes to blank | `validateSettings()` returns a Chinese Gemini prompt error |
| Nano Banana auth mode is `api_key` and API key is blank | `validateSettings()` returns a Chinese Nano Banana API Key error |
| Nano Banana auth mode is `api_key` | Content sends `mt:gemini-api-image-translate`; background must not call Gemini App auth/status/upload endpoints |
| Nano Banana auth mode is `gemini_app` | Content sends `mt:gemini-app-image-translate`; popup may show login status and login/check actions |
| User selects Nano Banana 2 in API Key mode | Background calls `gemini-3.1-flash-image` and metadata labels the run as `Nano Banana API / Nano Banana 2` |
| User selects Nano Banana Pro in API Key mode | Background calls `gemini-3-pro-image` and metadata labels the run as `Nano Banana API / Nano Banana Pro` |
| Gemini message fails or returns no image | Content surfaces the Chinese background error and preserves the original image |
| User selects Nano Banana in reading-mode batch | Content rejects the run with a Chinese single-image/other-provider hint |
| User selects Nano Banana 2 | Background does not send the Pro-only model header and metadata labels the run as Nano Banana 2 |
| User selects Nano Banana Pro | Background sends the Pro model header and metadata labels the run as Nano Banana Pro |
| User selects Nano Banana with saved stage details enabled | Settings normalization and popup UI force stage details off |
| User opens popup on Nano Banana with cached unauthenticated status | Popup checks Gemini App login status once |
| User opens popup on Nano Banana with cached authenticated status | The login-status row shows `Gemini已登录` without checking again; the top save/status bubble does not show that label |
| User switches Nano Banana to API Key mode | Popup stops Gemini App login auto-checks and shows API Key/model fields instead |

### 5. Good/Base/Bad Cases

- Good: Nano Banana sends one complete source image request and displays the single complete translated image returned by Gemini, regardless of auth mode.
- Base: popup provider selection controls authentication, model selection, and prompt settings only; OCR engine and process mode are hidden and do not affect Nano Banana execution.
- Base: Gemini App and Gemini API are auth modes under the same `gemini` provider, not separate popup providers.
- Base: The UI uses product labels (`Nano Banana 2` / `Nano Banana Pro`); official API model ids stay in config/background mapping and tests.
- Bad: sending per-bubble crops or multiple requests for one image.
- Bad: adding local paste-back, crop compositing, transparent overlay, or OCR-assisted postprocessing to Nano Banana.
- Bad: letting OCR engine or process mode controls affect Nano Banana execution after the provider is selected.
- Bad: adding a second visible provider such as `Nano Banana Pro API` for official API access.
- Bad: exposing raw official API model ids as the primary Nano Banana model selector in popup.

### 6. Tests Required

- Add/update `tests/shared/config.test.ts` for Gemini prompt defaults, provider normalization, and model selection normalization.
- Add/update `tests/shared/config.test.ts` for Nano Banana `gemini_app` vs `api_key` auth normalization and validation.
- Add/update `tests/shared/messages.test.ts` when new `mt:` messages are added.
- Add/update background pure-function tests for Gemini API `inlineData` extraction and error mapping.
- Run `npx tsc --noEmit`.
- Run `npm run test`.
- Run `npm run build`.
- After content-script changes, run `node --check dist/content.js`, `node --check dist/background.js`, `node --check dist/chunks/orchestrator.js`, `node --check dist/chunks/onnxWorkerBridge.js`, and `node --check dist/onnxWorker.js`.
- Run a browser smoke test when possible: select Nano Banana, choose each available model, log in, translate one manga image, and confirm the returned full image is displayed.

### 7. Wrong vs Correct

#### Wrong

```typescript
function buildPrompt(settings: ExtensionSettings): string {
  return settings.geminiAppPromptTemplate;
}
```

#### Correct

```typescript
const prompt = settings.geminiAppPromptTemplate.replace(/\{targetLang\}/g, targetLanguageLabel(settings.targetLang));
const requestImageBase64 = await blobToBase64(originalFile);
const finalBlob = returnedBlob;
```

## Scenario: Diagnostic Log Export

### 1. Scope / Trigger

- Trigger: changing diagnostic logging, popup log download UI, background log storage/export, or `mt:diagnostic-log-*` messages.
- Applies to `src/shared/diagnosticLog.ts`, `src/shared/diagnosticLogClient.ts`, `src/shared/messages.ts`, `src/background/index.ts`, `src/popup/App.tsx`, and diagnostic tests.

### 2. Signatures

```typescript
type DiagnosticLogEvent = {
  id: string;
  sessionId: string;
  runId?: string;
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  category: 'app.config' | 'runtime.message' | 'pipeline.stage' | 'model.runtime' | 'pipeline.detect' | 'pipeline.ocr' | 'pipeline.inpaint' | 'pipeline.typeset' | 'llm.api' | 'image.io' | 'chrome.api' | 'ui.perf' | 'error';
  source: { context: 'popup' | 'content' | 'background' | 'worker'; module?: string };
  message: string;
  data?: Record<string, unknown>;
  error?: { name?: string; message: string; stack?: string; cause?: unknown };
};

type DiagnosticLogTextExport = {
  schemaVersion: 1;
  exportedAt: string;
  filenamePrefix: string;
  contentType: 'text/plain;charset=utf-8';
  eventCount: number;
  text: string;
};
```

### 3. Contracts

- Runtime collection uses structured `DiagnosticLogEvent` objects and persists them through `chrome.storage.local`; do not rely on background in-memory state for durability.
- Popup default download must be `.log` text from `DiagnosticLogTextExport.text`, not a JSON dump with a top-level `events` array.
- Text lines are generated from the same stored events and use the fixed prefix `[time][level][context][runId][category] module | message details`.
- `event.data` and `event.error` may appear as compact one-line JSON at the end of a log line, but must pass through shared redaction/truncation first.
- Logging is best-effort. Logging failures must not break translation, image download, auth proxy, or popup settings.
- `enableDebugLog` gates detailed event persistence; the clear button removes the stored diagnostic log through `mt:diagnostic-log-clear`.

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| No stored events | Popup shows a Chinese “暂无可下载日志” status and does not download an empty file |
| Export requested while writes are pending | Background waits for the diagnostic write queue before reading storage |
| Storage contains more than the event limit | Oldest events are dropped, text export contains a truncation warning line |
| Event data contains API key/token/Authorization/cookie | Exported text contains `[REDACTED]`, never the secret |
| Event data contains image data URL | Exported text contains `[IMAGE_DATA_URL_REDACTED:length]` |
| LLM fetch fails before HTTP status | `llm.api` line includes provider, endpoint, duration/classification if available, and `error="Failed to fetch"` |
| Persisted event is missing `timestamp` | Text export must not throw; line formatter uses `unknown-time` or a normalized fallback |

### 5. Good/Base/Bad Cases

- Good: popup downloads `shinobu-diagnostic-log-<timestamp>.log` with readable lines and compact JSON details.
- Good: internal storage keeps structured events so export formatting can evolve without changing every producer.
- Base: `events` are not exposed in the default popup download, but every visible line is derived from them.
- Bad: every producer hand-builds free-form log strings, causing missing `runId`, inconsistent categories, or skipped redaction.
- Bad: popup downloads the raw diagnostic JSON object as the primary user-facing log.

### 6. Tests Required

- `tests/shared/diagnosticLog.test.ts` must cover readable line format, compact detail JSON, redaction, URL sanitization, and LLM fetch classification.
- `tests/shared/messages.test.ts` must cover every new `mt:diagnostic-log-*` discriminant and malformed diagnostic events.
- Run `npx tsc --noEmit --pretty false`, `npm run test -- --run`, and `npm run build` after changing export contracts.

### 7. Wrong vs Correct

#### Wrong

```typescript
downloadJson(response.log, 'shinobu-diagnostic-log');
```

#### Correct

```typescript
downloadText(response.log.text, response.log.filenamePrefix);
```

## Testing Requirements

### Framework: Vitest
- Configured in `package.json`: `"test": "vitest run"`
- Vitest currently includes only `tests/**/*.test.ts`. Put new tests under `tests/`, mirroring the source path (for example, `src/content/core/utils.ts` -> `tests/content/core/utils.test.ts`).
- Do not place new tests next to source files unless the Vitest include pattern is intentionally changed too; colocated `src/**/*.test.ts` files are type-checked by `tsc` but are not run by `npm run test`.

### Current test coverage
- `tests/background/` — message router 和 provider/settings/image/diagnostic service contract
- `tests/content/` — adapters、`PhotoStateStore`、translation/reading/screenshot controllers 和 UI helper
- `tests/pipeline/` — detect、OCR、translate、typeset、orchestrator 和纯算法
- `tests/runtime/` — Worker API、源码/产物禁用项与当前模型清单契约
- `tests/benchmark/` — metrics、source geometry、glyph quality 和颜色诊断 helper
- `tests/shared/`、`tests/translators/` — config/message/diagnostic 与 LLM contract

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
- **Composition roots** — 通过注入 fake services/controllers 测 router 和控制流，不在单测里启动真实 Chrome
- **Runtime/浏览器行为** — 单测固定静态契约；ONNX provider 和完整浏览器链路使用 `benchmark/perf` smoke/profile 验证

### Standard gate

- `npm run typecheck`：分别检查 app、tests、benchmark。
- `npm run test`：运行 `tests/**/*.test.ts`。
- `npm run build`：构建 Release、独立 Worker，并执行产物断言。
- `npm run check`：上述三项的标准串行门禁；CI 与本地收口都使用它。

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
- [ ] Per-image state goes through `PhotoStateStore`; Blob URLs are released on delete/dispose
- [ ] Background/Content entry points remain composition roots
- [ ] Release has no benchmark global/entry or legacy OCR Worker API

## Scenario: LLM 文本翻译列契约

### 1. Scope / Trigger

- 触发：修改 `src/translators/llm.ts`、`src/pipeline/translate.ts`、`src/pipeline/typeset/columns.ts`，或调整 LLM 文本翻译 prompt / JSON payload / `translatedColumns` 语义。
- 目标：竖排漫画文本必须先按完整语义翻成自然中文，再按最终排版拆列；不要把源 OCR 列当成逐列直译单元。

### 2. Signatures

```typescript
type LlmSourceTextPayload = {
  plainText: string;
  textWithBreaks: string;
  readingOrder: 'right-to-left' | 'top-to-bottom';
  columns?: Array<{ index: number; label: string; text: string }>;
  lines?: Array<{ index: number; label: string; text: string }>;
};

type LlmBatchResponse = {
  regions: Array<{
    id: string;
    translation: string;
    columns?: string[];
  }>;
};
```

### 3. Contracts

- `sourceText.plainText` 是去掉换行后的完整原文，用于语义理解，不代表最终分列。
- `sourceText.textWithBreaks` 保留 OCR/视觉换行，仅作为源断列/断行参考。
- `sourceText.readingOrder` 必须显式标注：竖排为 `right-to-left`，横排为 `top-to-bottom`。
- `sourceText.columns` / `sourceText.lines` 必须使用 `{ index, label, text }`，不要回退到 `{ "column1": "..." }` 这类动态 key 对象。
- LLM prompt 必须要求先生成自然中文完整译文，再按 `targetColumns` / `targetLines` 输出 `columns`。
- 返回的 `columns` 是最终排版分段，不要求逐列对应源 `columns`，但顺序必须是最终显示阅读顺序。
- 单框 fallback prompt 也必须强调自然中文语序和漫画本地化，避免批量失败后退回逐词直译。
- 整页 batch 失败或漏掉 region 时，`runTranslate()` 应先尝试单框结构化翻译；结构化 fallback 也失败后，才退回普通单框文本翻译。

### 4. Validation & Error Matrix

| Condition | Required behavior |
| --- | --- |
| LLM 返回无 `regions` | 抛出 `LlmColumnsParseError`，保留 raw response 供 debug |
| 单个 region 缺少有效 `translation` | 该 region 不计入 batch hit，`runTranslate()` 先走单框结构化 fallback |
| LLM 未返回 `columns` | 保留 `translation`，typeset 从换行或分段 fallback 推导 |
| `columns` 中含非字符串或空字符串 | 解析时过滤无效项，不污染 `translatedColumns` |
| 单框结构化 fallback 失败 | 退回普通单框文本翻译，`translatedColumns` 置空 |
| 译文超过源列长度 | `splitByTextLength()` 优先在中文标点/语气停顿/短语边界切分，再退回硬切 |

### 5. Good/Base/Bad Cases

- Good：竖排输入 `もう大丈夫\n泣くな` 先生成 `已经没事了，别哭。`，再返回 `["已经没事了，", "别哭。"]`。
- Good：整页 batch JSON 失败后，单个 region 的结构化 fallback 成功返回 `translation` 和 `columns`，最终保留 `translatedColumns`。
- Base：模型只返回 `translation`，排版层仍能用自然边界 fallback 分列。
- Bad：prompt 要求 `columns` “严格按 sourceText.columns 逐列翻译”，这会保留日语语序并破坏列间连贯性。
- Bad：fallback 只按最大字数切分中文，例如把 `别哭了，真的没事` 切成 `别哭了，真的` / `没事`。

### 6. Tests Required

- `tests/translators/llm.test.ts` 必须覆盖：
  - batch prompt 包含自然中文、跨列重组、排版分段等约束；
  - payload 包含 `plainText`、`textWithBreaks`、`readingOrder`、结构化 `columns` / `lines`；
  - fenced JSON response 能解析为 `translatedText` + `translatedColumns`；
  - 单框 fallback prompt 强调自然中文语序。
- `tests/pipeline/typeset/columns.test.ts` 必须覆盖中文标点和语气停顿优先分段。
- `tests/pipeline/translate.test.ts` 必须覆盖 batch 失败后的单框结构化 fallback，以及结构化 fallback 失败后的普通文本 fallback。
- 运行 `npx tsc --noEmit --pretty false` 和相关 Vitest；跨入口或 manifest 变化时再运行 `npm run build`。

### 7. Wrong vs Correct

#### Wrong

```typescript
content: 'direction=v 时，columns 必须严格按 sourceText.columns 的顺序返回（不得反转）。'
```

#### Correct

```typescript
content: 'direction=v 时，先写完整中文译文，再按 targetColumns 拆成 columns；columns 按最终竖排显示的阅读顺序返回。'
```
