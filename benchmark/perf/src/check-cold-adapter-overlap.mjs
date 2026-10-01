// CPU-only: run the actual Worker createSession/probe with deferred GPU/WASM mocks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../../../packages/model-runtime/src/workers/onnx-worker.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

function fixture({ enabled = true, forceFallbackAdapter, retryAdapter = true, firstThrows = false } = {}) {
  const first = deferred(), wasm = deferred();
  const requests = [], calls = [], events = [], marks = [], devices = [];
  let api, backend;
  const adapter = name => ({ name, limits: {}, features: new Set(),
    async requestDevice(descriptor) {
      devices.push({ adapter: name, descriptor });
      return { from: name };
    } });
  const prefetchedAdapter = adapter('prefetched'), ortAdapter = adapter('ort');
  const ort = { env: { wasm: {}, webgpu: { forceFallbackAdapter }, versions: { web: '1.27.0' } },
    InferenceSession: { async create(url, options) {
      calls.push({ url, options: JSON.parse(JSON.stringify(options)) });
      if (options.executionProviders[0] === 'webgpu') {
        backend ??= (async () => {
          events.push('wasm-start');
          await wasm.promise;
          const selected = ort.env.webgpu.adapter ?? await scope.navigator.gpu.requestAdapter({
            powerPreference: ort.env.webgpu.powerPreference,
            forceFallbackAdapter: ort.env.webgpu.forceFallbackAdapter,
          });
          if (!selected) throw new Error('ORT cannot obtain adapter');
          // Device creation/locking belong to ORT, not the overlap helper.
          const device = await selected.requestDevice({ label: 'unchanged-ORT-device-descriptor' });
          Object.defineProperty(ort.env.webgpu, 'device', { value: device, writable: false, configurable: true });
          Object.defineProperty(ort.env.webgpu, 'adapter', { value: selected, writable: false, configurable: false });
        })();
        await backend;
      }
      return { inputNames: ['images'], outputNames: ['output'], async release() {} };
    } } };
  const scope = vm.createContext({
    exports: {}, performance, setTimeout, clearTimeout,
    console: { warn() {}, log() {}, error() {} },
    __shinobuColdStartAdapterOverlap: enabled,
    __shinobuColdStartInitMark: record => marks.push(record),
    navigator: { hardwareConcurrency: 8, gpu: { requestAdapter(options) {
      requests.push(options === undefined ? undefined : { ...options });
      events.push('adapter-start');
      if (requests.length === 1) {
        if (firstThrows) throw new Error('request failed synchronously');
        return first.promise;
      }
      return Promise.resolve(retryAdapter ? ortAdapter : null);
    } } },
    require(name) {
      if (name === 'onnxruntime-web/all') return ort;
      if (name === 'comlink') return { expose(value) { api = value; } };
      if (name.endsWith('/onnxSessionOptions')) return { serializeOnnxSessionOptions: value => JSON.stringify(value) ?? 'default' };
      if (name.endsWith('/errorMessage')) return { toErrorMessage: error => error?.message ?? String(error) };
      if (name.endsWith('/onnxTypes')) return { isCreateTimeoutError: () => false, isContextLostRuntimeError: () => false };
      if (name.endsWith('/inferenceQueue')) return { SerialInferenceQueue: class { enqueue(task) { return Promise.resolve().then(task); } } };
      if (name.endsWith('/shaderWarmup')) return { installShaderWarmup() {} };
      if (name === '@shinobu/browser-runtime/trusted-types') return { installTrustedTypesPolicy() {} };
      if (name === './gpuPreprocess' || name === './gpuPaddleCtc') return {};
      throw new Error(`Unexpected Worker dependency: ${name}`);
    },
  });
  vm.runInContext(js, scope);
  const create = (model = 'detector') => api.createSession(model, `/models/${model}.ort`, ['webgpu', 'wasm'], {
    graphOptimizationLevel: 'extended', useOrtModelBytesForInitializers: true,
  });
  return { scope, api, ort, first, wasm, requests, calls, events, marks, devices, prefetchedAdapter, ortAdapter, create };
}

const baseline = fixture({ enabled: false });
const baselineSession = baseline.create();
await nextTurn();
assert.equal(baseline.calls.length, 0, 'default still awaits its existing availability preflight');
baseline.first.resolve(baseline.prefetchedAdapter);
await nextTurn();
baseline.wasm.resolve();
assert.equal((await baselineSession).provider, 'webgpu');
assert.equal(baseline.requests.length, 2);
assert.equal(baseline.requests[0], undefined, 'default preflight options unchanged');

