# OCR cold-start experiments, 2026-06-13

Context: experiments targeted the 48px OCR path cold-start cost in the browser extension. The goal was to find changes that improve cold start without meaningfully increasing resident memory.

Test image:

- X URL: `https://x.com/QVdld/status/2061438475728277610/photo/1`
- Image URL: `https://pbs.twimg.com/media/HJuzJGbbMAArfNI?format=jpg&name=orig`
- Chrome/system benchmark command family: `npm run bench:browser-x-current -- --system-chrome --runs=N --url=... --image-url=...`

## Summary

| Experiment | Status | Best useful result | Recommendation |
| --- | --- | --- | --- |
| `onnxruntime-web/webgpu` worker | Can be made runnable only with workarounds | Worker bundle drops from about 887 KB to about 163 KB, but runtime is slower than default | Do not promote as cold-start speed optimization. Keep only as experimental if bundle size becomes the priority. |
| `onnxruntime-web` root worker instead of `/all` | Runnable | Worker bundle about 451 KB, but adjacent single-run benchmark was slower than default | Not worth productizing for speed. |
| Offline optimized ONNX / ORT-format direction | Partial | `ORT_ENABLE_EXTENDED` ran, but was slower; `ORT_ENABLE_ALL` generated an incompatible `com.microsoft.nchwc:Conv` model for the web path | Do not use current optimized artifacts. Revisit only with a proper web-targeted optimization/export pipeline. |
| WebGPU graph capture | Not viable with current OCR graph | Session creation/run fell back or failed because not all nodes are on WebGPU and shapes are not fully static through the current decode loop | Needs model/export redesign before retrying. |
| GPU encoder cache / IO binding | Technically works in parts | Encoder run time improved in some runs, but decoder got slower and net result was unstable | Not worth landing as-is. Needs a deeper decoder-side GPU dataflow redesign. |
| Concurrent/background warmup and inference queue | Low benefit in measured runs | Improvements were too small/noisy relative to complexity | Do not prioritize unless paired with UI/UX preloading policy work. |

## WebGPU-only worker

Official ORT docs recommend conditional importing for deployment size, and WebGPU examples use `onnxruntime-web/webgpu` plus explicit `executionProviders: ['webgpu']`.

Findings:

- Strict `onnxruntime-web/webgpu` initially failed in the OCR path.
- The detector GPU-preprocess path triggered `WebGPU device error(2): [Buffer] used in submit while destroyed`.
- The OCR encoder then failed on WebGPU shader creation for `Pow` nodes such as `/encoders.0/self_attn/xpos/Pow`.
- Disabling WebGPU prepack did not fix the `Pow` shader failure.
- Forcing all OCR encoder/decoder `xpos/Pow` nodes to CPU made the strict WebGPU worker run.

Final 3-run strict-worker result:

- Report: `benchmark/perf/reports/x-current-2026-06-13T08-15-07-027Z.json`
- Worker: `onnxruntime-web/webgpu`
- First run: total `16.27s`, OCR `10.71s`, decode session total `10.41s`
- Warm median: total `2.72s`, OCR `2.09s`, decode session total `2.03s`
- Bundle: `onnxWorkerWebgpu.js` about `162.93 KB`, gzip about `52.86 KB`

Same-code default `/all` 3-run comparison:

- Report: `benchmark/perf/reports/x-current-2026-06-13T08-15-43-493Z.json`
- Worker: default `onnxruntime-web/all`
- First run: total `14.96s`, OCR `10.04s`, decode session total `9.78s`
- Warm median: total `2.27s`, OCR `1.58s`, decode session total `1.49s`
- Bundle: `onnxWorker.js` about `887.11 KB`, gzip about `216.68 KB`

Conclusion: strict WebGPU worker is now understood, but it is not a speed win. Its only clear win is JS bundle size. The required CPU fallback for `xpos/Pow` also makes it less attractive for OCR decode performance.

## Root `onnxruntime-web` worker instead of `/all`

This variant aliases `onnxruntime-web/all` to the package root `onnxruntime-web`, not to `onnxruntime-web/webgpu`.

Result:

- Report: `benchmark/perf/reports/x-current-2026-06-13T08-02-30-038Z.json`
- Single run: total `20.97s`, OCR `14.89s`, decode session total `14.49s`
- Bundle: about `450.90 KB`, gzip about `124.82 KB`

Adjacent default `/all` comparison:

- Report: `benchmark/perf/reports/x-current-2026-06-13T08-02-59-116Z.json`
- Single run: total `19.26s`, OCR `13.80s`, decode session total `13.58s`

Conclusion: smaller than `/all`, larger than strict `webgpu`, and not faster in the measured run.

## Offline optimized ONNX / ORT-format direction

Result:

- `ORT_ENABLE_ALL` optimized model failed in the browser path due to `com.microsoft.nchwc:Conv`.
- `ORT_ENABLE_EXTENDED` ran:
  - Report: `benchmark/perf/reports/x-current-2026-06-13T07-49-26-100Z.json`
  - Single run: total `24.09s`, OCR `17.01s`, decode session total `16.70s`

Conclusion: current optimized ONNX artifacts are not useful. The direction may still be valid, but only if the optimization/export pipeline is constrained for ORT Web/WebGPU compatibility.

## WebGPU graph capture

Result:

- Report: `benchmark/perf/reports/x-current-2026-06-13T07-50-33-926Z.json`
- Single run: total `24.76s`, OCR `19.48s`
- ORT rejected or failed graph capture because not all nodes were placed on WebGPU, and the current OCR decode path still has dynamic active batch behavior.

Conclusion: not viable without a fixed-shape decoder/export redesign.

## GPU encoder cache / IO binding

Observed behavior:

- Reports:
  - `benchmark/perf/reports/x-current-2026-06-13T07-51-21-394Z.json`
  - `benchmark/perf/reports/x-current-2026-06-13T07-53-01-803Z.json`
- Encoder run time improved sharply in some runs, down to around `65ms` and `23ms`.
- Decoder-side cost increased enough that end-to-end benefit was unstable or negative.

Conclusion: this is the most technically interesting failed experiment, but the current partial GPU cache is not enough. Any future retry should keep both encoder memory and decoder loop feeds/results on GPU more completely, then measure decoder run total, not only encoder time.

## Takeaways

1. The current cold-start bottleneck is not solved by import-path trimming alone.
2. The strict WebGPU entry is fragile with the OCR `xpos/Pow` nodes in ORT Web 1.24.1 / current Chrome.
3. Graph capture needs a more static decoder shape story before it can help.
4. IO binding remains worth revisiting, but only as a full decoder dataflow design, not a small toggle.
5. The safest next high-leverage direction is model/export work: remove or fold problematic `xpos/Pow` patterns, then revisit strict WebGPU and graph capture on a fixed-shape decoder.

References:

- ONNX Runtime WebGPU docs: https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html
- ONNX Runtime Web deployment / conditional importing docs: https://onnxruntime.ai/docs/tutorials/web/deploy.html
- Related ORT WebGPU buffer lifetime issue: https://github.com/microsoft/onnxruntime/issues/27068
