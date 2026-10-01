// CPU-only check of capture labels and device-bound template fallback.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./cold-start-worker-probe.js', import.meta.url), 'utf8');
function sandbox(config) {
  const records = [];
  const listeners = new Map();
  let asyncCount = 0;
  let syncCount = 0;
  let moduleCount = 0;
  const device = {
    features: new Set(['subgroups']), limits: { maxComputeInvocationsPerWorkgroup: 256 },
    createShaderModule: descriptor => { moduleCount++; return descriptor; },
    createComputePipeline: descriptor => { syncCount++; return descriptor; },
    createComputePipelineAsync: async descriptor => { asyncCount++; return descriptor; },
  };
  class GPUAdapter {
    info = { vendor: 'test', architecture: 'mock', device: '0', description: 'check' };
    async requestDevice() { return device; }
  }
  const scope = {
    __coldStartExperiment: { ortVersion: '1.27.0', probeUrl: 'http://test', ...config },
    GPUAdapter, navigator: { userAgent: 'Chromium/test' }, performance,
    fetch: async (_, options) => { records.push(JSON.parse(options.body)); },
    addEventListener: (type, listener) => listeners.set(type, listener), postMessage: () => {},
  };
  scope.self = scope;
  runInNewContext(source, scope);
  return { scope, records, listeners, device, count: () => asyncCount,
    syncCount: () => syncCount, moduleCount: () => moduleCount };
}

const capture = sandbox({ capture: true });
await new capture.scope.GPUAdapter().requestDevice();
const request = (id, method, model) => capture.listeners.get('message')({ data: {
  id, type: 'APPLY', path: [method], argumentList: [{ type: 'RAW', value: `${model}:webgpu:` }],
} });
request('detect', 'runDetectWithGpuPreprocess', 'detector');
request('create', 'createSession', 'paddleocr_v6_medium_rec');
const module = capture.device.createShaderModule({ code: 'test shader' });
capture.device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
assert.equal(capture.records.at(-1).model, 'detector');
capture.scope.postMessage({ id: 'detect', type: 'RAW' });
request('bubble', 'runInference', 'bubble');
capture.device.createComputePipeline({ layout: 'auto', compute: { module } });
assert.equal(capture.records.at(-1).model, 'bubble');

const key = capture.records.find(record => record.kind === 'device').key;
const shaders = [{ code: 'test shader', entryPoint: 'main' }];
for (const [templateKey, expected] of [[key, 1], ['stale', 0]]) {
  const experiment = sandbox({ templateKey, shaders, concurrency: 4, overlap: true });
  await new experiment.scope.GPUAdapter().requestDevice();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(experiment.count(), expected);
  assert.equal(experiment.records.some(record => record.kind === 'precompile-skipped'), expected === 0);
}

const reuse = sandbox({ templateKey: key, shaders, concurrency: 4, overlap: true, reusePipelines: true });
await new reuse.scope.GPUAdapter().requestDevice();
await new Promise(resolve => setImmediate(resolve));
reuse.listeners.get('message')({ data: { id: 'run', type: 'APPLY', path: ['runInference'],
  argumentList: [{ value: 'detector:webgpu:' }] } });
const reusedModule = reuse.device.createShaderModule({ code: 'test shader' });
const cached = reuse.device.__experimentPipelines[0];
assert.equal(reuse.device.createComputePipeline({ layout: 'auto', compute: { module: reusedModule, entryPoint: 'main' } }), cached);
assert.equal(reuse.syncCount(), 0);
assert.equal(reuse.moduleCount(), 1);
// Explicit layouts and different specialization constants cannot use the seed.
const explicitLayout = {};
assert.notEqual(reuse.device.createComputePipeline({ layout: explicitLayout, compute: { module: reusedModule, entryPoint: 'main' } }), cached);
assert.notEqual(reuse.device.createComputePipeline({ layout: 'auto', compute: { module: reusedModule, entryPoint: 'main', constants: { n: 4 } } }), cached);
const hinted = reuse.device.createShaderModule({ code: 'test shader', compilationHints: [] });
assert.notEqual(hinted, reusedModule);
assert.notEqual(reuse.device.createComputePipeline({ layout: 'auto', compute: { module: hinted, entryPoint: 'main' } }), cached);
reuse.scope.postMessage({ id: 'run', type: 'RAW' });
const metrics = reuse.records.find(record => record.kind === 'pipeline-reuse');
assert.equal(metrics.model, 'detector');
assert.equal(metrics.pipelineHits, 1);
assert.equal(metrics.pipelineMisses, 3);
assert.equal(metrics.moduleHits, 1);
console.log('cold shader probe check passed');
