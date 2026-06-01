# OCR 子阶段性能观测 — 实施记录

## Implemented

- Bridge return contracts now carry OCR telemetry:
  - `runOcrBatchDecode()` returns decoded items plus decode run count, run time, and per-step active counts.
  - `runOcrSingleDecode()` returns fallback output plus decode telemetry.
  - `runOcrColorBatch()` / `runOcrColorSingle()` return color outputs plus session run telemetry.
- `runOcrByOnnxWithSession()` writes bridge telemetry back into `OcrRunDebugInfo`.
- `benchmark/perf/src/run-perf.ts` stores OCR debug summaries in JSON reports and prints a compact OCR substage line.
- Added `npm run bench:ocr-debug` for quick single-image OCR substage JSON output.

## Validation

```bash
npx.cmd tsc --noEmit
npm.cmd run bench:ocr-debug
```

## Validation Results

- `npx.cmd tsc --noEmit`: passed.
- `npm.cmd run bench:ocr-debug`: passed.
- Fixture result:
  - detected regions: 14
  - OCR regions: 14
  - `decodeSessionRunCount`: 8
  - `decodeStepCount`: 8
  - `colorDecodeMode`: `reuse`
  - `colorSessionRunCount`: 0
  - `totalSessionRunCount`: 8

## Decision

Keep the telemetry changes. They prove the bridge now returns authoritative OCR substage data and make follow-up AR/WebGPU experiments measurable.
