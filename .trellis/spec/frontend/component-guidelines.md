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

UI creation and rendering are in separate functions:
- `createUi()` — builds the DOM structure once, returns a `UiElements` object
- `renderUi(ui, state)` — imperatively updates DOM based on current state
- `injectStyles()` — injects a `<style>` element with all CSS rules

DOM elements are created with `document.createElement()`, not JSX. State updates are direct mutations: `state.status = 'running';`

---

## Props Conventions

- **Popup**: No props — `App` is the root component, receives nothing. If components are extracted in future, props should use TypeScript `type` (not `interface`), matching the project convention.
- **Content script**: No props concept — state is passed as plain objects to render functions: `renderUi(ui: UiElements, state: PhotoState | null): void`.

---

## Styling Patterns

### Popup: Plain CSS
- Single CSS file: `src/popup/styles.css`, imported in `main.tsx`
- Class-based styling: `.popup`, `.panel`, `.checkbox-row`
- No CSS modules, no CSS-in-JS, no Tailwind, no styled-components

### Content script: Injected styles
- `injectStyles()` creates a `<style>` element with all rules
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
3. **Adding component splitting prematurely** — The popup is intentionally kept as one file. Don't split unless the UI grows significantly.
4. **Mutating DOM directly in popup** — The popup uses React. Don't use `document.createElement` or direct DOM mutation in popup code.