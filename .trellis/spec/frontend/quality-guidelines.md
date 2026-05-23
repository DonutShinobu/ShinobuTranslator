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