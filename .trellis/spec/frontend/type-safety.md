# Type Safety

> Type safety patterns in this project.

---

## Overview

TypeScript with strict mode (`tsconfig.json`: `"strict": true`, `"noUnusedLocals": true`, `"noUnusedParameters": true`, `"noFallthroughCasesInSwitch": true`). Target ES2022, module ESNext, jsx react-jsx.

---

## Type Organization

### Central shared types
`src/types.ts` — the "database" of core pipeline/domain types. Everything that's shared across layers lives here:
- `Rect`, `QuadPoint`, `TextDirection`, `TextRegion`
- `PipelineConfig`, `PipelineArtifacts`, `RuntimeStageStatus`
- `DetectOutput`, `OcrOutput`, `InpaintOutput`, `TypesetOutput`

### Layer-specific types
Each subdirectory has its own `types.ts` for types only used within that layer:
- `src/content/core/types.ts` — `PhotoState`, `PhotoViewStatus`, `SiteAdapter`, `MountedImage`
- `src/pipeline/*.ts` — Local types defined at the top of each stage file (not in separate files)
- `src/shared/messages.ts` — Message and response types inline in the same file

### Import pattern
- Use `import type { ... } from '...'` (not `import { type ... }`)
- Import from parent: `import type { ... } from '../../types'`
- Local types stay in the same file as the functions that use them

---

## Type vs Interface

**The project overwhelmingly uses `type`, not `interface`.**

- `src/types.ts`: Every definition uses `export type` (Rect, TextRegion, PipelineConfig, PipelineArtifacts, etc.)
- `src/shared/messages.ts`: All message/response types use `type`
- `src/pipeline/*.ts`: All local types use `type`
- `src/content/core/types.ts`: Most use `type`; only `SiteAdapter` and `ImageTarget` use `interface`

**When to use `interface`:** Only for contracts that external implementors must satisfy (like `SiteAdapter`). Everything else uses `type`.

**No `I` prefix on interfaces** — `SiteAdapter`, not `ISiteAdapter`.

---

## Common Patterns

### Union types for status enums
```
type PhotoViewStatus = 'idle' | 'running' | 'translated' | 'showingOriginal' | 'error';
```
Not numeric enums or string enums. Union types are preferred everywhere.

### Discriminated union for messages
```
type RuntimeMessage = GetSettingsMessage | SetSettingsMessage | DownloadImageMessage;
type RuntimeResponse = RuntimeSuccessResponse | RuntimeErrorResponse;
```
Discriminant field: `type` for messages, `ok` for responses (`ok: true | false`).

### Type guards
```
function isRuntimeMessage(value: unknown): value is RuntimeMessage { ... }
```
Only when runtime validation is needed (message deserialization). Not used for internal types.

### Custom error classes
```
class PipelineStageError extends Error {
  stage: string;
  artifacts: PipelineArtifacts;
}
class LlmColumnsParseError extends Error {
  rawContent: string;
}
```
Extended `Error` with extra context fields for debugging.

---

## Validation

No runtime validation library (no Zod, no Yup, no io-ts).

- **Internal types**: Trusted — no runtime validation. TypeScript compile-time checks are sufficient.
- **Chrome message boundary**: `isRuntimeMessage()` type guard validates the discriminant field. Not full schema validation.
- **LLM output parsing**: `LlmColumnsParseError` thrown on malformed responses. Handled in pipeline error flow.

---

## Forbidden Patterns

1. **`interface` for data types** — Use `type` for data/container types. Only use `interface` for contracts.
2. **Numeric enums** — Use string union types instead: `type Status = 'a' | 'b' | 'c'`.
3. **`any`** — Strict mode is enabled. Avoid `any`; use `unknown` + type guards if type is truly unknown.
4. **`import { type X }`** — Use `import type { X } from '...'` syntax instead.
5. **`I` prefix on interfaces** — Never use `ISiteAdapter`, just `SiteAdapter`.
6. **Runtime validation for internal types** — Internal function signatures are trusted. Only validate at system boundaries (Chrome messages, external API responses).