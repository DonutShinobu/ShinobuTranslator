# Component Guidelines

> How components are built in this project.

---

## Overview

This project has two completely different UI approaches depending on the context:

1. **Popup (React)**: The extension settings UI uses a single React function component with `useState`/`useEffect` hooks, styled with plain CSS.
2. **Content script (Imperative DOM)**: The in-page translation UI uses no React at all — pure `document.createElement` + class-based DOM manipulation, styled via injected `<style>` element with `mt-x-` prefixed classes.

**Do not introduce React into the content script.** Content scripts must remain imperative DOM because they run in the host page's DOM context where React's reconciliation would conflict with the page's own DOM.

---

## Component Structure

### Popup (React)

Single component file pattern — `App.tsx` contains everything:
```
export function App() {
  const [settings, setSettings] = useState<ExtensionSettings>(DEFAULT_SETTINGS);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ ... });
  // ... hooks and handlers inline
  return <div className="popup">...</div>;
}
```

No component splitting, no separate files per UI section. The popup is small enough to keep in one file.

### Content script (Imperative DOM)

Content UI 的公共入口是 `src/content/core/ui/index.ts`：

- `createUiElements()` — 组合图片按钮和卡片 DOM，返回 `UiElements`
- `renderUi(ui, state)` — 根据 `PhotoState` 更新 DOM
- `injectStyles()` — 从 `ui/styles.ts` 注入唯一一份 `mt-x-` 样式
- `createReadingModeBar()` — 组合 Pixiv 阅读模式全局控制条
- `createScreenshotOverlay()` — 组合截图选择与浮动结果 UI

具体 DOM 责任按 `imageControls.ts`、`cards.ts`、`readingModeBar.ts`、`screenshotOverlay.ts` 拆分；图标和样式分别位于 `icons.ts`、`styles.ts`。DOM 事件只调用 controller/core 回调，UI 模块不直接运行 pipeline 或管理持久状态。

---

## Props Conventions

- **Popup**: No props — `App` is the root component, receives nothing. If components are extracted in future, props should use TypeScript `type` (not `interface`), matching the project convention.
- **Content script**: No props concept — state is passed as plain objects to render functions: `renderUi(ui: UiElements, state: PhotoState | null): void`. 复杂 UI 工厂使用具名 options/callback 类型，不引用 `TranslatorCore` 实例。

---

## Styling Patterns

### Popup: Plain CSS
- Single CSS file: `src/popup/styles.css`, imported in `main.tsx`
- Class-based styling: `.popup`, `.panel`, `.checkbox-row`
- No CSS modules, no CSS-in-JS, no Tailwind, no styled-components

### Content script: Injected styles
- `ui/styles.ts` owns CSS text; `injectStyles()` idempotently creates a `<style>` element
- CSS classes use `mt-x-` prefix to avoid collisions with host page styles
- Some positioning uses inline `style.cssText` for computed values (e.g., button placement relative to image)

### Pipeline / Runtime / Shared modules: No UI
- These modules have no styling — they are pure TypeScript logic.

---

## Accessibility

- Popup: Basic HTML semantics (labels, checkboxes, buttons). No ARIA attributes currently.
- Content script: UI elements are overlay controls on manga images — accessibility is limited by nature of the use case (visual comic translation).

---

## Common Mistakes

1. **Using React in content scripts** — The content script runs in the host page DOM. React reconciliation would conflict with the page. Always use imperative DOM in `src/content/`.
2. **Using unprefixed CSS classes in content scripts** — Must use `mt-x-` prefix to avoid style collisions with host page CSS.
3. **把 Content UI 再聚合成单体文件** — 图片控件、卡片、阅读模式和截图浮层已按职责拆分；新增复杂交互应放入对应子模块，而不是恢复旧 `core/ui.ts`。
4. **Mutating DOM directly in popup** — The popup uses React. Don't use `document.createElement` or direct DOM mutation in popup code.
5. **在 UI 模块运行 pipeline** — pipeline 调用属于 `TranslationRunner`；状态生命周期属于 `PhotoStateStore`，UI 只创建/渲染 DOM 并上报事件。
