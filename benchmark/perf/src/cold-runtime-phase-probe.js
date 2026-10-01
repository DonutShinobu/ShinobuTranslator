// Diagnostic only: buffered Worker records, one upload after the inpaint reply.
(() => {
  const records = [];
  const requests = new Map();
  const originalFetch = self.fetch.bind(self);
  const record = data => records.push({ kind: 'runtime-phase', realm: 'onnx-worker', timeOrigin: performance.timeOrigin, ...data });
  self.__shinobuColdStartInitMark = record;
  self.fetch = async (...args) => {
    const url = typeof args[0] === 'string' ? args[0] : args[0].url ?? String(args[0]);
    const startedAt = performance.now();
    const response = await originalFetch(...args);
    record({ phase: 'fetch-headers', url, startedAt, durationMs: performance.now() - startedAt });
    const read = response.arrayBuffer.bind(response);
    response.arrayBuffer = async () => {
      const startedAt = performance.now();
      const bytes = await read();
      record({ phase: 'fetch-body', url, startedAt, durationMs: performance.now() - startedAt, bytes: bytes.byteLength });
      return bytes;
    };
    return response;
  };
  for (const method of ['compile', 'compileStreaming', 'instantiate', 'instantiateStreaming']) {
    const original = WebAssembly[method].bind(WebAssembly);
    WebAssembly[method] = async (...args) => {
      const startedAt = performance.now();
      const result = await original(...args);
      record({ phase: `wasm-${method}`, startedAt, durationMs: performance.now() - startedAt });
      return result;
    };
  }
  if (self.navigator?.gpu) {
    const request = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = async (...args) => {
      const startedAt = performance.now();
      const result = await request(...args);
      record({ phase: 'gpu-request-adapter', startedAt, durationMs: performance.now() - startedAt, options: args[0] });
      return result;
    };
  }
  if (typeof GPUAdapter !== 'undefined') {
    const request = GPUAdapter.prototype.requestDevice;
    GPUAdapter.prototype.requestDevice = async function (...args) {
      const startedAt = performance.now();
      const result = await request.apply(this, args);
      record({ phase: 'gpu-request-device', startedAt, durationMs: performance.now() - startedAt });
      return result;
    };
  }
  self.addEventListener('message', ({ data }) => {
    if (data?.type === 'APPLY') requests.set(data.id, { method: data.path?.at(-1), model: data.argumentList?.[0]?.value?.split?.(':')[0] });
  });
  const post = self.postMessage.bind(self);
  self.postMessage = (data, ...args) => {
    const request = requests.get(data?.id);
    const result = post(data, ...args);
    requests.delete(data?.id);
    if (request?.method === 'runInference' && request.model === 'inpaint') {
      void originalFetch(self.__coldRuntimeProbeUrl, { method: 'POST', body: JSON.stringify({ kind: 'runtime-phase-batch', records: records.splice(0) }) }).catch(() => {});
    }
    return result;
  };
})();
