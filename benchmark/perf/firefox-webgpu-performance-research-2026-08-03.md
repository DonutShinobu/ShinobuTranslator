# Firefox WebGPU / ONNX Runtime performance research, 2026-08-03

Context: the same ONNX image pipeline is materially slower in Firefox than Chromium on Windows. The observed shape is a much larger cold-start gap and roughly `3x` to `5x` slower hot runs. This note checks whether that result is already known upstream and which optimizations are low risk for the current detector, bubble, inpaint, and PaddleOCR models.

## Summary

- The cold-start pattern is credible and belongs to a known Firefox/wgpu-on-D3D12 problem class. Mozilla recorded Windows profiles with long periods in `dxcompiler.dll`, and the upstream wgpu issue still contains an April 2026 Conv2D reproduction that compiles in about `20ms` in Chrome. Historical Firefox reports ranged from about `2s` versus `150ms` to roughly ten-second DXC intervals.
- That does **not** make a persistent `3x` to `5x` hot-run gap an accepted or universal Firefox baseline. After the same shader shapes have run, a gap of that size should still be treated as an actionable backend, dispatch, or readback bottleneck until profiling proves otherwise.
- The safest immediate work is measurement hygiene, same-adapter verification, representative-shape warmup, and avoiding avoidable CPU/GPU round trips. Graph capture and fixed dimensions are model-specific experiments, not global switches.
- Firefox has an especially relevant open synchronization issue: GPU completion is polled at roughly `100ms` intervals in the reported path. Mozilla reproduced a three-float `mapAsync()` readback taking about `100ms`. A pipeline that waits for or downloads results after every run can therefore show a large hot gap even after shaders are compiled.
- Firefox 140 ESR is an important compatibility exception. Mozilla shipped WebGPU enabled by default on Windows in Firefox 141, so the extension must not assume WebGPU exists merely because the manifest minimum is Firefox 140. Firefox 140 needs the existing WASM fallback or an explicit unsupported-runtime result; asking users to toggle hidden preferences is not a release strategy.
- Upgrading Firefox is low risk and should be part of the benchmark matrix. Upgrading `onnxruntime-web` from the currently installed `1.24.1` is worth an A/B branch, but it should only land after output-parity and performance tests for all four models.

## What upstream evidence establishes

### Windows D3D12 shader compilation can explain a large cold gap

Firefox's WebGPU implementation is built on wgpu; wgpu supports the DX12 backend on Windows. Mozilla Bug 1951219 found Windows-only profiles with approximately ten-second intervals in `dxcompiler.dll`; the reporter's Chrome comparison compiled the corresponding shaders in `135ms`. Mozilla suspected either inefficient WGSL-to-HLSL translation or a difference in how Firefox invoked DXC. The bug was later closed `WORKSFORME`, so it is evidence for a known failure mode rather than proof that every current Firefox version has the same defect.

Mozilla Bug 1941977 separately measured a WebGPU example at about `2s` in Firefox Nightly and about `150ms` in Chrome. It too is now `WORKSFORME`. Both bugs point to the still-open wgpu issue `#7443`, “dx12 shader compilation is sometimes excessively slow.” That issue explicitly records cases where Chrome is much faster and, in April 2026, received a Conv2D reproduction reported at about `20ms` in Chrome.

This maps well to ONNX Runtime Web `1.24.1`. Its `ProgramManager` creates compute pipelines synchronously with `device.createComputePipeline()` and stores compiled artifacts in an in-memory `Map`. Its cache key includes the program, relevant input tensor dimensions/types, and dispatch shape. Consequently:

- the first run of every materially different tensor shape may compile additional pipelines;
- “one warmup run” is insufficient if production uses several OCR width/batch buckets;
- terminating the worker and releasing sessions loses the ORT in-memory artifact cache, even if a browser or driver cache happens to preserve lower-level shader data.

The Firefox 140 fix for GPU-process access to Firefox's disk shader cache is helpful platform work, but it does not turn ORT's JavaScript/session artifact map into a persistent cross-session cache. The extension's five-minute idle release policy therefore intentionally makes the next translation cold again at the ORT session level.

### Hot-run differences need separate attribution

Shader compilation primarily explains session creation and first-seen-shape runs. It does not by itself explain a stable `3x` to `5x` difference after identical shapes and sessions are warm. Hot measurements need to separate:

1. CPU preprocessing and postprocessing;
2. ORT/WASM graph orchestration and command encoding;
3. GPU kernel time;
4. GPU submission/synchronization;
5. GPU-to-CPU output download and Worker/Comlink transfer.

