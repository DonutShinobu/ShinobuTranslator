import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../../../packages/model-runtime/src/workers/onnx-worker.ts', import.meta.url), 'utf8');
const start = source.indexOf('async function probeWebGpuAvailability');
const end = source.indexOf('function getExecutionProviderAttempts', start);
assert.ok(start >= 0 && end > start);
const js = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
let calls = 0, device;
const context = vm.createContext({
  navigator: { gpu: { async requestAdapter() { calls++; return {}; } } },
  getWebGpuDevice: () => device, toErrorMessage: error => error.message,
});
vm.runInContext(js, context);
assert.equal((await context.probeWebGpuAvailability()).available, true);
assert.equal(calls, 1);
context.__shinobuColdStartReuseGpuAvailability = true;
await context.probeWebGpuAvailability();
assert.equal(calls, 2, 'first session still probes without an ORT device');
device = {};
await context.probeWebGpuAvailability();
assert.equal(calls, 2, 'subsequent sessions reuse availability');
context.__shinobuColdStartReuseGpuAvailability = false;
await context.probeWebGpuAvailability();
assert.equal(calls, 3, 'default path unchanged');
context.__shinobuColdStartReuseGpuAvailability = true;
device = undefined;
context.navigator.gpu.requestAdapter = async () => null;
assert.equal((await context.probeWebGpuAvailability()).available, false);
context.navigator.gpu.requestAdapter = async () => { throw new Error('lost'); };
assert.match((await context.probeWebGpuAvailability()).reason, /lost/);
console.log('GPU availability reuse check passed');
