# Browser-only ONNX Runtime entries

These modules are deterministic browser-targeted Rollup output from the
matching `onnxruntime-web@1.24.1` Emscripten modules.

The upstream modules also contain Node worker bootstrap branches. Extension
store products use these app-owned entries so their literal import graph
contains only packaged browser artifacts. Source hashes, tool versions, and
the retained upstream MIT notice are pinned by
`scripts/generate-browser-ort-entries.mjs`.

After updating `onnxruntime-web`, update the pins and run:

```text
node apps/extension/scripts/generate-browser-ort-entries.mjs --write
```

Normal extension builds run the generator in `--check` mode and fail on any
byte drift. The release boundary separately verifies that every entry exposes
the required default factory and that all paired WASM artifacts exist.