ORT's official performance guide provides WebGPU kernel profiling through `ort.env.webgpu.profiling` and CPU tracing through session profiling/`ort.env.trace`. Profiling should be enabled only in diagnostic builds and the profiled numbers should not be compared directly with unprofiled release timings.

The current worker always converts every result into a CPU `TypedArray` before returning it through Comlink. For GPU-located output it calls `tensor.getData()`, which is an explicit GPU-to-CPU download. The detector already requests `preferredOutputLocation: "gpu-buffer"`, but immediately downloads every output for CPU postprocessing; this changes where synchronization is expressed, not whether the transfer occurs. PaddleOCR similarly downloads logits because CTC decoding is currently on CPU.

Mozilla Bug 1870699 tracks Firefox's GPU-completion polling and remains open/assigned. Bug 1900273 demonstrates the practical consequence: mapping a buffer containing only three floats still took about `100ms`, which Mozilla linked to that polling interval. Bug 2008103 reports the same class of idle wait around `onSubmittedWorkDone()` in a Worker engine. This is directly applicable to the project's `getData()` calls and to benchmarks that await `queue.onSubmittedWorkDone()` after every inference. Measure the compute body with GPU timestamps, batch work where correctness permits, and perform only the readbacks the CPU consumer actually needs.

The controlled image is a particularly strong correlation, although not yet a causal profile: PaddleOCR performs nine `session.run()` calls for nine width/batch shapes, each result is materialized on CPU for CTC decoding, and Firefox's warm OCR time is about `872.5ms` versus Chromium's `173.7ms`. Eight or nine completion waits at Firefox's reported polling granularity can account for most of that extra time. The first project-specific A/B should therefore preserve the current OCR math while requesting GPU-buffer outputs for every bucket, queueing the bucket runs, and deferring/concurrently issuing their `getData()` calls; the aim is to replace serial completion boundaries with one batched completion/readback phase. If ORT cannot safely queue those runs, benchmark reducing nine buckets to two or three coarse padded widths. Both variants must retain output parity and stay within the GPU-memory budget.

There was also a material Firefox WebGPU IPC overhead, fixed in Firefox 142 by Mozilla Bug 1968122. Bug 1968102 remains open for `GPUQueue.writeBuffer()` overhead, especially many small uploads and staging-buffer creation. This strengthens two practical requirements: use Firefox 142 or newer as the WebGPU performance floor, and upload/reuse weights and buffers rather than generating many small writes. It does not change the extension's manifest minimum; Firefox 140 can continue through fallback.

### Workers improve responsiveness, not kernel throughput

The project already imports ORT inside a dedicated Worker, which is the correct way to keep heavy orchestration off the extension page. ORT's own guidance says proxy workers improve UI responsiveness but do not improve model performance; its proxy-worker facility also cannot be combined with WebGPU GPU buffers. Moving the existing worker again, adding more workers, or parallelizing sessions should not be expected to fix the Firefox/Chromium throughput gap and may add contention or transfers.

Firefox's Windows WebGPU release includes dedicated and shared workers; service workers remain excluded. The project's dedicated ONNX worker is therefore the appropriate execution context on supported Firefox versions.

### Subgroups are not a current-project explanation

Firefox source still marks the WebGPU `subgroups` feature unimplemented and links Mozilla Bug 1955417, which remains open. Upstream wgpu has subgroup support, but its tracking issue still lists specification and CTS differences.

The installed ORT Web `1.24.1` backend probes for `subgroups` and emits the WGSL enable directive only when the device exposes the feature. However, the installed WebGPU operator source contains no subgroup intrinsic implementation beyond that feature plumbing. Therefore the missing Firefox feature is relevant to future optimized ORT kernels, but there is not enough evidence to blame the current detector/PaddleOCR gap on it. Record `device.features` in benchmark metadata, but do not gate this release or add a Firefox-only code path around subgroups.

## Optimization applicability to this project

