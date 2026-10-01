// CPU-only forwarding, descriptor-byte accounting, batching and GPU incident check.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./cold-gpu-buffer-submit-probe.js', import.meta.url), 'utf8');
const batches = [], forwarded = [], workerListeners = new Map(), createdDevices = [];
let time = 100;
const submitResult = {}, destroyResult = {}, replyResult = {};
const writeResult = {}, gpuUsage = { MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64 };
function makeDevice() {
  const listeners = new Map();
  let lose;
  const queue = { submit(commands) {
    assert.equal(this, queue);
    forwarded.push(['submit', commands]);
    return submitResult;
  }, writeBuffer(...args) {
    assert.equal(this, queue);
    if (args[2]?.fail) throw new Error('native-write-failure');
    forwarded.push(['write', ...args]);
    return writeResult;
  } };
  const device = { queue, listeners, lost: new Promise(resolve => { lose = resolve; }),
    addEventListener: (type, listener) => listeners.set(type, listener),
    createBuffer(descriptor) {
      assert.equal(this, device);
      if (descriptor.fail) throw new Error('native-create-failure');
      forwarded.push(['buffer', descriptor]);
      const buffer = { size: Number(descriptor.size) + 16, usage: descriptor.usage, destroy(...args) {
        assert.equal(this, buffer);
        forwarded.push(['destroy', ...args]);
        return destroyResult;
      } };
      return buffer;
    }, lose: info => lose(info),
  };
  return device;
}
class GPUAdapter {
  async requestDevice(options) {
    forwarded.push(['device', options]);
    const device = makeDevice();
    createdDevices.push(device);
    return device;
  }
}
const scope = { GPUAdapter, __coldGpuBufferSubmitProbeUrl: 'http://test/worker-probe',
  GPUBufferUsage: gpuUsage,
  performance: { timeOrigin: 1234, now: () => ++time },
  fetch: async (url, options) => { assert.equal(url, 'http://test/worker-probe'); batches.push(JSON.parse(options.body)); },
  addEventListener: (type, listener) => workerListeners.set(type, listener),
  postMessage: (...args) => { forwarded.push(['reply', ...args]); return replyResult; },
};
scope.self = scope;
runInNewContext(source, scope);
const options = { label: 'device' }, adapter = new GPUAdapter();
const device = await adapter.requestDevice(options);
assert.equal(device, createdDevices[0]);
assert.equal(forwarded[0][1], options);
const aDesc = { size: 100 }, bDesc = { size: 200n };
const a = device.createBuffer(aDesc), b = device.createBuffer(bDesc);
assert.equal(forwarded.at(-2)[1], aDesc);
assert.equal(forwarded.at(-1)[1], bDesc);
assert.throws(() => device.createBuffer({ size: 900, fail: true }), /native-create-failure/);
assert.throws(() => a.destroy.call({}), assert.AssertionError);
assert.equal(a.destroy('unchanged-argument'), destroyResult);
assert.equal(a.destroy(), destroyResult);
const commands = [{}];
assert.equal(device.queue.submit(commands), submitResult);
assert.equal(forwarded.at(-1)[1], commands);
assert.equal(device.queue.submit([]), submitResult);
const view = new Uint8Array(new ArrayBuffer(40), 4, 28);
assert.equal(device.queue.writeBuffer(b, 0, view, 4, 8), writeResult);
assert.equal(forwarded.at(-1)[3], view);
assert.deepEqual(forwarded.at(-1).slice(4), [4, 8]);
device.queue.writeBuffer(b, 0, new Uint32Array([1, 2, 3, 4]), 1, 2); // 8 bytes, not 2.
device.queue.writeBuffer(b, 0, new ArrayBuffer(16), 4, 8);
device.queue.writeBuffer(b, 0, new DataView(new ArrayBuffer(24), 4, 16), 4); // 12 bytes.
device.queue.writeBuffer(b, 0, new Uint8Array(32), 4); // 28 bytes.
assert.throws(() => device.queue.writeBuffer.call({}, b, 0, view), assert.AssertionError);
assert.throws(() => device.queue.writeBuffer(b, 0, { fail: true }), /native-write-failure/);
assert.equal(batches.length, 0, 'no uploads during GPU operations');
const request = id => workerListeners.get('message')({ data: { id, type: 'APPLY', path: ['runInference'],
  argumentList: [{ value: 'inpaint:webgpu:session' }] } });
