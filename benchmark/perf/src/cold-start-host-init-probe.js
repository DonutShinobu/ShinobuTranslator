// Diagnostic run only: prepend before extension entry points, not performance A/B runs.
// No payloads or inference inputs are copied. Worker WASM/fetch markers are separate.
(() => {
  const config = globalThis.__shinobuColdStartInitProbe;
  if (!config?.probeUrl || globalThis.__shinobuColdStartInitMark) return;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  const records = [];
  let dropped = 0;
  let flushQueued = false;
  const realm = config.realm ?? (globalThis.document
    ? location.pathname.endsWith('offscreen.html') ? 'offscreen' : 'content'
    : 'background');
  const mark = (record) => {
    try {
      if (records.length >= 2000) { dropped++; return; }
      const startedAt = record.startedAt ?? performance.now();
      records.push({ ...record, startedAt, absoluteStartMs: performance.timeOrigin + startedAt,
        visibilityState: globalThis.document?.visibilityState });
    } catch { /* Diagnostics must not change the application result. */ }
  };
  const flush = () => {
    if (!records.length) return Promise.resolve();
    const body = JSON.stringify({ kind: 'host-init-trace', realm,
      url: location.origin + location.pathname, timeOrigin: performance.timeOrigin,
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      records: records.splice(0), dropped });
    dropped = 0;
    return nativeFetch(config.probeUrl, { method: 'POST', body }).catch(() => {});
  };
  const queueFlush = () => {
    if (flushQueued) return;
    flushQueued = true;
    setTimeout(() => { flushQueued = false; void flush(); }, 0);
  };
  globalThis.__shinobuColdStartInitMark = mark;
  globalThis.__shinobuColdStartInitFlush = flush;
  mark({ phase: 'realm.probe-installed' });

  // Observe Comlink round trips, including Session creation begun before the job logger.
  if (globalThis.Worker) {
    const NativeWorker = globalThis.Worker;
    globalThis.Worker = new Proxy(NativeWorker, {
      construct(target, args, newTarget) {
        const startedAt = performance.now();
        const worker = Reflect.construct(target, args, newTarget);
        const script = String(args[0]).split('/').at(-1);
        mark({ phase: 'worker.construct', startedAt, durationMs: performance.now() - startedAt, script });
        const pending = new Map();
        const sessionModels = new Map();
        const post = worker.postMessage;
        worker.postMessage = function (...postArgs) {
          const data = postArgs[0];
          const method = data?.type === 'APPLY' ? data.path?.at(-1) : undefined;
          if (['init', 'createSession', 'runInference', 'runDetectWithGpuPreprocess', 'disposeSession', 'disposeAll'].includes(method)) {
            const modelOrSession = data.argumentList?.[0]?.value;
            const call = { method, startedAt: performance.now(),
              model: method === 'createSession' ? modelOrSession : sessionModels.get(modelOrSession) };
            if (method === 'createSession') {
              call.preferred = data.argumentList?.[2]?.value;
              call.sessionOptions = JSON.stringify(data.argumentList?.[3]?.value);
            }
            pending.set(data.id, call);
            mark({ phase: 'worker.rpc-start', id: data.id, ...call });
          }
          return Reflect.apply(post, this, postArgs);
        };
        worker.addEventListener('message', ({ data }) => {
          const call = pending.get(data?.id);
          if (!call) return;
          pending.delete(data.id);
          if (call.method === 'createSession' && data.value?.sessionId) {
            sessionModels.set(data.value.sessionId, call.model);
          }
          mark({ phase: 'worker.rpc', id: data.id, ...call, durationMs: performance.now() - call.startedAt,
            status: data.type === 'HANDLER' && data.name === 'throw' ? 'failed' : 'success',
            provider: data.value?.provider, sessionId: call.method === 'createSession' ? data.value?.sessionId : undefined });
        });
        worker.addEventListener('error', () => mark({ phase: 'worker.error', script }));
        return worker;
      },
    });
  }

  const runtime = globalThis.chrome?.runtime;
  const observedPorts = new WeakSet();
  const observePort = (port) => {
    if (!port || observedPorts.has(port) || !['mt:local-pipeline-client', 'mt:pipeline-host'].includes(port.name)) return port;
    observedPorts.add(port);
    mark({ phase: 'port.connected', port: port.name });
    const note = (direction, data) => {
      // Chunk boundaries are relevant; recording Base64 itself would distort the run.
      if (!data?.type) return;
      mark({ phase: `port.${direction}`, port: port.name, type: data.type, jobId: data.jobId,
        stage: data.progress?.stage, chunkIndex: data.index, chars: typeof data.data === 'string' ? data.data.length : undefined,
        bytes: data.binaryFile?.size ?? data.resultBlob?.size, structuredClone: data.structuredClone,
        errorCode: data.error?.code });
      if (data.type === 'complete' || data.type === 'error') queueFlush();
    };
    const post = port.postMessage;
    port.postMessage = function (...args) {
      note('send', args[0]);
      return Reflect.apply(post, this, args);
    };
    port.onMessage.addListener((data) => note('receive', data));
    port.onDisconnect.addListener(() => { mark({ phase: 'port.disconnected', port: port.name }); queueFlush(); });
    return port;
  };
  if (runtime?.connect) {
    const connect = runtime.connect;
    runtime.connect = function (...args) { return observePort(Reflect.apply(connect, this, args)); };
    runtime.onConnect?.addListener(observePort);
  }

  // Preserve callback and Promise contracts, including the identity of returned Promises.
  const observeApi = (owner, method, phase, metadata = () => ({})) => {
    if (!owner?.[method]) return;
    const invoke = owner[method];
    owner[method] = function (...args) {
      const startedAt = performance.now();
      const info = metadata(args);
      let finished = false;
      const finish = (status) => {
        if (finished) return;
        finished = true;
        mark({ phase, ...info, startedAt, durationMs: performance.now() - startedAt, status });
      };
      mark({ phase: `${phase}-start`, ...info, startedAt });
      const callbackIndex = args.length - 1;
      if (typeof args[callbackIndex] === 'function') {
        const callback = args[callbackIndex];
        args[callbackIndex] = function (...callbackArgs) {
          finish(runtime?.lastError ? 'failed' : 'success');
          return Reflect.apply(callback, this, callbackArgs);
        };
      }
      try {
        const result = Reflect.apply(invoke, this, args);
        if (result?.then) void result.then(() => finish('success'), () => finish('failed'));
        return result;
      } catch (error) { finish('failed'); throw error; }
    };
  };
  observeApi(runtime, 'sendMessage', 'runtime.sendMessage', (args) => ({
    type: args.find(x => x && typeof x === 'object' && typeof x.type === 'string')?.type,
    command: args.find(x => x?.command)?.command?.kind,
  }));
  observeApi(runtime, 'getContexts', 'runtime.getContexts');
  observeApi(globalThis.chrome?.offscreen, 'createDocument', 'offscreen.createDocument');
  observeApi(globalThis.chrome?.storage?.local, 'get', 'storage.local.get', (args) => ({
    keys: typeof args[0] === 'string' ? [args[0]] : Array.isArray(args[0]) ? args[0] : Object.keys(args[0] ?? {}),
  }));

  // Main-realm long tasks are a diagnostic of font/CPU contention, not a causal attribution.
  if (globalThis.PerformanceObserver?.supportedEntryTypes.includes('longtask')) {
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) mark({ phase: 'realm.longtask', startedAt: entry.startTime, durationMs: entry.duration });
    });
    observer.observe({ type: 'longtask', buffered: true });
  }
})();
