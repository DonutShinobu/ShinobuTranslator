# OCR AR 结构复用优化实验 — 实施计划

## Steps

1. Extract color output reduction into `src/pipeline/ocr/colorDecodeShared.ts`.
2. Update `color.ts` to use the shared helper.
3. Extend AR decode output types with optional `colors`.
4. Capture reusable colors in `decodeBatchAutoregressive()` when outputs include `fg/bg/fg_ind/bg_ind`.
5. Propagate colors through Worker and Node bridge result types.
6. In `runOcrByOnnxWithSession()`, skip `runOcrColorBatch()` when accepted decoded candidates all contain colors.
7. Run fixture OCR timing before/after and `npx tsc --noEmit`.

## Validation

```bash
npx.cmd tsx <inline OCR fixture timing script>
npx.cmd tsc --noEmit
```

## Risky Files

- `src/pipeline/ocr/decodeAutoregressive.ts`
- `src/pipeline/ocr/color.ts`
- `src/pipeline/ocr/index.ts`
- `src/runtime/onnxWorkerTypes.ts`
- `src/workers/onnx-worker.ts`
- `src/runtime/onnxNodeBridge.ts`

## Revert Criteria

- OCR text count drops on the fixture.
- Colors are frequently missing and fallback still runs.
- Runtime improvement is below noise (<3%) or TypeScript compatibility becomes messy.

## Validation Results

- `npx.cmd tsc --noEmit`: passed.
- `npm.cmd run build`: passed.
- Fixture: `benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png`.
- Result count: 14 detected regions, 14 OCR regions.
- `colorDecodeMode`: `reuse`.
- `colorTotalMs`: 0ms.
- Warm OCR runs after change: 6839ms and 6813ms after first cached run.
- Direct color comparison against explicit `decodeTokenColorsBatch()`: max foreground diff 0, max background diff 0.

## Decision

Keep the optimization. It removes one extra OCR model `session.run()` without changing decoded text or colors on the fixture. This does not solve the main AR logits bottleneck; the next high-impact task remains `06-01-ocr-webgpu-ar-optimize` or a deeper encoder/decoder model split.
