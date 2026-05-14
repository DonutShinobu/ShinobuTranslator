# Worker Architecture for Chrome Extension Content Script

## Key Findings

### Worker Creation in Content Script Context

Chrome extension content scripts can create Workers, but there are constraints:

- Content scripts run in the page's origin for DOM access but in an isolated world for JS
- `new Worker(url)` from content script requires the URL to be same-origin or a chrome-extension URL
- **Viable approach**: Extension-origin Worker as a new Vite entry point
  - Create `src/workers/onnx-worker.ts` as a new Rollup input
  - Add `onnx-worker.js` to `web_accessible_resources` in manifest.json
  - Create via `new Worker(chrome.runtime.getURL("onnx-worker.js"))`
  - Worker runs in extension origin, can use `chrome.runtime.getURL()` for WASM paths

### ORT Built-in Proxy Worker Won't Work

ORT's `env.wasm.proxy = true` creates an internal Worker, but:
- It uses `import.meta.url` to locate its script source
- In content script context, `import.meta.url` is rewritten to `chrome.runtime.getURL("content.js")`
- ORT's `importProxyWorker()` would try to load the entire content.js as a Worker script
- This would fail: content.js contains all pipeline code, not just the proxy handler
- Requires significant patching of ORT internals to work in extension context

### Build Configuration Changes Needed

1. **vite.config.ts**: Add `onnx-worker` entry to `rollupOptions.input`
2. **manifest.json**: Add `onnx-worker.js` to `web_accessible_resources`
3. **chromeExtensionContentScriptPlugin**: Extend to handle Worker entry's `import.meta.url` replacement
4. **New file**: `src/workers/onnx-worker.ts`

### Current ORT WASM Loading

- Import: `import * as ortAll from "onnxruntime-web/all"` (full bundle ~264KB inlined in content.js)
- WASM paths: `ortAll.env.wasm.wasmPaths = resolveAssetUrl("ort/")` → `chrome-extension://<id>/ort/`
- WASM proxy: `ortAll.env.wasm.proxy = false` (explicitly disabled)
- Threading: limited to 1 without `crossOriginIsolated`
- WASM files served from `public/ort/` (not bundled, loaded via fetch at runtime)

### Data Transfer for Tensors

- Float32Array can be transferred as Transferable objects (zero-copy)
- Need to extract raw data from ONNX Tensor instances for transfer
- Worker reconstructs tensors from transferred data for `session.run()`
- Results transferred back as Float32Array Transferables

### comlink Integration

- comlink provides RPC-style API over Worker postMessage
- ~3KB gzipped, well-tested
- Supports `Comlink.transfer()` for Transferable objects
- Worker defines methods, main thread calls via `Comlink.wrap(worker)`
- Avoids designing custom message protocol with types and error handling