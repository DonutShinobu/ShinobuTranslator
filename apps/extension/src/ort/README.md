# Browser-only ONNX Runtime entries

These modules are the browser-targeted Rollup output of the matching
`onnxruntime-web@1.24.1` Emscripten modules in `public/ort`.

The upstream modules also contain Node worker bootstrap branches. Extension
store products use these app-owned entries so their literal import graph
contains only packaged browser artifacts. Keep them in sync with the
`onnxruntime-web` version. The extension release boundary verifies that every
entry still exposes the required default factory.
