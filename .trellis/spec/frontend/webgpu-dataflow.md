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

---

## Scenario: ONNX Worker Session Variants and OCR Decode Payloads

### 1. Scope / Trigger

- Trigger: Creating, reusing, disposing, or instrumenting ONNX sessions through `src/runtime/onnxWorkerBridge.ts` and `src/workers/onnx-worker.ts`.
- Applies when the same model can be requested with different provider plans, for example `["webgpu", "webnn", "wasm"]` vs `["webnn", "wasm"]`.
- Applies to OCR batch decode contracts because OCR inputs are large `Float32Array` payloads and main-thread responsiveness depends on not sending them back unnecessarily.

### 2. Signatures

- `createSession(modelKey: string, modelUrl: string, preferred: RuntimeProvider[]): Promise<WorkerSessionHandle>`
- Worker cache key: `` `${modelKey}:${normalizedPreferredProviders.join(",")}` ``
- `disposeSession(sessionId: string): Promise<void>` accepts either an exact worker `sessionId` or a bare model key such as `"ocr_encoder"`.
- `OcrBatchDecodeOutputItem` returns only decode results:

```typescript
export type OcrBatchDecodeOutputItem = {
  regionId: string;
  text: string;
  confidence: number;
  tokenIds: number[];
  validEncoderLength: number;
  colors?: OcrColorResult;
};
```

### 3. Contracts

- The worker session cache must include the normalized preferred provider list in the key. A runtime probe must not poison a later pipeline request that asks for a different provider plan.
- `WorkerSessionHandle.sessionId` must be the same provider-plan-qualified key used by the worker cache.
- `disposeSession("modelName")` must dispose all cached variants whose keys start with `"modelName:"`, as well as an exact key when one is provided.
- Do not return OCR batch input image data from the worker. The main thread already owns `candidate.inputData` and uses it for result mapping and color reuse after decode.
- Keep structured clone for worker inputs. Do not use `Comlink.transfer()` for input tensors unless the caller creates a throwaway copy specifically for transfer.

### 4. Validation & Error Matrix

| Condition | Symptom | Fix |
|-----------|---------|-----|
| Session cache keyed only by `modelKey` | A WebGPU probe can make a later `["webnn", "wasm"]` request reuse the wrong provider | Key sessions by `modelKey + normalized provider plan` |
| `disposeSession("ocr_encoder")` clears only an exact key | Old provider-plan variants survive and are reused unexpectedly | Dispose exact key and every key with the `ocr_encoder:` prefix |
| OCR batch output includes `imageData` / `imageDims` | Worker response includes megabytes of data the main thread already has, increasing message handling jank | Return only text, confidence, token ids, valid encoder length, and colors |
| Input arrays are transferred directly | Fallback retries or later color decoding see detached buffers | Use structured clone for inputs, or transfer only copied throwaway buffers |

### 5. Good/Base/Bad Cases

- Good: `getModelSession("inpaint", ["webgpu", "webnn", "wasm"])` and `getModelSession("inpaint", ["webnn", "wasm"])` create distinct cached sessions and report distinct `sessionId` values.
- Base: Repeated calls with the same normalized provider plan reuse the cached session.
- Bad: Caching by only `"inpaint"` or `"ocr_encoder"` allows a probe, fallback, or experiment to silently change the provider used by later work.
- Bad: Returning OCR `imageData` from `runOcrSplitBatchDecode()` duplicates the input payload across the worker boundary.

### 6. Tests Required

- `npx tsc --noEmit` must catch stale consumers of removed OCR output fields.
- Real-browser smoke must run `runOcrSplitBatchDecode` through `dist/chunks/onnxWorkerBridge.js`.
- Full pipeline smoke must load `dist` as an MV3 extension and complete detect + OCR + result generation.
- When changing content-script import graph or worker bridge output, run `node --check dist/content.js`, `node --check dist/chunks/orchestrator.js`, `node --check dist/chunks/onnxWorkerBridge.js`, and `node --check dist/onnxWorker.js`.

### 7. Wrong vs Correct

#### Wrong

```typescript
const existing = sessions.get(modelKey);
sessions.set(modelKey, { session, provider, modelUrl });

const outputItems = batchResults.map((result, i) => ({
  regionId: items[i].regionId,
  text: result.text,
  confidence: result.confidence,
  tokenIds: result.tokenIds,
  imageData: items[i].imageData,
  imageDims: items[i].imageDims,
  validEncoderLength: result.validEncoderLength,
}));
```

#### Correct

```typescript
const normalized = preferred.filter((item, idx) => preferred.indexOf(item) === idx);
const sessionId = `${modelKey}:${normalized.join(",")}`;
const existing = sessions.get(sessionId);
sessions.set(sessionId, { session, provider, modelUrl });

const outputItems = batchResults.map((result, i) => ({
  regionId: items[i].regionId,
  text: result.text,
  confidence: result.confidence,
  tokenIds: result.tokenIds,
  validEncoderLength: result.validEncoderLength,
  colors: result.colors,
}));
```

---

## Scenario: PaddleOCR Recognition Model Variant

### 1. Scope / Trigger

- 触发：新增或修改 PaddleOCR recognition 模型、字典、manifest 字段、OCR engine 设置项，或浏览器/Node PaddleOCR 冒烟测试。
- 目标：用户可见和运行时注册的 Paddle 路径只保留 `paddleocr_v6_medium`，并保持 `48px` 默认 OCR 不受影响。
- 兼容：旧设置值 `paddleocr`、`paddleocr_v6_small`、`paddleocr_v6_medium` 都归一化到 `paddleocr_v6_medium`；不要再注册 v5/small provider。

