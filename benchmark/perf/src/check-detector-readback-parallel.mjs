// CPU-only: execute the actual Worker and inference queue with deferred Tensor downloads.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

const transpile = path => ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const workerJs = transpile('../../../packages/model-runtime/src/workers/onnx-worker.ts');
const queueExports = {};
vm.runInNewContext(transpile('../../../packages/model-runtime/src/workers/inferenceQueue.ts'), { exports: queueExports });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const bytes = data => [...new Uint8Array(data.buffer, data.byteOffset, data.byteLength)];
let cases = 0;

function fixture({ enabled, count = 3, alias = false, cpu = false, type, observe = true, verify = true,
  syncThrow = false, hashReject = false } = {}) {
  const calls = [], marks = [], transfers = [], tensors = [], controls = [];
  const input = { disposeCount: 0, dispose() { this.disposeCount++; } };
  const image = { closed: 0, close() { this.closed++; } };
  const outputNames = Array.from({ length: count }, (_, i) => ['blk:raw', 'seg/raw', 'det raw', 'extra'][i]);
  const outputs = {};
  for (let i = 0; i < count; i++) {
    const gate = deferred();
    const buffer = new ArrayBuffer(32);
    // Include offset, signed zero and a NaN payload; compare exact bytes rather than numeric equality.
    new Uint32Array(buffer, 4, 4).set([0x80000000, 0x7fc0abcd, 0x3f800000 + i, 0x3dcccccd]);
    const data = type === 'int64' && i === 1 ? new BigInt64Array([1n, -2n])
      : type === 'bool' && i === 1 ? new Uint8Array([0, 1, 1, 0]) : new Float32Array(buffer, 4, 4);
    const tensor = { data, dims: [1, i + 1, data.length], type: i === 1 && type ? type : 'float32',
      location: cpu && i === 1 ? 'cpu' : 'gpu-buffer', pending: false, disposeCount: 0,
      getData() {
        calls.push(`download:${i}`);
        assert.equal(this.pending, false, 'never read the same Tensor twice concurrently');
        if (syncThrow && i === 1) throw failure;
        this.pending = true;
        return gate.promise.then(value => { this.location = 'cpu'; return value; }).finally(() => { this.pending = false; });
      },
      dispose() {
        assert.equal(this.pending, false, 'dispose must never run while mapAsync is pending');
        this.disposeCount++; calls.push(`dispose:${i}`);
      },
    };
    tensors.push(tensor); controls.push(gate); outputs[outputNames[i]] = tensor;
  }
  if (alias) outputs[outputNames[1]] = tensors[0];
  const failure = new Error('second download failed');
  const session = { inputNames: ['images'], runCount: 0, releaseCount: 0,
    async run(feeds) {
      this.runCount++; assert.equal(feeds.images, input); calls.push('run'); return outputs;
    }, async release() { this.releaseCount++; calls.push('release'); },
  };
  let api, tick = 0, hashCount = 0;
  const scope = vm.createContext({ exports: {}, ArrayBuffer, Float32Array, BigInt64Array, Uint8Array,
    setTimeout, clearTimeout, console: { log() {}, warn() {}, error() {} },
    performance: { now() { assert.equal(observe, true, 'disabled observer must not read the clock'); return ++tick; } },
    __shinobuColdStartDetectorReadbackParallel: enabled,
    __shinobuColdStartDetectorOutputVerify: verify,
    __shinobuColdStartInitMark: observe ? mark => marks.push(mark) : undefined,
    crypto: { subtle: { async digest(algorithm, data) {
      calls.push(`hash:${hashCount++}`);
      if (hashReject && hashCount === 2) throw failure;
      return webcrypto.subtle.digest(algorithm, data);
    } } },
    require(name) {
      if (name === 'onnxruntime-web/all') return { env: {} };
      if (name === 'comlink') return { expose(value) { api = value; }, transfer(value, list) { transfers.push(list); return value; } };
      if (name.endsWith('/inferenceQueue')) return queueExports;
      if (name.endsWith('/onnxSessionOptions')) return {};
      if (name.endsWith('/errorMessage')) return { toErrorMessage: error => String(error) };
      if (name.endsWith('/onnxTypes')) return {};
      if (name.endsWith('/shaderWarmup')) return { installShaderWarmup() {} };
      if (name === '@shinobu/browser-runtime/trusted-types') return { installTrustedTypesPolicy() {} };
      if (name === './gpuPreprocess') return { async preprocessLetterboxGpu(source, size) {
        assert.equal(source, image); assert.equal(size, 1024);
        return { tensor: input, params: { ratio: 0.5, unpaddedWidth: 1024, unpaddedHeight: 768 } };
      } };
      if (name === './gpuPaddleCtc') return {};
      throw new Error(`Unexpected Worker dependency: ${name}`);
    },
    __sessionEntry: { session, provider: 'webgpu', modelUrl: 'unchanged-detector.ort' },
  });
  vm.runInContext(workerJs, scope);
  vm.runInContext("sessions.set('detector', __sessionEntry)", scope);
  const pending = api.runDetectWithGpuPreprocess('detector', image);
  // Observe rejection immediately, including the intentional pending third download case.
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  return { api, scope, calls, marks, tensors, controls, outputs, outputNames, input, image,
    session, transfers, failure, outcome };
}

