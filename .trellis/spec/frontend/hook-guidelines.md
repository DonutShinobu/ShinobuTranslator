# Hook Guidelines

> How hooks are used in this project.

---

## Overview

This project currently has **no custom hooks**. The popup (`App.tsx`) uses only built-in React hooks (`useState`, `useEffect`, `useRef`). The content script and pipeline are class-based or pure-function based — they don't use hooks at all.

---

## Custom Hook Patterns

No custom hooks exist yet. If custom hooks are added in the future:

- Use the `use` prefix naming convention (`useSettings`, `useTranslation`)
- Place hook files in `src/popup/hooks/` directory (create it when needed)
- Keep hooks focused on one concern — settings, data fetching, or UI state
- Prefer `useRef` for values that shouldn't trigger re-renders (see `hasHydratedRef` pattern in `App.tsx`)

---

## Data Fetching

The project does not use React Query, SWR, or any data-fetching library.

**Current pattern for Chrome extension data:**
- `useEffect` fires on mount to fetch settings from background via `sendRuntimeMessage`
- Results are stored in `useState`
- No caching layer — data is fetched fresh each time the popup opens

**Current pattern for pipeline data:**
- Pipeline runs in the content script, not in React
- Data flows through `PipelineArtifacts` object, progressively enriched by each stage
- No React state involvement in pipeline data flow

---

## Naming Conventions

- Built-in hooks: `useState`, `useEffect`, `useRef` — no custom naming needed
- If custom hooks are created: `use<Feature>` (e.g., `useSettings`, `useTranslationStatus`)
- State variables: `[value, setValue]` pattern — `const [settings, setSettings] = useState(...)`

---

## Key Patterns in App.tsx

1. **Hydration guard** — `useRef` tracks whether initial data has loaded, to avoid overwriting storage before hydration:
   ```
   const hasHydratedRef = useRef(false);
   // useEffect skips save when !hasHydratedRef.current
   ```

2. **Save deduplication** — `useRef` tracks latest save request to avoid duplicate saves:
   ```
   const saveRequestIdRef = useRef(0);
   // increments on each save request, only processes the latest
   ```

3. **Auto-save on change** — `useEffect` watches the `settings` state and persists back to Chrome storage after hydration.

---

## Common Mistakes

1. **Putting hooks in non-React code** — Hooks only work in React components. The content script (`TranslatorCore`) and pipeline modules are not React components.
2. **Over-engineering hooks for simple state** — If a piece of state is only used in one component, keep it as `useState` directly. Don't extract a custom hook for trivial cases.
3. **Using `useEffect` for synchronous Chrome API calls** — `sendRuntimeMessage` already returns a Promise. Use it directly in `useEffect` body, don't wrap in additional async patterns.