| Option | Project applicability | Risk / expected value | Recommendation |
| --- | --- | --- | --- |
| Same GPU selection | The worker already sets ORT's `powerPreference` to `high-performance`. ORT documents this as a request-adapter option, not proof that both browsers chose the same adapter. Mozilla Bug 1841840 records Firefox's deliberate low-power preference when no preference is supplied, and Bug 1840273 includes a Firefox-Intel versus Chrome-NVIDIA case. | Very low risk; essential for a valid comparison on hybrid-GPU systems. | Preserve the explicit high-performance request. Record `GPUDevice.adapterInfo`, fallback status, limits, features, Firefox/Chrome version, and driver information with every report. Compare ratios only when adapters match. If exact device control is needed, create the `GPUDevice` before the first session and assign `ort.env.webgpu.device`; do not add browser-specific hidden preferences. |
| Representative-shape warmup | Detector `1024x1024`, bubble `640x640`, and inpaint `512x512` are fixed. PaddleOCR is height `48` with variable width and batch; production buckets width to multiples of `32`. | Low implementation risk if triggered after explicit user intent. It moves first-seen compilation earlier; it does not reduce total compilation and increases temporary memory/power. | Warm fixed models once per host lifetime. For OCR, warm only the top production width/batch buckets obtained from telemetry/bench fixtures, not every possible shape and not only `[1,3,48,320]`. Keep warmup cancellable and below the host idle-release boundary. |
| Reuse sessions/host | Sessions and ORT pipelines are cached only while the worker lives. | High value for back-to-back translations; retaining longer increases GPU memory. | Preserve the current five-minute release policy unless memory data justifies a change. Confirm that every task during that window reuses the same worker/session. Do not recreate sessions per image or provider probe. |
| `freeDimensionOverrides` | Potentially useful only when a model's symbolic dimensions are known and the session will always receive those values. PaddleOCR currently varies width and batch. | ORT explicitly warns that it may regress speed or memory. A fixed override creates a separate, shape-specific session and removes flexibility. | Do not enable globally. The three fixed-size models already have fixed application shapes. For PaddleOCR, test a dedicated fixed-width/fixed-batch session only if production is deliberately changed to one padded shape; otherwise retain width buckets. |
| WebGPU graph capture | ORT requires static shapes and every kernel on WebGPU. Previous project experiments already failed for the OCR graph because of fallback/dynamic behavior. | Medium/high compatibility risk. Session creation fails when the model is ineligible. Benefits CPU command-preparation overhead, not shader compile time or unavoidable readback. | Probe detector, bubble, and inpaint independently because their application shapes are fixed. Enable only per-model after proving full WebGPU placement, output parity, memory bounds, and a repeatable hot-run win in both browsers. Keep PaddleOCR disabled unless export/runtime changes make batch and width static and remove all fallback. |
| GPU IO binding / preallocated outputs | Detector input preprocessing already produces a GPU tensor. All current model outputs are then consumed on CPU: detection postprocess, CTC decode, bubble mask processing, and final image composition. | Partial binding can improve allocation/encoder timings but cannot remove required final readback; previous OCR experiments were net-neutral or worse. | Keep detector GPU preprocessing. Revisit IO binding only as an end-to-end GPU dataflow change, such as GPU output feeding another GPU model or GPU postprocess. Preallocated fixed-shape outputs may be benchmarked for allocation stability, but are unlikely to explain `3x` to `5x` alone. |
| Dedicated Worker | Already used. | Good for UI responsiveness; no reason to expect faster kernels. | Keep one serial GPU inference queue. Do not add parallel model workers as a performance fix. |
| Upgrade Firefox | Firefox's WebGPU implementation and DXC/wgpu integration continue to change; 140 predates default Windows WebGPU release. | Low product risk when users update; benchmark behavior can materially change. | Test latest Firefox Stable as the primary supported WebGPU target, plus Firefox 140 ESR as a fallback/compatibility target. Never require hidden prefs in release instructions. |
| Upgrade ORT Web | Repository and lockfile resolve `onnxruntime-web` `1.24.1`. ORT release notes continue to include WebGPU kernels, graph capture, and MatMul/attention work. | Medium regression risk due to model/operator and buffer-lifetime sensitivity already seen by this project. | Create a benchmark-only upgrade branch to the latest stable ORT, keep JS/WASM artifacts from the exact same version, then run output parity, cold/hot timings, memory, and Firefox/Chromium smoke before landing. Do not use nightly packages in the store build. |

## Recommended implementation order

1. Add benchmark metadata for browser build, adapter info, fallback status, features, limits, and ORT version. Refuse to publish a browser ratio when the selected GPU differs.
2. Split each model report into session creation, first run for each shape, repeated same-shape GPU kernel time, submission wait, output readback, CPU preprocessing/postprocessing, and Worker round trip. Avoid a `mapAsync`, `getData`, or `onSubmittedWorkDone` after every microbenchmark iteration; submit a measured batch and read once when semantics allow. Run at least one long hot sequence with no profiling enabled.
3. A/B the OCR readback schedule first: keep outputs on GPU across all width buckets, then issue downloads together. If the runtime cannot queue them safely, compare two or three coarse padded buckets against the current nine. This is the simplest experiment that directly targets Firefox Bug 1870699 without changing model weights.
4. Validate latest Firefox Stable first and require Firefox 142 or newer for WebGPU performance claims. Keep Firefox 140 ESR in CI to verify graceful WASM fallback, not as the WebGPU performance reference.
5. Add cancellable per-host representative warmup for the fixed model shapes and a small measured set of OCR buckets. Report cold and warm numbers separately; never hide cold cost in the benchmark setup.
6. A/B an ORT stable upgrade under the exact same model hashes and inputs.
7. Probe graph capture separately for detector, bubble, and inpaint. Treat failure as “not eligible,” not as a reason to add browser-specific fallback logic.
8. Pursue broader GPU IO binding only when profiling shows readback/transfer is a leading cost and the consumer can remain on GPU. Moving a tensor to GPU and immediately calling `getData()` is not an optimization.

