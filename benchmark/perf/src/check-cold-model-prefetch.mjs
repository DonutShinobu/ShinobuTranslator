import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const bytes = new Uint8Array([79, 82, 84, 77]);
const listeners = [];
const requests = [];
const realm = { performance, addEventListener: (_, fn) => listeners.push(fn),
  fetch: async (...args) => { requests.push(args); return new Response(bytes); } };
runInNewContext(readFileSync(new URL('./cold-model-prefetch-probe.js', import.meta.url), 'utf8'), { self: realm, performance });
listeners[0]({ data: { type: 'APPLY', path: ['createSession'], argumentList: [{ value: 'detector' }, { value: 'https://model/detector.ort' }] } });
assert.equal(requests.length, 1); // Started before ORT requests the model.
await realm.fetch('https://model/other.onnx');
const response = await realm.fetch('https://model/detector.ort');
assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
assert.equal(requests.length, 2); // The detector consumed the same bytes without another fetch.
await realm.fetch('https://model/detector.ort');
assert.equal(requests.length, 3); // One-use cache does not alter retry/fallback loads.
console.log('model prefetch reuse check passed');