function checkResult(check, result) {
  assert.deepEqual(Object.keys(result.outputs), check.outputNames);
  assert.equal(result.ratio, 0.5); assert.equal(result.unpaddedWidth, 1024); assert.equal(result.unpaddedHeight, 768);
  const expectedBuffers = [];
  for (const name of check.outputNames) {
    const tensor = check.outputs[name], transport = result.outputs[name];
    assert.equal(transport.data, tensor.data, 'no conversion/copy of downloaded bytes');
    assert.deepEqual([...transport.dims], tensor.dims);
    assert.notEqual(transport.dims, tensor.dims); assert.equal(transport.type, tensor.type);
    assert.deepEqual(bytes(transport.data), bytes(tensor.data));
    if (tensor.data instanceof Float32Array || tensor.data instanceof BigInt64Array) expectedBuffers.push(tensor.data.buffer);
  }
  assert.deepEqual([...check.transfers[0]], expectedBuffers, 'transfer order equals entries order');
  assert.equal(check.session.runCount, 1); assert.equal(check.input.disposeCount, 1); assert.equal(check.image.closed, 1);
  if (check.scope.__shinobuColdStartDetectorOutputVerify && check.scope.__shinobuColdStartInitMark) {
    const hashes = check.marks.filter(mark => mark.phase === 'detector-output-sha256');
    assert.deepEqual(hashes.map(mark => mark.output), check.outputNames);
    assert.deepEqual(hashes.map(mark => mark.sha256), check.outputNames.map(name =>
      createHash('sha256').update(new Uint8Array(check.outputs[name].data.buffer,
        check.outputs[name].data.byteOffset, check.outputs[name].data.byteLength)).digest('hex')));
    assert.deepEqual(check.marks.slice(2).map(mark => mark.phase), check.outputNames.flatMap(() => ['output-readback', 'detector-output-sha256']));
  }
}

// Completion can be out of order, while all records, hashes and transports retain original order.
for (const observe of [true, false]) {
  const check = fixture({ enabled: true, observe });
  await nextTurn(); assert.deepEqual(check.calls, ['run', 'download:0', 'download:1', 'download:2']);
  check.controls[2].resolve(check.tensors[2].data); check.controls[0].resolve(check.tensors[0].data);
  await nextTurn(); assert.equal(check.transfers.length, 0); assert.equal(check.input.disposeCount, 0);
  check.controls[1].resolve(check.tensors[1].data);
  const outcome = await check.outcome; assert.equal(outcome.error, undefined); checkResult(check, outcome.value);
  assert.ok(check.tensors.every(tensor => tensor.disposeCount === 1));
  if (observe) assert.deepEqual(check.marks.filter(mark => mark.phase === 'output-readback').map(mark => [...mark.dims]), check.tensors.map(tensor => tensor.dims));
  cases++;
}

// Only strict true + exactly three distinct GPU float32 Tensors enables concurrent maps.
for (const options of [{}, { enabled: false }, { enabled: 'true' }, { enabled: true, count: 2 },
  { enabled: true, count: 4 }, { enabled: true, alias: true }, { enabled: true, cpu: true },
  { enabled: true, type: 'int64' }, { enabled: true, type: 'bool' }]) {
  const check = fixture(options);
  await nextTurn(); assert.deepEqual(check.calls, ['run', 'download:0'], 'fallback remains serial');
  for (let i = 0; i < check.tensors.length; i++) {
    check.controls[i].resolve(check.tensors[i].data); await nextTurn();
  }
  const outcome = await check.outcome; assert.equal(outcome.error, undefined); checkResult(check, outcome.value); cases++;
}

// Rejection cannot release any Tensor, input, image or Session before the last pending map ends.
for (const syncThrow of [false, true]) {
  const check = fixture({ enabled: true, syncThrow, verify: false });
  await nextTurn(); assert.deepEqual(check.calls, ['run', 'download:0', 'download:1', 'download:2']);
  check.controls[0].resolve(check.tensors[0].data);
  if (!syncThrow) check.controls[1].reject(check.failure);
  const release = check.api.disposeSession('detector');
  await nextTurn(); assert.equal(check.input.disposeCount, 0); assert.equal(check.image.closed, 0);
  assert.ok(check.tensors.every(tensor => tensor.disposeCount === 0)); assert.equal(check.session.releaseCount, 0);
  check.controls[2].resolve(check.tensors[2].data);
  assert.equal((await check.outcome).error, check.failure);
  await release; assert.ok(check.tensors.every(tensor => tensor.disposeCount === 1));
  assert.equal(check.input.disposeCount, 1); assert.equal(check.image.closed, 1); assert.equal(check.session.releaseCount, 1);
  assert.equal(check.transfers.length, 0); assert.equal(check.marks.filter(mark => mark.phase === 'output-readback').length, 1);
  cases++;
}

const hashFailure = fixture({ enabled: true, hashReject: true });
await nextTurn(); hashFailure.controls.forEach((gate, i) => gate.resolve(hashFailure.tensors[i].data));
assert.equal((await hashFailure.outcome).error, hashFailure.failure);
assert.ok(hashFailure.tensors.every(tensor => !tensor.pending && tensor.disposeCount === 1));
assert.equal(hashFailure.input.disposeCount, 1); assert.equal(hashFailure.image.closed, 1); cases++;
console.log(`PASS detector readback ${cases} cases: strict/default/fallback, exact bytes/dims/order/SHA, all-settled failure cleanup and original inference queue`);
