import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./cold-start-host-init-probe.js', import.meta.url), 'utf8');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); },
  emit(...args) { for (const fn of this.listeners) fn(...args); } });
class FakeWorker {
  constructor(...args) { this.args = args; this.listeners = new Map(); this.sent = []; }
  postMessage(...args) { this.sent.push(args); }
  addEventListener(type, fn) { this.listeners.set(type, [...this.listeners.get(type) ?? [], fn]); }
  emit(type, data) { for (const fn of this.listeners.get(type) ?? []) fn({ data }); }
}
const makePort = (name) => ({ name, sent: [], onMessage: event(), onDisconnect: event(),
  postMessage(...args) { this.sent.push(args); } });
const port = makePort('mt:local-pipeline-client');
const sentMessages = [];
const callbacks = [];
const timers = [];
const posts = [];
let tick = 10;
const runtime = {
  onConnect: event(), connect: () => port,
  sendMessage(...args) {
    sentMessages.push(args);
    if (typeof args.at(-1) === 'function') { callbacks.push(args.at(-1)); return undefined; }
    return runtime.nextPromise;
  },
  getContexts: () => Promise.resolve([]),
};
const realm = {
  __shinobuColdStartInitProbe: { probeUrl: 'http://127.0.0.1/worker-probe', realm: 'offscreen' },
  location: { origin: 'chrome-extension://fixture', pathname: '/offscreen.html' },
  document: { visibilityState: 'hidden' },
  performance: { now: () => tick++, timeOrigin: 1000 },
  Worker: FakeWorker, chrome: { runtime },
  setTimeout: (fn) => { timers.push(fn); },
  fetch: async (url, options) => { posts.push({ url, body: JSON.parse(options.body) }); },
};
vm.runInNewContext(source, realm);
const wrapped = realm.Worker;
vm.runInNewContext(source, realm);
assert.equal(realm.Worker, wrapped, 'Multiple prepended chunks must not reinstall wrappers');

const options = { type: 'module' };
const worker = new realm.Worker('chrome-extension://fixture/onnxWorker.js', options);
assert(worker instanceof FakeWorker);
assert(worker instanceof realm.Worker);
assert.deepEqual(worker.args, ['chrome-extension://fixture/onnxWorker.js', options]);
const message = { id: 'session-1', type: 'APPLY', path: ['createSession'], argumentList: [
  { type: 'RAW', value: 'detector' }, { type: 'RAW', value: 'detector.ort' },
  { type: 'RAW', value: ['webgpu', 'wasm'] }, { type: 'RAW', value: { useOrtModelBytes: true } },
] };
const transfer = [new ArrayBuffer(8)];
worker.postMessage(message, transfer);
assert.equal(worker.sent[0][0], message);
assert.equal(worker.sent[0][1], transfer, 'Transfer arguments and ownership must stay on the native path');
worker.emit('message', { id: 'session-1', type: 'RAW', value: { sessionId: 'detector:1', provider: 'webgpu' } });
worker.postMessage({ id: 'run-1', type: 'APPLY', path: ['runInference'], argumentList: [{ value: 'detector:1' }] });
worker.emit('message', { id: 'run-1', type: 'HANDLER', name: 'throw', value: { message: 'expected failure' } });

assert.equal(runtime.connect({ name: port.name }), port);
runtime.onConnect.emit(port); // A connected Port must only be observed once.
const input = { type: 'start', jobId: 'job-1', binaryFile: new Blob(['fixture']) };
port.postMessage(input);
assert.equal(port.sent[0][0], input);
port.postMessage({ type: 'input-chunk', jobId: 'job-1', index: 0, data: 'NEVER_RECORD_RAW_INPUT' });
assert.equal(port.onMessage.listeners.length, 1);
port.onMessage.emit({ type: 'progress', jobId: 'job-1', progress: { stage: 'detect' } });

const callbackThis = { fixture: true };
let callbackValue;
let observedLastError;
runtime.sendMessage({ type: 'mt:download-image' }, function (value) {
  assert.equal(this, callbackThis);
  callbackValue = value;
  observedLastError = runtime.lastError;
});
runtime.lastError = { message: 'expected callback failure' };
callbacks.shift().call(callbackThis, input);
assert.equal(callbackValue, input);
assert.equal(observedLastError, runtime.lastError, 'The application callback must still see chrome.runtime.lastError');
delete runtime.lastError;
runtime.nextPromise = Promise.resolve(input);
assert.equal(runtime.sendMessage({ type: 'mt:extension-control', command: { kind: 'prepare-image-translation' } }), runtime.nextPromise);
assert.equal(await runtime.nextPromise, input);
runtime.nextPromise = Promise.reject(new Error('expected Promise failure'));
const rejected = runtime.sendMessage({ type: 'mt:download-image' });
assert.equal(rejected, runtime.nextPromise);
await assert.rejects(rejected, /expected Promise failure/);

port.onMessage.emit({ type: 'complete', jobId: 'job-1' });
port.onDisconnect.emit(port);
assert.equal(timers.length, 1, 'A terminal job posts one diagnostic batch');
timers.shift()();
await Promise.resolve();
assert.equal(posts.length, 1);
const batch = posts[0].body;
assert.equal(batch.kind, 'host-init-trace');
assert.equal(batch.realm, 'offscreen');
assert.equal(batch.timeOrigin, 1000);
assert(batch.records.every(x => x.absoluteStartMs === x.startedAt + 1000));
const calls = batch.records.filter(x => x.phase === 'worker.rpc');
assert.equal(calls.length, 2);
assert.equal(calls[0].model, 'detector');
assert.equal(calls[0].sessionId, 'detector:1');
assert.equal(calls[0].sessionOptions, '{"useOrtModelBytes":true}');
assert.equal(calls[1].model, 'detector');
assert.equal(calls[1].status, 'failed');
assert.equal(batch.records.filter(x => x.phase === 'runtime.sendMessage').length, 3);
assert(!JSON.stringify(batch).includes('NEVER_RECORD_RAW_INPUT'));

const disabled = { Worker: FakeWorker };
vm.runInNewContext(source, disabled);
assert.equal(disabled.Worker, FakeWorker);
assert.equal(disabled.__shinobuColdStartInitMark, undefined);
console.log('cold-start host initialization probe CPU checks passed');
