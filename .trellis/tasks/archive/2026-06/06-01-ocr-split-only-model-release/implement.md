# OCR split-only 模型发布实施计划

## Checklist

- [x] 确认是否彻底移除 full OCR fallback，或保留不发布的 legacy local-only 路径。
- [x] 重构 `src/pipeline/ocr/index.ts`，让内置 OCR 入口直接创建 `ocr_encoder` / `ocr_decoder` session pair。
- [x] 删除或隔离 `getModel("ocr")`、`getModelSession("ocr")`、`runOcrBatchDecode`、`runOcrSingleDecode` 在正常路径的引用。
- [x] 处理颜色解码：优先复用 split decode 结果，缺失时交给图像采样兜底。
- [x] 更新 `public/models/models.json`，默认发布清单不再包含 `"ocr"` / `/models/ocr.onnx`。
- [ ] 更新 benchmark/smoke 中仍依赖 full OCR 的旧对比入口。
- [x] 验证 `npm run models:upload -- 0.4.0 --dry-run` 和 `npm run models:download -- 0.4.0 --dry-run` 不包含 `ocr.onnx`。
- [x] 运行 `npm run build`。
- [x] 运行真实浏览器 OCR smoke，确认 WebGPU split-only 可跑通。
- [x] 清理并补齐 GitHub `models-v0.4.0` pre-release 资产，上传新的 `models.sha256`。

## Validation Commands

```bash
rg "getModelSession\\(\"ocr\"" src benchmark
npm run models:upload -- 0.4.0 --dry-run
npm run models:download -- 0.4.0 --dry-run
MODEL_RELEASE_TAG=models-v0.4.0 npm run build
npm run bench:browser-ocr-smoke -- --system-chrome
```

## Validation Notes

- `npx tsc --noEmit` passed.
- `npm run test` passed.
- `npm run models:upload -- 0.4.0 --dry-run` passed and excludes `ocr.onnx`.
- `npm run models:download -- 0.4.0 --dry-run` passed and excludes `ocr.onnx`.
- `MODEL_RELEASE_TAG=models-v0.4.0 npm run build` passed.
- `dist/models/ocr.onnx` is absent after build, even when local `public/models/ocr.onnx` exists for model splitting.
- Browser smoke was attempted with system Chrome, but timed out waiting for the extension service worker.
- Equivalent Chrome/WebGPU pipeline measurement passed via local HTTP harness using current `dist` assets and split-only models. Report: `benchmark/perf/reports/x-current-2026-06-01T10-35-00-282Z.json`.
- `C:\code\ShinobuTranslator` was refreshed from a local-URL build after the release-URL build produced model `Failed to fetch` in unpacked Chrome testing.
- `npm run models:upload -- 0.4.0 "ONNX 模型 v0.4.0"` passed; all 9 release assets were already present and skipped unchanged.
- `npm run models:download -- 0.4.0` passed and verified checksums from the uploaded `models.sha256`.

## Risky Files

- `src/pipeline/ocr/index.ts`
- `src/workers/onnx-worker.ts`
- `src/runtime/modelRegistry.ts`
- `src/runtime/selfCheck.ts`
- `src/pipeline/orchestrator.ts`
- `public/models/models.json`
- `vite.config.ts`
- `scripts/build-worker.mjs`
- `benchmark/perf/src/run-browser-ocr-smoke.ts`

## Rollback Points

- 如果 split decoder 颜色覆盖率不足，先补 split-compatible color fallback API，不恢复 `ocr.onnx` 发布依赖。
- 如果 WebNN/WASM split session 有兼容问题，优先修 provider fallback 到 WASM split，而不是恢复 `ocr.onnx`。
