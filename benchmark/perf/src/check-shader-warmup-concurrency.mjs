// CPU-only check of the real production warmup: history first, exact reuse and fallback.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const sourceUrl = new URL(
  '../../../packages/model-runtime/src/workers/shaderWarmup.ts', import.meta.url,
);
const source = readFileSync(sourceUrl, 'utf8');
assert.equal(source.split('import.meta.url').length, 2);
const js = ts.transpileModule(source.replace('import.meta.url', JSON.stringify(sourceUrl.href)), { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
const key = JSON.stringify(['1.27.0', 'Chrome/154', 'test', 'mock', '', '',
  ['subgroups'], { maxComputeInvocationsPerWorkgroup: 256 }]);
const seedKey = JSON.stringify(JSON.parse(key).map((v, i) => i === 1 ? 'Chrome/151' : v));
const shaders = Array.from({ length: 13 }, (_, i) => ({ code: `shader-${i}`, entryPoint: 'main', constants: { b: 2, a: 0 } }));

function sandbox({ history, templates, reuse, templateKey = seedKey, cacheError, fetchError, compileError } = {}) {
  const releases = [], codes = [], modules = [], sync = [], fetches = [], timers = [], puts = [];
  let active = 0, peak = 0, lose;
  const device = {
    lost: new Promise(resolve => { lose = resolve; }),
    createShaderModule: desc => { const module = { ...desc }; modules.push(module); return module; },
    createComputePipeline: desc => { sync.push(desc); return { native: desc }; },
    createComputePipelineAsync(desc) {
      assert.equal(desc.layout, 'auto');
      codes.push(desc.compute.module.code);
      peak = Math.max(peak, ++active);
      return new Promise((resolve, reject) => { releases.push(() => {
        active--;
        if (compileError === desc.compute.module.code) reject(new Error('compile failed'));
        else resolve({ validated: desc });
      }); });
    },
  };
  const scope = { exports: {}, URL, Response,
    __shinobuColdStartShaderTemplates: templates, __shinobuColdStartReuseShaderPipelines: reuse,
    __shinobuColdStartShaderAsync8: true, // Production history remains four regardless of this old experiment.
    setTimeout: fn => { const timer = { fn }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cancelled = true; },
    fetch: async url => {
      fetches.push(url.href);
      assert.equal(url.href, new URL('webgpu-shader-templates.json', sourceUrl).href);
      if (fetchError) throw new Error('asset unavailable');
      return new Response(JSON.stringify({ key: templateKey, shaders }));
    },
  };
  runInNewContext(js, scope);
  const cache = Promise.resolve({ async match() {
    if (cacheError) throw new Error('cache denied');
    return history ? new Response(JSON.stringify(history)) : undefined;
  }, async put(_, response) { puts.push(await response.json()); } });
  assert.equal(scope.exports.warmDeviceShaders(device, cache, key), undefined, 'warming never awaits compilation');
  return { device, releases, codes, modules, sync, fetches, puts, lose,
    active: () => active, peak: () => peak,
    async drain(bound) { while (releases.length) { releases.shift()(); await tick(); assert.ok(active <= bound); } },
    async persist() { for (const timer of timers) if (!timer.cancelled) timer.fn(); await tick(); },
    descriptor(code = 'shader-0', compute = {}, layout = 'auto', hints) {
      return { layout, compute: { module: device.createShaderModule({ code, ...(hints ? { compilationHints: hints } : {}) }),
        entryPoint: 'main', constants: { a: 0, b: 2 }, ...compute } };
    },
  };
}

const history = sandbox({ history: { key, shaders }, templates: true, reuse: true });
await tick();
assert.equal(history.active(), 4);
assert.equal(history.fetches.length, 0, 'a matching history must suppress the packaged seed');
assert.ok(history.device.createComputePipeline(history.descriptor()).native, 'pending async compilation is a native miss');
await history.drain(4);
assert.equal(history.peak(), 4);
assert.deepEqual(history.codes, shaders.map(shader => shader.code));
const hit = history.device.createComputePipeline(history.descriptor());
assert.ok(hit.validated);
assert.equal(history.sync.length, 1, 'only the pending call used native synchronous creation');
await history.persist();
assert.equal(history.puts.length, 1);
assert.equal(history.puts[0].key, key, 'the stored historical key retains the full UA');
assert.deepEqual(history.puts[0].shaders, [{ code: 'shader-0', entryPoint: 'main', constants: { a: 0, b: 2 } }]);

for (const flag of [undefined, false, 1, 'true', true]) {
  const test = sandbox({ templates: flag, reuse: true });
  await tick();
  assert.equal(test.fetches.length, flag === true ? 1 : 0, 'template flag must be strict true');
  assert.equal(test.active(), flag === true ? 8 : 0);
  await test.drain(8);
}
for (const flag of [undefined, false, 1, 'true', true]) {
  const test = sandbox({ templates: true, reuse: flag });
  await tick();
  assert.equal(test.active(), 8, 'a different UA still uses the compatible packaged seed');
  await test.drain(8);
  assert.equal(!!test.device.createComputePipeline(test.descriptor()).validated, flag === true, 'reuse flag must be strict true');
}

const exact = sandbox({ templates: true, reuse: true, compileError: 'shader-1' });
await tick(); await exact.drain(8);
const moduleCount = exact.modules.length;
assert.equal(exact.device.createComputePipeline(exact.descriptor()).validated.compute.module, exact.modules[0]);
assert.equal(exact.modules.length, moduleCount, 'exact WGSL reuses the seeded module');
for (const descriptor of [exact.descriptor('shader-1'), exact.descriptor('changed shader'),
  exact.descriptor('shader-0', { entryPoint: 'other' }), exact.descriptor('shader-0', { constants: { a: 0, b: 3 } }),
  exact.descriptor('shader-0', { constants: { a: -0, b: 2 } }), exact.descriptor('shader-0', {}, {}),
  exact.descriptor('shader-0', {}, 'auto', [])]) assert.ok(exact.device.createComputePipeline(descriptor).native);
assert.equal(exact.sync.length, 7, 'failure, source/entry/constants/layout/hint mismatches remain native');

for (const index of [0, 2, 3, 4, 5, 6, 7]) {
  const parts = JSON.parse(seedKey);
  parts[index] = index === 6 ? [] : index === 7 ? { maxComputeInvocationsPerWorkgroup: 128 } : 'changed';
  const test = sandbox({ templates: true, reuse: true, templateKey: JSON.stringify(parts) });
  await tick();
  assert.equal(test.codes.length, 0, 'ORT/GPU/features/limits changes reject the seed');
  assert.ok(test.device.createComputePipeline(test.descriptor()).native);
}
for (const options of [{ cacheError: true }, { history: { key: 'old', shaders } }, { history: { key, shaders: [{ code: 42 }] } }]) {
  const test = sandbox({ ...options, templates: true, reuse: true });
  await tick(); assert.equal(test.active(), 8); await test.drain(8);
}
const unavailable = sandbox({ templates: true, reuse: true, fetchError: true });
await tick(); assert.equal(unavailable.codes.length, 0);
assert.ok(unavailable.device.createComputePipeline(unavailable.descriptor()).native);
const lost = sandbox({ templates: true, reuse: true });
await tick(); lost.lose(); await tick(); await lost.drain(8);
assert.equal(lost.codes.length, 8, 'device loss stops further warming');
assert.ok(lost.device.createComputePipeline(lost.descriptor()).native, 'device loss clears the ready cache');
console.log('PASS history4/template8, strict flags, exact validated reuse, UA/capability gates and native failure fallback');
