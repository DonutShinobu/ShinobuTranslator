export function importOrtRuntimeModule(reference) {
  if (typeof reference !== 'string') {
    throw new Error('ORT runtime module reference must be a string.');
  }
  const path = reference.split(/[?#]/u, 1)[0].replaceAll('\\', '/');
  const fileName = path.slice(path.lastIndexOf('/') + 1);
  switch (fileName) {
    case 'ort-wasm-simd-threaded.asyncify.mjs':
      return import('/ort/ort-wasm-simd-threaded.asyncify.mjs');
    case 'ort-wasm-simd-threaded.jsep.mjs':
      return import('/ort/ort-wasm-simd-threaded.jsep.mjs');
    case 'ort-wasm-simd-threaded.mjs':
      return import('/ort/ort-wasm-simd-threaded.mjs');
    default:
      throw new Error(`Unsupported ORT runtime module: ${reference}`);
  }
}