## Acceptance criteria for claiming improvement

- Both browsers use the same physical adapter and production extension build.
- Cold numbers include worker creation, model/session creation, and first-seen pipeline compilation; warm numbers reuse the same worker/session and exact input shape.
- At least 10 warm repetitions are summarized with median and p95, with the first run excluded only from the explicitly named warm statistic.
- Result tensors, OCR text, geometry, and rendered output remain within the existing parity gates.
- A change is accepted only if end-to-end time improves. A faster encoder or `session.run` does not count when decoder, download, or total pipeline time regresses.
- Latest Firefox Stable and Chromium both improve or remain within an agreed small regression budget; Firefox 140 ESR continues to complete via fallback without user preference changes.

## Sources

- Mozilla Bug 1951219, Windows DXC compilation profiles and Chrome comparison: https://bugzilla.mozilla.org/show_bug.cgi?id=1951219
- Mozilla Bug 1941977, Firefox `~2s` versus Chrome `~150ms`: https://bugzilla.mozilla.org/show_bug.cgi?id=1941977
- wgpu issue 7443, slow DX12 shader compilation: https://github.com/gfx-rs/wgpu/issues/7443
- Mozilla Bug 1870699, GPU completion polling: https://bugzilla.mozilla.org/show_bug.cgi?id=1870699
- Mozilla Bug 1900273, approximately `100ms` tiny-buffer `mapAsync()` readback: https://bugzilla.mozilla.org/show_bug.cgi?id=1900273
- Mozilla Bug 2008103, Worker `onSubmittedWorkDone()` idle wait: https://bugzilla.mozilla.org/show_bug.cgi?id=2008103
- Mozilla Bug 1968122, WebGPU IPC overhead fixed in Firefox 142: https://bugzilla.mozilla.org/show_bug.cgi?id=1968122
- Mozilla Bug 1968102, remaining `GPUQueue.writeBuffer()` overhead: https://bugzilla.mozilla.org/show_bug.cgi?id=1968102
- Mozilla Bug 1841840, Firefox adapter power-preference behavior: https://bugzilla.mozilla.org/show_bug.cgi?id=1841840
- Mozilla Bug 1840273, different adapter selection between Firefox and Chrome: https://bugzilla.mozilla.org/show_bug.cgi?id=1840273
- Mozilla Bug 1972486, WebGPU enabled on Windows stable in Firefox 141 and worker scope: https://bugzilla.mozilla.org/show_bug.cgi?id=1972486
- Mozilla Bug 1964740, Firefox 140 GPU-process shader-cache access fix: https://bugzilla.mozilla.org/show_bug.cgi?id=1964740
- Firefox `Adapter.cpp`, current feature mapping and unimplemented subgroups: https://searchfox.org/firefox-main/source/dom/webgpu/Adapter.cpp
- Mozilla Bug 1955417, Firefox subgroup support tracking: https://bugzilla.mozilla.org/show_bug.cgi?id=1955417
- wgpu issue 5555, subgroup implementation/spec tracking: https://github.com/gfx-rs/wgpu/issues/5555
- ONNX Runtime WebGPU guide, graph capture and GPU IO binding: https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html
- ONNX Runtime Web flags/session options, adapter/device selection and fixed dimensions: https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html
- ONNX Runtime Web performance diagnosis: https://onnxruntime.ai/docs/tutorials/web/performance-diagnosis.html
- ONNX Runtime Web `1.24.1` program manager, synchronous pipeline creation and in-memory artifact cache: https://github.com/microsoft/onnxruntime/blob/v1.24.1/js/web/lib/wasm/jsep/webgpu/program-manager.ts
- ONNX Runtime Web `1.24.1` backend, shape-sensitive program cache keys: https://github.com/microsoft/onnxruntime/blob/v1.24.1/js/web/lib/wasm/jsep/backend-webgpu.ts
