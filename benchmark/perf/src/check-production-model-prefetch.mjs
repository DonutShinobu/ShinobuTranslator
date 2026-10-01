// Tiny CPU gate: production helper plus the installed ORT's real browser loadFile.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const compile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const helper = compile('../../../packages/model-runtime/src/workers/modelPrefetch.ts');
const loader = compile('../../../node_modules/onnxruntime-web/lib/wasm/wasm-utils-load-file.ts');
const url = 'https://models.example/detector.ort', bytes = Uint8Array.of(79, 82, 84, 77);
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const response = (status = 200, length = bytes.length) => new Response(bytes, {
  status, headers: { 'Content-Length': String(length), 'Content-Type': 'application/octet-stream' },
});
let cases = 0;
function fixture(flag = true, syncThrow = false) {
  const first = deferred(), calls = [];
  const original = (input, init) => {
    calls.push([input, init]);
    if (init?.signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    if (calls.length === 1) {
      if (syncThrow) throw new Error('speculative fetch failed');
      init?.signal?.addEventListener('abort', () => first.reject(new DOMException('Aborted', 'AbortError')), { once: true });
      return first.promise;
    }
    return Promise.resolve(response());
  };
  const scope = vm.createContext({ exports: {}, fetch: original, AbortController, Response, Uint8Array,
    __shinobuColdStartModelPrefetch: flag,
    require(name) { assert.equal(name, './wasm-utils-env'); return { isNode: false }; },
  });
  vm.runInContext(helper, scope); vm.runInContext(loader, scope);
  return { first, calls, original, scope, begin: scope.exports.beginFirstDetectorModelPrefetch,
    load: scope.exports.loadFile };
}
const exact = value => assert.deepEqual([...value], [...bytes]);

for (const flag of [undefined, false, 'true']) {
  const check = fixture(flag); if (flag === undefined) delete check.scope.__shinobuColdStartModelPrefetch;
  assert.equal(check.begin('detector', url), undefined); assert.equal(check.calls.length, 0);
  assert.equal(check.scope.fetch, check.original); cases++;
}
const unrelated = fixture();
for (const args of [['bubble', url], ['detector', ''], ['detector', undefined]]) {
  assert.equal(unrelated.begin(...args), undefined); assert.equal(unrelated.calls.length, 0); cases++;
}
unrelated.scope.AbortController = undefined;
assert.equal(unrelated.begin('detector', url), undefined); assert.equal(unrelated.calls.length, 0); cases++;

// ORT can begin WASM work immediately, whichever of WASM/model reading finishes first.
for (const modelFirst of [true, false]) {
  const check = fixture(), wasm = deferred(), events = [];
  const cleanup = check.begin('detector', url);
  assert.equal(typeof cleanup, 'function'); assert.equal(check.calls.length, 1);
  events.push('wasm-start');
  const session = wasm.promise.then(() => { events.push('wasm-ready'); return check.load(url); });
  if (modelFirst) { check.first.resolve(response()); await turn(); assert.deepEqual(events, ['wasm-start']); }
  wasm.resolve(); await turn(); assert.equal(events[1], 'wasm-ready');
  if (!modelFirst) check.first.resolve(response());
  exact(await session); assert.equal(check.calls.length, 1, 'ORT consumes the prefetched bytes once');
  assert.equal(check.scope.fetch, check.original); cleanup();
  exact(await check.load(url)); assert.equal(check.calls.length, 2, 'provider retry uses ordinary fetch');
  assert.equal(check.begin('detector', url), undefined); assert.equal(check.begin('detector', url + '?next'), undefined);
  cases++;
}

const methods = fixture(), methodsCleanup = methods.begin('detector', url);
for (const [input, init] of [[url, { method: 'POST' }], [url, { method: 'HEAD' }], [url, { method: 'GET' }],
  [new URL(url), undefined], [new Request(url), undefined], [url, { headers: { x: 'keep' }, credentials: 'omit' }],
  [url + '?other', undefined]]) {
  exact(new Uint8Array(await (await methods.scope.fetch(input, init)).arrayBuffer()));
  assert.equal(methods.calls.at(-1)[0], input); assert.equal(methods.calls.at(-1)[1], init); cases++;
}
const callerAbort = new AbortController(); callerAbort.abort();
await assert.rejects(methods.scope.fetch(url, { signal: callerAbort.signal }), error => error.name === 'AbortError'); cases++;
methods.first.resolve(response()); exact(await methods.load(url)); methodsCleanup();

for (const failure of ['fetch-reject', 'fetch-sync', 'body-reject', 'immutable-body-method']) {
  const check = fixture(true, failure === 'fetch-sync'), cleanup = check.begin('detector', url);
  if (failure === 'fetch-reject') check.first.reject(new Error('speculative error'));
  if (failure === 'body-reject') { const r = response(); r.arrayBuffer = async () => { throw new Error('body failed'); }; check.first.resolve(r); }
  if (failure === 'immutable-body-method') { const r = response(); Object.defineProperty(r, 'arrayBuffer', { value: r.arrayBuffer, writable: false }); check.first.resolve(r); }
  await turn(); exact(await check.load(url)); assert.equal(check.calls.length, 2, 'failure resumes ORT original GET');
  assert.equal(check.calls[1][1], undefined); cleanup(); cases++;
}

const failedHttp = fixture(), httpCleanup = failedHttp.begin('detector', url), httpResponse = response(404);
failedHttp.first.resolve(httpResponse);
await assert.rejects(failedHttp.load(url), /failed to load external data file/);
assert.equal(httpResponse.bodyUsed, false); assert.equal(failedHttp.calls.length, 1); httpCleanup();
exact(await failedHttp.load(url)); cases++;

const streaming = fixture(), streamingCleanup = streaming.begin('detector', url), largeResponse = response(200, 1073741824);
streaming.first.resolve(largeResponse);
assert.equal(await streaming.scope.fetch(url), largeResponse); assert.equal(largeResponse.bodyUsed, false);
exact(new Uint8Array(await largeResponse.arrayBuffer())); streamingCleanup(); cases++;

const canceled = fixture(), canceledCleanup = canceled.begin('detector', url);
canceledCleanup(); canceledCleanup(); await turn();
assert.equal(canceled.calls[0][1].signal.aborted, true); assert.equal(canceled.scope.fetch, canceled.original);
exact(await canceled.load(url)); cases++;
const consumed = fixture(), consumedCleanup = consumed.begin('detector', url), consumedLoad = consumed.load(url);
consumedCleanup(); assert.equal(consumed.calls[0][1].signal.aborted, false, 'claimed fetch belongs to ORT');
consumed.first.resolve(response()); exact(await consumedLoad); cases++;

const wrapped = fixture(), wrappedCleanup = wrapped.begin('detector', url), oneUse = wrapped.scope.fetch;
const laterWrapper = (...args) => oneUse(...args); wrapped.scope.fetch = laterWrapper; wrappedCleanup(); await turn();
assert.equal(wrapped.scope.fetch, laterWrapper, 'cleanup does not overwrite a later wrapper'); exact(await wrapped.load(url)); cases++;
const locked = fixture(), lockedCleanup = locked.begin('detector', url);
Object.defineProperty(locked.scope, 'fetch', { value: locked.scope.fetch, writable: false });
locked.first.resolve(response()); exact(await locked.load(url)); lockedCleanup(); exact(await locked.load(url)); cases++;
const cannotInstall = fixture(); Object.defineProperty(cannotInstall.scope, 'fetch', { value: cannotInstall.original, writable: false });
assert.equal(cannotInstall.begin('detector', url), undefined); await turn();
assert.equal(cannotInstall.calls[0][1].signal.aborted, true); exact(await cannotInstall.load(url)); cases++;
console.log(`PASS production model prefetch ${cases} cases: real ORT loadFile, nonblocking WASM/model overlap, one-use/default/method/provider/error/abort lifetime`);