request('inpaint');
assert.equal(scope.postMessage({ id: 'other' }), replyResult);
assert.equal(batches.length, 0);
assert.equal(scope.postMessage({ id: 'inpaint' }), replyResult);
const summary = batches.at(-1).records[0];
assert.equal(batches.at(-1).kind, 'gpu-buffer-submit-batch');
assert.equal(batches.at(-1).reason, 'inpaint-reply');
assert.equal(summary.requestedBytesOnly, true);
assert.equal(summary.requestedBufferBytesCreated, 300);
assert.equal(summary.requestedBufferBytesPeak, 300);
assert.equal(summary.requestedBufferBytesLive, 200);
assert.equal(summary.buffersCreated, 2);
assert.equal(summary.buffersDestroyed, 1);
assert.equal(summary.buffersLive, 1);
assert.equal(summary.buffersPeak, 2);
assert.equal(summary.queueSubmits, 2);
assert.equal(summary.uploadStagingBuffersCreated, 0);
assert.equal(summary.uploadStagingBytesCreated, 0);
assert.equal(summary.queueWriteBufferCalls, 5);
assert.equal(summary.queueWriteBufferBytes, 64);
assert.equal(summary.firstWriteBufferAt, 103);
assert.equal(summary.firstWriteBufferMsSinceDevice, 2);
assert.equal(summary.firstSubmitAt, 102);
assert.equal(summary.firstSubmitMsSinceDevice, 1);
assert.equal(summary.timeOrigin, 1234);
assert.equal(summary.apiTimingEnabled, false);
assert.equal(summary.queueSubmitNativeSyncMs, 0);
assert.equal(summary.queueWriteBufferNativeSyncMs, 0);
assert.equal(summary.uniformWriteBufferCalls, 0);
scope.postMessage({ id: 'inpaint' });
assert.equal(batches.length, 1, 'one matching reply flushes once');
b.destroy();
request('next');
scope.postMessage({ id: 'next' });
assert.equal(batches.at(-1).records[0].requestedBufferBytesLive, 0);
assert.equal(batches.at(-1).records[0].requestedBufferBytesPeak, 300);

const second = await adapter.requestDevice({});
second.createBuffer({ size: 64 });
const staging = second.createBuffer({ size: 32, mappedAtCreation: true, usage: gpuUsage.MAP_WRITE | gpuUsage.COPY_SRC });
staging.destroy();
second.listeners.get('uncapturederror')({ error: { name: 'GPUValidationError', message: 'test-invalid' } });
assert.equal(batches.at(-1).reason, 'uncaptured-error');
assert.equal(batches.at(-1).records[1].requestedBufferBytesLive, 64);
assert.equal(batches.at(-1).records[1].uploadStagingBuffersCreated, 1);
assert.equal(batches.at(-1).records[1].uploadStagingBytesCreated, 32);
assert.equal(batches.at(-1).records[1].queueWriteBufferCalls, 0);
assert.equal(batches.at(-1).records[1].firstWriteBufferAt, null);
assert.equal(batches.at(-1).records[1].uncapturedErrors, 1);
assert.equal(batches.at(-1).records.at(-1).kind, 'gpu-uncaptured-error');
second.lose({ reason: 'unknown', message: 'test-lost' });
await new Promise(resolve => setImmediate(resolve));
assert.equal(batches.at(-1).reason, 'device-lost');
assert.equal(batches.at(-1).records[1].deviceLost, true);
assert.equal(batches.at(-1).records.at(-1).kind, 'gpu-device-lost');
runInNewContext(source, { self: {} }); // No endpoint means no instrumentation.

