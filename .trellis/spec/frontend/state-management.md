# State Management

> How state is managed in this project.

---

## Overview

This project has **no external state management library** (no Redux, no Zustand, no React Context). Each layer manages state differently based on its runtime context:

1. **Popup (React)**: Local `useState` hooks
2. **Content script**: `PhotoStateStore` + controller-owned mutable `PhotoState`
3. **Background (service worker)**: Chrome `storage.local` API

---

## State Categories

### Local state (Popup)
- `useState<ExtensionSettings>` — extension settings, fetched from background on mount
- `useState<SaveStatus>` — feedback for save operations (saved/saving/error)
- `useState<boolean>` — loading state during initial settings fetch
- `useRef<boolean>` — hydration guard and save deduplication

### Per-image state (Content script)

- `PhotoStateStore` owns `Map<string, PhotoState>`、initial state、200-entry eviction 和 Blob URL 回收。
- `TranslatorCore.mounted` 只保存当前 DOM target/`UiElements`，不再兼任业务状态仓库。
- `TranslationRunner` 负责 pipeline 进度/结果 mutation；`ImageTranslationController`、`ReadingModeController`、`ScreenshotController` 负责各自交互状态。
- Mutable state 仍是刻意设计：`state.status = 'running'; state.stageText = '准备中';`，随后通过注入的 render callback 刷新 imperative DOM。
- 新建状态必须调用 `PhotoStateStore.ensure()`；删除/stop 必须调用 store 的 `delete()`/`dispose()`，由 store 统一 `URL.revokeObjectURL()`。

### Persistent state (Background)
- Chrome `storage.local` API for settings persistence
- No in-memory caching in background — reads from storage every time
- 底层由 `storage/chromeStorage.ts` 封装；`settingsStore`、`diagnostics/logStore` 等 service 拥有各自持久化语义

### Pipeline state
- `PipelineArtifacts` object, progressively enriched at each stage
- Passed through stages in `runPipeline()` — not stored globally
- Each stage reads from and writes to the same artifacts object

---

## When to Use Global State

Currently, there is no global state mechanism. Data flows through:

- **Chrome messages** (`sendRuntimeMessage` in `src/shared/messages.ts`) — between popup ↔ background ↔ content script
- **Direct function returns** — pipeline stages return data via `PipelineArtifacts`
- **Store/controller composition** — `TranslatorCore` 组合 `PhotoStateStore` 和控制器；控制器通过显式 callback 与 DOM 同步

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
4. **绕过 `PhotoStateStore` 创建或删除状态** — 会跳过 cache limit 和 Blob URL 回收。控制器可以 mutation `PhotoState`，但生命周期必须归 store。
5. **让 UI 模块持有业务状态** — `ui/` 只持有 DOM 引用与局部视觉状态；pipeline、阅读模式和截图流程由各自 controller/runner 管理。
