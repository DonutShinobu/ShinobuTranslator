<!-- TRELLIS:START -->
# Trellis Instructions

These instructions are for AI assistants working in this project.

This project is managed by Trellis. The working knowledge you need lives under `.trellis/`:

- `.trellis/workflow.md` — development phases, when to create tasks, skill routing
- `.trellis/spec/` — package- and layer-scoped coding guidelines (read before writing code in a given layer)
- `.trellis/workspace/` — per-developer journals and session traces
- `.trellis/tasks/` — active and archived tasks (PRDs, research, jsonl context)

If a Trellis command is available on your platform (e.g. `/trellis:finish-work`, `/trellis:continue`), prefer it over manual steps. Not every platform exposes every command.

If you're using Codex or another agent-capable tool, additional project-scoped helpers may live in:
- `.agents/skills/` — reusable Trellis skills
- `.codex/agents/` — optional custom subagents

Managed by Trellis. Edits outside this block are preserved; edits inside may be overwritten by a future `trellis update`.

<!-- TRELLIS:END -->

## Project Overview

ShinobuTranslator is a Chrome Manifest V3 browser extension that translates manga/comic images on Twitter/X, Pixiv, and E-Hentai. The local pipeline includes text detection, OCR, translation, inpainting, and typesetting.

## Build Commands

```bash
npm run dev       # Vite development mode
npm run typecheck # App + tests + benchmark TypeScript checks
npm run build     # Release build + separate ONNX Worker build + artifact checks
npm run check     # Full typecheck + Vitest + Release build gate
npm run build:benchmark # Build the isolated benchmark page after Release checks
npm run preview   # Preview production build
npm run test      # Vitest test runner
```

## Development Notes

- Use `import type` for type-only imports.
- Prefer `type` over `interface` unless extension/inheritance is needed.
- Use `async/await`; avoid long `.then()` chains.
- Keep exported functions as function declarations when practical.
- Keep user-facing messages in Chinese.
- Follow strict TypeScript settings in `tsconfig.json`.
- React is only used in the popup UI. Content scripts use imperative DOM (`document.createElement`). Do not introduce React into content scripts.
- Content script CSS classes use `mt-x-` prefix to avoid collisions with host page styles.

## Runtime and Models

- Runtime uses `onnxruntime-web` with provider fallback (WebNN/WebGPU/WASM depending on environment support).
- Register every product model in `public/models/models.json` before usage.
- Load model sessions through `src/runtime/modelRegistry.ts`.
- `src/workers/onnx-worker.ts` is built separately by `scripts/build-worker.mjs`; do not add it to the main Vite entry graph.
- The only product OCR runtime is `paddleocr_v6_medium`; legacy conversion scripts under `scripts/legacy/` are historical references, not build inputs.
- The pipeline is lazy-loaded via dynamic `import()` only when the user clicks translate.

## Benchmark Boundary

- `benchmark.html` and `src/benchmark/browserEntry.ts` are only available through `npm run build:benchmark`.
- Production content/background/popup code must not expose benchmark globals or import benchmark-only modules.
- Keep historical benchmark reports, but do not restore removed runtime paths merely to execute an old report or command.

## Security Notes

- API keys are entered by users in popup settings at runtime.
- Never commit keys or secrets.
- Extension host permissions are defined in `public/manifest.json`.
