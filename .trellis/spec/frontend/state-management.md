# State Management

> How state is managed in this project.

---

## Overview

This project has **no external state management library** (no Redux, no Zustand, no React Context). Each layer manages state differently based on its runtime context:

1. **Popup (React)**: Local `useState` hooks
2. **Content script (TranslatorCore class)**: Private `Map` collections with direct mutation
3. **Background (service worker)**: Chrome `storage.local` API

---

## State Categories

### Local state (Popup)
- `useState<ExtensionSettings>` — extension settings, fetched from background on mount
- `useState<SaveStatus>` — feedback for save operations (saved/saving/error)
- `useState<boolean>` — loading state during initial settings fetch
- `useRef<boolean>` — hydration guard and save deduplication

### Per-image state (Content script)
- `private states = new Map<string, PhotoState>()` — keyed by image URL
- `private mounted = new Map<string, MountedImage>()` — UI references per image
- Direct mutation pattern: `state.status = 'running'; state.stageText = '准备中';`
- Manual cache eviction: `trimStateCache()` with 20-entry limit
- `URL.createObjectURL` / `URL.revokeObjectURL` lifecycle managed in `disposeState()`

### Persistent state (Background)
- Chrome `storage.local` API for settings persistence
- No in-memory caching in background — reads from storage every time
- Wrapped in `storageGet` / `storageSet` helper functions

### Pipeline state
- `PipelineArtifacts` object, progressively enriched at each stage
- Passed through stages in `runPipeline()` — not stored globally
- Each stage reads from and writes to the same artifacts object

---

## When to Use Global State

Currently, there is no global state mechanism. Data flows through:

- **Chrome messages** (`sendRuntimeMessage` in `src/shared/messages.ts`) — between popup ↔ background ↔ content script
- **Direct function returns** — pipeline stages return data via `PipelineArtifacts`
- **Class properties** — `TranslatorCore` holds state in private Maps

If global state becomes necessary (e.g., shared settings observable across components), use React Context, not an external library. The project has no Redux/Zustand dependency and shouldn't add one unless justified by complexity.

---

## Server State

This project doesn't have a traditional server. "Server state" maps to:

- **Chrome storage** — Settings are the closest analog to "server state". Fetched via `sendRuntimeMessage`, stored in `useState`, and auto-persisted back via `useEffect`.
- **Translation API responses** — Fetched by the pipeline at runtime, not cached. Each translation request is a fresh call.
- **Model weights** — ONNX models loaded via `modelRegistry.ts`, cached in `SessionHandle` objects with `Map<string, SessionHandle>`.

---

## Common Mistakes

1. **Adding Redux/Zustand** — The project's state is simple enough for `useState` + Chrome storage. Don't add a state management library.
2. **Making content script state immutable** — `PhotoState` is intentionally mutable (direct property assignment). Don't introduce immutability patterns there — it's a class-internal state, not React state.
3. **Caching everything in background memory** — The background service worker can be killed by Chrome at any time. Only use `storage.local` for persistence, not in-memory Maps.
4. **Forgetting `trimStateCache()`** — Content script accumulates per-image state. Without eviction, it will leak memory on long-scrolling pages. Always call `trimStateCache()` after disposing state.