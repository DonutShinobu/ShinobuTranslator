// Experiment: consume the first detector model while ORT initializes WASM.
// ponytail: ORT 1.27 loadFile only uses ok/headers/arrayBuffer; use a runtime hook if shipping this.
(() => {
  const originalFetch = self.fetch.bind(self);
  let prefetched;
  let requested = false;
  self.addEventListener('message', ({ data }) => {
    if (requested || data?.type !== 'APPLY' || data.path?.at(-1) !== 'createSession'
      || data.argumentList?.[0]?.value !== 'detector') return;
    const url = data.argumentList?.[1]?.value;
    if (typeof url !== 'string') return;
    requested = true;
    const startedAt = performance.now();
    const pending = originalFetch(url).then(async response => {
      const bytes = await response.arrayBuffer();
      self.__shinobuColdStartInitMark?.({ phase: 'model-prefetch', model: 'detector', startedAt, durationMs: performance.now() - startedAt, bytes: bytes.byteLength });
      return { response, bytes };
    });
    void pending.catch(() => {});
    prefetched = { url, pending };
  });
  self.fetch = async (...args) => {
    const url = typeof args[0] === 'string' ? args[0] : args[0].url ?? String(args[0]);
    const method = args[1]?.method ?? (typeof args[0] === 'object' ? args[0]?.method : undefined) ?? 'GET';
    if (!prefetched || prefetched.url !== url || method.toUpperCase() !== 'GET') return originalFetch(...args);
    const pending = prefetched.pending;
    prefetched = undefined;
    const { response, bytes } = await pending;
    response.arrayBuffer = async () => bytes;
    return response;
  };
})();
