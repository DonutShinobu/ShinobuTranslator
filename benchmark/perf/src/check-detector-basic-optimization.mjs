// CPU-only: verify the experiment's scope and actual-options cache/pending identity.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const runtimePath = '../../../packages/model-runtime/src/runtime/';
const transpile = name => ts.transpileModule(
  readFileSync(new URL(runtimePath + name, import.meta.url), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;
const sessionOptions = { exports: {} };
runInNewContext(transpile('onnxSessionOptions.ts'), sessionOptions);
const registryJs = transpile('modelRegistry.ts');
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function fixture({ environment = 'browser', format = 'ort', delayed = false } = {}) {
  const calls = [], releases = [], events = [];
  const manifest = { models: {
    detector: { name: 'detector', task: 'detect', url: '/models/detector.ort', format,
      input: [1024, 1024], runtime: ['webgpu', 'webnn', 'wasm'] },
    bubble: { name: 'bubble', task: 'bubble', url: '/models/bubble.onnx', format: 'onnx',
      input: [640, 640], runtime: ['webgpu', 'webnn', 'wasm'] },
  } };
  const scope = { exports: {}, __shinobuColdStartDetectorBasicOptimization: undefined,
    require: name => { assert.equal(name, './onnxSessionOptions'); return sessionOptions.exports; } };
  runInNewContext(registryJs, scope);
  const registry = scope.exports.createModelRegistry({ environment,
    loadManifest: async () => manifest,
    performanceObserver: { recordRuntimeEvent: event => events.push(plain(event)) },
    backend: {
      createSession(model, url, preferred, options) {
        const handle = { sessionId: `session-${calls.length}`, provider: preferred[0] };
        calls.push({ model, url, preferred: plain(preferred), options: plain(options), handle });
        return delayed
          ? new Promise(resolve => { releases.push(() => resolve(handle)); })
          : Promise.resolve(handle);
      },
      async disposeSession() {}, async disposeAll() {},
    },
  });
  return { registry, calls, releases, events, scope, manifest };
}

const check = fixture();
const extended = await check.registry.getSession('detector');
assert.deepEqual(check.calls[0].options, {
  graphOptimizationLevel: 'extended', useOrtModelBytesForInitializers: true,
});
check.scope.__shinobuColdStartDetectorBasicOptimization = true;
const basic = await check.registry.getSession('detector');
assert.notEqual(basic, extended);
assert.deepEqual(check.calls[1].options, {
  graphOptimizationLevel: 'basic', useOrtModelBytesForInitializers: true,
});
assert.equal(await check.registry.getSession('detector'), basic);
const explicit = { graphOptimizationLevel: 'extended' };
assert.equal(await check.registry.getSession('detector', undefined, explicit), extended);
assert.deepEqual(explicit, { graphOptimizationLevel: 'extended' });
check.scope.__shinobuColdStartDetectorBasicOptimization = false;
assert.equal(await check.registry.getSession('detector'), extended);
check.scope.__shinobuColdStartDetectorBasicOptimization = 'true';
assert.equal(await check.registry.getSession('detector'), extended);
assert.equal(check.calls.length, 2);
assert.ok(check.events.filter(event => event.kind === 'session-create-start')
  .map(event => event.data.sessionOptionsKey).every((key, i) => key.includes(i ? 'basic' : 'extended')));
for (const call of check.calls) {
  assert.equal(call.url, '/models/detector.ort');
  assert.deepEqual(call.preferred, ['webgpu', 'webnn', 'wasm']);
}
assert.deepEqual(check.manifest.models.detector.input, [1024, 1024]);
await check.registry.dispose();

for (const [settings, name, providers, expectedOptions] of [
  [{}, 'detector', ['wasm'], { graphOptimizationLevel: 'extended', useOrtModelBytesForInitializers: true }],
  [{}, 'detector', ['webnn', 'webgpu'], { graphOptimizationLevel: 'extended', useOrtModelBytesForInitializers: true }],
  [{ format: 'onnx' }, 'detector', undefined, undefined],
  [{ environment: 'node' }, 'detector', undefined, undefined],
  [{}, 'bubble', undefined, undefined],
]) {
  const excluded = fixture(settings);
  excluded.scope.__shinobuColdStartDetectorBasicOptimization = true;
  await excluded.registry.getSession(name, providers);
  assert.deepEqual(excluded.calls[0].options, expectedOptions);
  await excluded.registry.dispose();
}

const pending = fixture({ delayed: true });
pending.scope.__shinobuColdStartDetectorBasicOptimization = true;
const first = pending.registry.getSession('detector');
const duplicate = pending.registry.getSession('detector');
await new Promise(resolve => setImmediate(resolve));
assert.equal(pending.calls.length, 1, 'identical actual options share a pending creation');
pending.scope.__shinobuColdStartDetectorBasicOptimization = false;
const different = pending.registry.getSession('detector');
await new Promise(resolve => setImmediate(resolve));
assert.equal(pending.calls.length, 2, 'different graph options need separate pending sessions');
pending.releases.forEach(release => release());
assert.equal(await first, await duplicate);
assert.notEqual(await first, await different);
await pending.registry.dispose();
console.log('PASS detector basic scope, explicit overrides, cache and pending identity');
