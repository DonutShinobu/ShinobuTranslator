# AGENTS.md - Manga Translate Web

## Project Overview

A browser-based manga translation pipeline that runs entirely in the frontend. The application performs text detection, OCR, translation, and inpainting using ONNX models with WebNN/WASM/WebGPU runtimes.

## Build Commands

```bash
npm run dev          # Start development server on port 5173
npm run build        # TypeScript compile + Vite build for production
npm run preview      # Preview production build locally
```

Note: No test framework or linter is currently configured. Run `npx tsc --noEmit` to type-check without building.

## Code Structure

```
src/
  main.tsx           # React entry point
  App.tsx            # Main UI component
  types.ts           # Shared type definitions
  pipeline/          # Processing pipeline stages
    orchestrator.ts  # Pipeline coordination and error handling
    detect.ts        # Text region detection (ONNX + Tesseract fallback)
    ocr.ts           # Optical character recognition
    translate.ts     # Translation orchestration
    inpaint.ts       # Text removal/inpainting
    typeset.ts       # Font rendering and layout
    visualize.ts     # Debug visualization
    maskRefinement.ts# Mask post-processing
    image.ts         # Image utilities
  runtime/           # ONNX runtime management
    onnx.ts          # Session creation, provider detection
    modelRegistry.ts # Model manifest and caching
    selfCheck.ts     # Runtime capability diagnostics
  translators/       # Translation backends
    llm.ts           # OpenAI-compatible API
    youdao.ts        # Placeholder/fallback
```

## Code Style Guidelines

### Imports

- Use `import type` for type-only imports
- Group imports: external libraries first, then internal modules
- Example:
  ```typescript
  import { useMemo, useState } from "react";
  import type { TextRegion } from "../types";
  import { getModelSession } from "../runtime/modelRegistry";
  ```

### Types

- Define types with `type` keyword, use `interface` only when extending
- Export types that are used across modules from `types.ts`
- Keep local types in the file that uses them
- Use union types for string literals: `"webnn" | "wasm" | "webgpu"`

### Naming Conventions

- Variables and functions: `camelCase`
- Types and classes: `PascalCase`
- Constants: `camelCase` (not SCREAMING_CASE)
- File names: `camelCase.ts` or `camelCase.tsx`
- Private helper functions: no underscore prefix, just don't export

### Functions

- Prefer `async/await` over `.then()` chains
- Use arrow functions for callbacks and short utilities
- Use `function` declarations for exported functions
- Return types can be omitted when obvious from context

### Error Handling

- Create custom error classes extending `Error` for pipeline errors
- Use helper functions to normalize unknown errors:
  ```typescript
  function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
  ```
- Throw descriptive errors with Chinese messages for user-facing errors
- Use try/catch with proper cleanup in finally blocks

### React Components

- Use functional components with hooks
- Extract reusable UI into small components
- Use `useMemo` for expensive computations
- Event handlers: `async function onAction(): Promise<void>` pattern

### Formatting

- Semicolons are required
- 2-space indentation
- Single quotes for strings, double quotes only when necessary
- Trailing commas in multi-line arrays/objects

### Comments

- User-facing messages and errors should be in Chinese
- Avoid inline comments that restate the code
- Use comments to explain non-obvious algorithms or business logic

## TypeScript Configuration

- Target: ES2022
- Strict mode enabled
- `noUnusedLocals: true` - remove unused variables
- `noUnusedParameters: true` - remove unused parameters
- `noFallthroughCasesInSwitch: true` - ensure all switch cases return

## WebNN/WebGPU/WASM Runtime

The application supports multiple ONNX execution providers with automatic fallback:

1. WebNN (GPU preferred, CPU fallback)
2. WebGPU (when available)
3. WASM (always available as fallback)

When adding new ONNX model usage:
- Use `getModelSession()` from `modelRegistry.ts`
- Handle `isContextLostRuntimeError()` for WebNN context loss
- Models must be registered in `/public/models/manifest.json`

## Adding New Pipeline Stages

1. Create module in `src/pipeline/`
2. Export async function that takes image/regions and returns processed result
3. Integrate in `orchestrator.ts` with proper error wrapping using `PipelineStageError`
4. Update `PipelineArtifacts` type if adding new intermediate outputs
5. Add visualization in `visualize.ts` if needed

## Security Notes

- API keys are entered by users at runtime, never stored or committed
- The app requires secure context (HTTPS) for WebNN
- COOP/COEP headers are configured in vite.config.ts for SharedArrayBuffer support