### 2. Signatures

- `public/models/models.json`
  ```json
  {
    "paddleocr_v6_medium_rec": {
      "url": "/models/PP-OCRv6_medium_rec.onnx",
      "input": [48, 320],
      "dictUrl": "/models/paddleocr_v6_dict.txt",
      "normalize": "minus_one_to_one",
      "channelOrder": "bgr"
    }
  }
  ```
- `ModelName`
  ```typescript
  type ModelName = "paddleocr_v6_medium_rec" | ...;
  ```
- `OcrEngine`
  ```typescript
  type OcrEngine = "48px" | "paddleocr_v6_medium";
  ```
- Provider registration:
  ```typescript
  registerOcrProvider(ocr48pxProvider);
  registerOcrProvider(paddleocrV6MediumProvider);
  registerOcrProviderAlias("paddleocr", "paddleocr_v6_medium");
  registerOcrProviderAlias("paddleocr_v6_small", "paddleocr_v6_medium");
  ```
- Metadata check:
  ```bash
  npm run models:check-paddle-ocr -- public/models/<model>.onnx public/models/paddleocr_v6_dict.txt
  ```

### 3. Contracts

- `48px` remains the default and must not be renamed, repointed, or removed when changing Paddle settings.
- The product Paddle provider name is `paddleocr_v6_medium`; popup label is `Paddle`.
- The legacy user setting value `paddleocr` is an alias only. It exists to migrate saved settings, not to run the old v5 model.
- `paddleocr_v6_small` is an alias only. Do not add it back to popup choices or provider registration without a new explicit product decision.
- v6 medium uses `paddleocr_v6_dict.txt`. The dict was generated from v6 `inference.yml` and must preserve token order.
- v6 official `inference.yml` declares `img_mode: BGR`, so the medium manifest entry must set `"channelOrder": "bgr"`.
- CTC decode class count must satisfy `outputClasses === dictionaryEntries + 2` for blank plus appended half-width space.
- Dictionary generation must preserve Unicode whitespace tokens such as full-width space `　`. Do not parse YAML scalars with `trim()`, `trimEnd()`, or filters that erase whitespace-only characters.
- Large `.onnx` files stay as local model assets under the existing ignore policy. Text dictionaries that are referenced by `models.json` must be unignored and tracked.

### 4. Validation & Error Matrix

| Condition | Symptom | Fix |
| --- | --- | --- |
| v6 dict generated with `trimEnd()` | Full-width space becomes an empty line; class count appears as 18709 instead of 18710 | Preserve raw scalar content when parsing `character_dict` |
| v6 manifest omits `channelOrder: "bgr"` | Model runs but recognition quality is suspicious or unstable | Read `inference.yml` and set channel order per model |
| `OcrEngine` accepts a new value but provider/model manifest is missing | User selection reaches `manifest 缺少模型定义` | Add provider registration, `ModelName`, manifest entry, and popup/config normalization together |
| Popup shows multiple Paddle options | Users can select removed variants and saved settings drift | Keep only `48px` and `Paddle`; normalize old Paddle values to medium |
| Browser smoke runs Paddle sessions concurrently | ONNX Worker can throw `Session already started` | Run Paddle smoke sessions sequentially |
| Model output classes differ from dict size + 2 | CTC token ids are misaligned | Stop before UI exposure; regenerate dict or verify the matching model/dict pair |

### 5. Good/Base/Bad Cases

- Good: Popup shows `48px` and `Paddle`; `Paddle` stores `paddleocr_v6_medium`.
- Good: Old saved `paddleocr` and `paddleocr_v6_small` settings still run by aliasing to `paddleocr_v6_medium`.
- Base: Historical v5/small benchmark data may stay in task research, but product runtime registration remains medium-only.
- Bad: Reintroducing v5 or small as user-selectable OCR engines while the product decision is medium-only.
- Bad: overwriting `paddleocr_rec` with a v6 ONNX URL; if the old manifest entry remains for historical/local baseline use, keep it distinct from medium.
- Bad: treating dictionary lines as ordinary trim-safe text; OCR dictionaries may contain meaningful whitespace entries.

### 6. Tests Required

- `npm run models:check-paddle-ocr -- public/models/PP-OCRv6_medium_rec.onnx public/models/paddleocr_v6_dict.txt`
- `npm run test -- tests/shared/config.test.ts tests/pipeline/ocr/paddleocrDecode.test.ts`
- `npx tsc --noEmit --pretty false`
- `npm run build`
- `npm run bench:ocr-debug -- --ocr-engine=all --runs=2`
- `npm run bench:browser-ocr-smoke`

### 7. Wrong vs Correct

#### Wrong

```typescript
const chars = yamlLines
  .map((line) => line.slice(4).trimEnd())
  .filter((line) => line.length > 0);

const paddleocrProvider = createPaddleOcrProvider("paddleocr", "paddleocr_v6_small_rec");
registerOcrProvider(paddleocrV6SmallProvider);
```

#### Correct

```typescript
const chars = yamlLines.map((line) => parseYamlScalarPreservingWhitespace(line.slice(4)));

export const paddleocrV6MediumProvider = createPaddleOcrProvider(
  "paddleocr_v6_medium",
  "paddleocr_v6_medium_rec",
);
registerOcrProviderAlias("paddleocr", "paddleocr_v6_medium");
registerOcrProviderAlias("paddleocr_v6_small", "paddleocr_v6_medium");
```