// One tiny actual-wrapper timing oracle. No GPU and no sleeps: the native mocks
// advance a local clock, so the measured window must surround the native call.
for (const flag of [undefined, false, 'true', true]) {
  const output = [], listeners = new Map();
  let stamp = 0, clockReads = 0;
  const timedDevice = makeDevice(), queue = timedDevice.queue;
  const nativeSubmit = queue.submit, nativeWrite = queue.writeBuffer;
  queue.submit = function (...args) {
    assert.equal(this, queue);
    stamp += 3;
    if (args[0]?.fail) throw new Error('native-submit-failure');
    return nativeSubmit.apply(this, args);
  };
  queue.writeBuffer = function (...args) {
    assert.equal(this, queue);
    stamp += 2;
    return nativeWrite.apply(this, args);
  };
  class TimingAdapter { async requestDevice() { return timedDevice; } }
  const timingScope = {
    GPUAdapter: TimingAdapter, GPUBufferUsage: gpuUsage,
    __coldGpuBufferSubmitProbeUrl: 'http://test/worker-probe', __coldGpuApiTiming: flag,
    performance: { timeOrigin: 1234, now: () => { clockReads++; return ++stamp; } },
    fetch: async (url, options) => { assert.equal(url, 'http://test/worker-probe'); output.push(JSON.parse(options.body)); },
    addEventListener: (type, listener) => listeners.set(type, listener), postMessage: () => replyResult,
  };
  timingScope.self = timingScope;
  runInNewContext(source, timingScope);
  await new TimingAdapter().requestDevice();
  assert.equal(queue.submit(commands), submitResult);
  assert.equal(forwarded.at(-1)[1], commands);
  queue.submit([]);
  assert.throws(() => queue.submit.call({}, []), assert.AssertionError);
  assert.throws(() => queue.submit({ fail: true }), /native-submit-failure/);
  const uniform = timedDevice.createBuffer({ size: 64, usage: gpuUsage.UNIFORM | gpuUsage.COPY_DST });
  const data = timedDevice.createBuffer({ size: 64, usage: gpuUsage.COPY_DST });
  const typed = Uint32Array.of(1, 2, 3, 4);
  assert.equal(queue.writeBuffer(uniform, 0, typed, 1, 2), writeResult);
  assert.equal(forwarded.at(-1)[3], typed);
  assert.deepEqual(forwarded.at(-1).slice(4), [1, 2]);
  queue.writeBuffer(uniform, 0, view, 4); // 24 bytes from this 28-byte view.
  queue.writeBuffer(data, 0, new ArrayBuffer(16), 4, 8);
  assert.throws(() => queue.writeBuffer.call({}, uniform, 0, view), assert.AssertionError);
  assert.throws(() => queue.writeBuffer(uniform, 0, { fail: true }), /native-write-failure/);
  assert.equal(output.length, 0, 'timing never emits per API call');
  listeners.get('message')({ data: { id: 'timed', type: 'APPLY', path: ['runInference'],
    argumentList: [{ value: 'inpaint:webgpu:session' }] } });
  timingScope.postMessage({ id: 'timed' });
  const stats = output[0].records[0], on = flag === true;
  assert.equal(stats.apiTimingEnabled, on);
  assert.equal(stats.queueSubmits, 2);
  assert.equal(stats.queueWriteBufferCalls, 3);
  assert.equal(stats.queueWriteBufferBytes, 40);
  assert.equal(stats.queueSubmitNativeSyncMs, on ? 8 : 0);
  assert.equal(stats.maxQueueSubmitNativeSyncMs, on ? 4 : 0);
  assert.equal(stats.queueWriteBufferNativeSyncMs, on ? 9 : 0);
  assert.equal(stats.uniformWriteBufferCalls, on ? 2 : 0);
  assert.equal(stats.uniformWriteBufferBytes, on ? 32 : 0);
  assert.equal(stats.uniformWriteBufferNativeSyncMs, on ? 6 : 0);
  assert.equal(stats.maxUniformWriteBufferNativeSyncMs, on ? 3 : 0);
  assert.equal(clockReads, on ? 13 : 3, 'disabled timing adds no clock calls');
}
console.log('PASS GPU buffer API forwarding, bytes, batches, incidents and strict optional native timing');
