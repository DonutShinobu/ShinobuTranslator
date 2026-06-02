# WebGPU Data Flow — GPU-Accelerated Preprocessing and IO Binding

> Technical constraints and contracts for WebGPU compute shader preprocessing and ONNX IO Binding in the Worker.

---

## Scenario: Detector Letterbox Preprocessing via WebGPU Compute Shader

### 1. Scope / Trigger

- Trigger: Adding GPU-accelerated preprocessing for any ONNX model input in the Worker.
- Applies when: preprocessing can be expressed as a compute shader (resize, pad, normalize, channel reorder) and the model runs on WebGPU EP.

### 2. Data Flow

```
Main thread:  createImageBitmap(htmlImage)
                ↓ Comlink.transfer (zero-copy)
Worker:       ImageBitmap
                ↓ copyExternalImageToTexture
              GPUTexture (rgba8unorm)
                ↓ compute shader (bilinear resize + pad + normalize + HWC→NCHW)
              3× GPUBuffer (per-channel float32)
                ↓ copyBufferToBuffer
              GPUBuffer (NCHW float32, [1, 3, dstSize, dstSize])
                ↓ Tensor.fromGpuBuffer()
              ort.Tensor (GPU-backed)
                ↓ session.run (input already on GPU)
              ort.Tensor (GPU-backed via preferredOutputLocation)
                ↓ getData() → Float32Array (only when CPU data needed)
              TensorTransport → Comlink.transfer → main thread
```

### 3. WebGPU API Constraints

| Constraint | Details |
|------------|---------|
| `textureSample` is fragment-only | Cannot use in compute shaders. Use `textureLoad` + manual bilinear interpolation instead. |
| `importExternalTexture` limitations | Only supports `HTMLVideoElement` / `VideoFrame`, NOT `ImageBitmap` or `OffscreenCanvas`. Use `copyExternalImageToTexture` for image sources. |
| `ort.env.webgpu.device` | Set as a direct `GPUDevice` property on `ort.env.webgpu` after session creation (not a Promise). Access via `(ortAll.env.webgpu as any).device`. |
| Premultiplied alpha | `copyExternalImageToTexture` produces premultiplied alpha data. `canvas.getImageData` returns unpremultiplied. For opaque images (manga) these are identical. Semi-transparent inputs may differ. |

### 4. Bilinear Interpolation in Compute Shader

CPU `canvas.drawImage` uses bilinear interpolation by default. The compute shader must replicate this via manual bilinear sampling:

```wgsl
fn bilinearSample(u: f32, v: f32) -> vec4<f32> {
  let w = f32(params.src_width);
  let h = f32(params.src_height);
  let x = u * w - 0.5;
  let y = v * h - 0.5;
  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  let fx = x - f32(x0);
  let fy = y - f32(y0);
  let c00 = textureLoad(src, vec2<i32>(clamp(x0, 0, i32(params.src_width)-1), clamp(y0, 0, i32(params.src_height)-1)), 0);
  let c10 = textureLoad(src, vec2<i32>(clamp(x1, 0, i32(params.src_width)-1), clamp(y0, 0, i32(params.src_height)-1)), 0);
  let c01 = textureLoad(src, vec2<i32>(clamp(x0, 0, i32(params.src_width)-1), clamp(y1, 0, i32(params.src_height)-1)), 0);
  let c11 = textureLoad(src, vec2<i32>(clamp(x1, 0, i32(params.src_width)-1), clamp(y1, 0, i32(params.src_height)-1)), 0);
  let top = mix(c00, c10, fx);
  let bot = mix(c01, c11, fx);
  return mix(top, bot, fy);
}
```

Nearest-neighbor (`textureLoad` at integer coords) does NOT match CPU behavior and will degrade detection quality.

### 5. Letterbox Alignment

CPU implementation uses **top-left alignment**: `drawImage(image, 0, 0, unpaddedWidth, unpaddedHeight)` with `fillStyle="black"`. The padding value is `0.0`, NOT `0.498` or `#7f7f7f`. The shader must match:

```wgsl
if (dst_x < params.unpadded_width && dst_y < params.unpadded_height) {
  // sample and write channel data
} else {
  dst_ch0[dst_idx] = 0.0;  // black padding
  dst_ch1[dst_idx] = 0.0;
  dst_ch2[dst_idx] = 0.0;
}
```

### 6. IO Binding Contracts

| Setting | When | Effect |
|---------|------|--------|
| `Tensor.fromGpuBuffer(buffer, { dims, dataType, download, dispose })` | GPU-preprocessed input | Creates GPU-backed input tensor. `download` callback handles CPU fallback. `dispose` callback cleans up GPUBuffer. |
| `preferredOutputLocation: "gpu-buffer"` | Only for detector sessions | Output tensors stay on GPU. Access via `getData()` to download to CPU. Must NOT be applied globally — other sessions' `tensorToTransport` reads `tensor.data` directly. |
| `session.sessionId` options | Session creation | Pass `preferredOutputLocation` in session options, not in `session.run()` feeds. |

### 7. GPU Resource Lifecycle

Resources created in `preprocessLetterboxGpu` must be cleaned up:

| Resource | When to destroy |
|----------|----------------|
| `srcTexture` | After compute pass submitted |
| `ch0Buffer`, `ch1Buffer`, `ch2Buffer` | After `copyBufferToBuffer` submitted |
| `uniformBuffer` | After compute pass submitted |
| `nchwBuffer` | In `Tensor.fromGpuBuffer`'s `dispose` callback (last to be consumed) |