for (const forceFallbackAdapter of [undefined, false, true]) {
  const early = fixture({ forceFallbackAdapter });
  const first = early.create(), concurrent = early.create('bubble');
  await nextTurn();
  assert.equal(early.requests.length, 1, 'concurrent model creation shares the first adapter request');
  assert.equal(early.calls.length, 2, 'ORT creation begins while adapter request remains pending');
  assert.equal(early.events.filter(x => x === 'wasm-start').length, 1);
  assert.deepEqual(early.requests[0], { powerPreference: 'high-performance', forceFallbackAdapter });
  assert.equal(early.devices.length, 0, 'overlap helper never creates a device');
  early.first.resolve(early.prefetchedAdapter);
  await nextTurn();
  assert.equal(early.ort.env.webgpu.adapter, early.prefetchedAdapter);
  early.wasm.resolve();
  assert.equal((await first).provider, 'webgpu');
  assert.equal((await concurrent).provider, 'webgpu');
  assert.equal(early.devices.length, 1, 'ORT retains sole device creation');
  assert.equal(early.requests.length, 1, 'initEp uses the supplied adapter');
  assert.deepEqual(early.calls[0], baseline.calls[0], 'model URL and SessionOptions unchanged');
  assert.ok(early.marks.some(mark => mark.phase === 'adapter-overlap-assigned'));
  await early.create('inpaint');
  assert.equal(early.requests.length, 1, 'later sessions reuse the same device/adapter');
  assert.equal(early.devices.length, 1);
}

for (const result of ['null', 'rejection', 'sync-error']) {
  const failed = fixture({ firstThrows: result === 'sync-error' });
  const pending = failed.create();
  await nextTurn();
  if (result === 'null') failed.first.resolve(null);
  if (result === 'rejection') failed.first.reject(new Error('early request failed'));
  await nextTurn();
  assert.equal(failed.ort.env.webgpu.adapter, undefined);
  failed.wasm.resolve();
  assert.equal((await pending).provider, 'webgpu', 'real ORT request remains responsible for initialization');
  assert.equal(failed.requests.length, 2);
  assert.deepEqual(failed.requests[1], { powerPreference: 'high-performance', forceFallbackAdapter: undefined });
  assert.equal(failed.ort.env.webgpu.adapter, failed.ortAdapter);
}

const unavailable = fixture({ retryAdapter: false });
const fallback = unavailable.create();
await nextTurn();
unavailable.first.resolve(null);
unavailable.wasm.resolve();
assert.equal((await fallback).provider, 'wasm', 'real provider fallback remains available');
assert.equal(unavailable.devices.length, 0);
assert.deepEqual(unavailable.calls.map(call => call.options.executionProviders), [['webgpu'], ['wasm']]);

const late = fixture();
const lateSession = late.create();
await nextTurn();
late.wasm.resolve();
assert.equal((await lateSession).provider, 'webgpu');
const locked = late.ort.env.webgpu.adapter;
late.first.resolve(late.prefetchedAdapter);
await nextTurn();
assert.equal(late.ort.env.webgpu.adapter, locked, 'late completion must not replace ORT selected/locked adapter');
assert.equal(late.devices.length, 1);
assert.ok(late.marks.some(mark => mark.phase === 'adapter-overlap-unused'));

const lockedEmpty = fixture();
Object.defineProperty(lockedEmpty.ort.env.webgpu, 'adapter', { value: undefined, writable: false, configurable: false });
assert.equal((await lockedEmpty.scope.probeWebGpuAvailability()).available, true);
lockedEmpty.first.resolve(lockedEmpty.prefetchedAdapter);
await nextTurn();
assert.equal(lockedEmpty.ort.env.webgpu.adapter, undefined, 'nonwritable adapter is left untouched');

const noApi = fixture();
noApi.scope.navigator.gpu = undefined;
assert.equal((await noApi.scope.probeWebGpuAvailability()).available, false);
assert.equal(noApi.requests.length, 0);

const observerError = fixture();
observerError.scope.__shinobuColdStartInitMark = () => { throw new Error('diagnostic failed'); };
assert.equal((await observerError.scope.probeWebGpuAvailability()).available, true);
observerError.first.resolve(observerError.prefetchedAdapter);
await nextTurn();
assert.equal(observerError.ort.env.webgpu.adapter, observerError.prefetchedAdapter);
console.log('PASS adapter overlap: unchanged defaults/policy/options, one pending request, no self-created device, null/rejection/fallback/late/locked safety');