All intermediate resources are destroyed after `device.queue.onSubmittedWorkDone()`. The NCHW buffer is owned by the ort.Tensor and destroyed via its `dispose` callback.

### 8. Fallback Path

```
WebGPU GPU-preprocess path
  ↓ (failure)
WASM CPU-preprocess path with full fallback chain:
  ["webnn", "wasm"] → ["wasm"]
```

The WebGPU fallback must attempt WebNN before falling back to WASM, matching the original detection behavior.

### 9. Validation & Error Matrix

| Condition | Error | Fix |
|-----------|-------|-----|
| `ort.env.webgpu.device` undefined | "ort.env.webgpu.device 不可用" | Ensure WebGPU session created before calling GPU preprocess |
| GPU tensor accessed via `tensor.data` | "The data is not on CPU" | Use `getData()` for GPU tensors, or restrict `preferredOutputLocation` by modelKey |
| `textureSample` in compute shader | WGSL compilation error | Use `textureLoad` + manual bilinear |
| `platform` undefined in OCR provider | "Cannot read properties of undefined (reading 'createCanvas')" | Always pass `platform` from caller |

### 10. Tests Required

- [ ] Pixel-level comparison: GPU-preprocessed input vs CPU-preprocessed input for same image (max abs diff < epsilon)
- [ ] Detection result comparison: GPU path vs CPU path on same image (same number of detections, similar bounding boxes)
- [ ] Fallback: GPU path failure falls back to WASM without crash
- [ ] Resource cleanup: No GPU buffer/texture leaks after preprocessing

---

## Scenario: Extension Worker Origin for ORT Backend Assets

### 1. Scope / Trigger

- Trigger: Creating or changing the ONNX Worker bootstrap path in a Chrome extension page or content script.
- Applies when: `onnxWorker.js` loads `onnxruntime-web` and ORT must dynamically import backend files from `dist/ort/*.mjs`.

### 2. Signatures

- `ensureWorker(): Promise<{ worker: Worker; proxy: Comlink.Remote<OnnxWorkerApi> }>`
- `initWorker(candidate: Worker, ortPath: string, label: string): Promise<Comlink.Remote<OnnxWorkerApi>>`
- Worker init contract: `OnnxWorkerApi.init(ortPath: string): Promise<void>`

### 3. Contracts

- Prefer `new Worker(chrome.runtime.getURL("onnxWorker.js"), { type: "module" })` when the worker script URL starts with `chrome-extension://`.
- Pass `chrome.runtime.getURL("ort/")` to `proxy.init(ortPath)` so ORT resolves `ort-wasm-simd-threaded.jsep.mjs` and its `.wasm` sidecar from the packaged extension assets.
- Keep a Blob Worker fallback for page/content-script contexts that reject `chrome-extension://` Worker scripts.
- `public/manifest.json` must expose both `onnxWorker.js` and `ort/*` through `web_accessible_resources`.

### 4. Validation & Error Matrix

| Condition | Symptom | Fix |
|-----------|---------|-----|
| Blob Worker is used in an extension page while `ortPath` points at `chrome-extension://.../ort/` | `Failed to fetch dynamically imported module: chrome-extension://.../ort/ort-wasm-simd-threaded.jsep.mjs` | Prefer direct extension URL Worker before Blob fallback |
| `ort/*` missing from `web_accessible_resources` | Backend `.mjs` or `.wasm` fetch fails from content-script/page-origin workers | Add `ort/*` to WAR |
| `onnxWorker.js` missing from `web_accessible_resources` | Content script cannot fetch Worker script for Blob fallback | Add `onnxWorker.js` to WAR |
| Direct extension Worker is blocked in a page context | Worker init timeout or load error | Terminate candidate and fall back to Blob Worker |

### 5. Good/Base/Bad Cases

- Good: Extension page creates a direct `chrome-extension://.../onnxWorker.js` module Worker; WebGPU and WASM backend imports load from `chrome-extension://.../ort/`.
- Base: Content script tries direct extension Worker, catches the load/init failure, then uses Blob fallback with the same `ortPath`.
- Bad: Always converting the Worker script to Blob. This changes the Worker origin and can break ORT dynamic backend imports even when `ort/*` exists in `dist`.

### 6. Tests Required

- Real-browser smoke: load `dist` as an MV3 extension and run `runOcrSplitBatchDecode` in a Chrome/Chromium extension page.
- Full pipeline smoke: load a normal web page with the content script and run detect + OCR + bake through the extension bridge.
- Failure assertion: if direct extension Worker init fails, Blob fallback is attempted and the failed candidate is terminated.

### 7. Wrong vs Correct

#### Wrong

```typescript
const scriptText = await (await fetch(scriptUrl)).text();
const blobUrl = URL.createObjectURL(new Blob([scriptText], { type: "application/javascript" }));
const worker = new Worker(blobUrl, { type: "module" });
await proxy.init(chrome.runtime.getURL("ort/"));
```

#### Correct

```typescript
if (scriptUrl.startsWith("chrome-extension://")) {
  try {
    const worker = new Worker(scriptUrl, { type: "module" });
    await proxy.init(chrome.runtime.getURL("ort/"));
    return { worker, proxy };
  } catch {
    // Fall back to Blob Worker for content-script contexts that reject extension Workers.
  }
}
```
