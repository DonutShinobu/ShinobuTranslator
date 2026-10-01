// Read-only inspection using the schema shipped with the installed ORT Web version.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ByteBuffer } = require('flatbuffers');
const { InferenceSession } = require(fileURLToPath(new URL(
  '../../../node_modules/onnxruntime-web/lib/onnxjs/ort-schema/flatbuffers/onnxruntime/fbs/inference-session.js',
  import.meta.url,
)));
const path = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL(
  '../../../apps/extension/dist-chromium/models/detector.ort', import.meta.url,
));
const bytes = readFileSync(path);
const bb = new ByteBuffer(bytes);
assert.ok(InferenceSession.bufferHasIdentifier(bb), 'not an ORT FlatBuffer');
const session = InferenceSession.getRootAsInferenceSession(bb);
const graph = session.model().graph();
const runtime = graph.runtimeOptimizations();
const records = [];
for (let i = 0; i < (runtime?.recordsLength() ?? 0); i++) {
  const entry = runtime.records(i), actions = {};
  for (let j = 0; j < entry.runtimeOptimizationRecordsLength(); j++) {
    const action = entry.runtimeOptimizationRecords(j).actionId();
    actions[action] = (actions[action] ?? 0) + 1;
  }
  records.push({ optimizer: entry.optimizerName(), count: entry.runtimeOptimizationRecordsLength(), actions });
}
const nodeTypes = {};
for (let i = 0; i < graph.nodesLength(); i++) {
  const op = graph.nodes(i).opType();
  nodeTypes[op] = (nodeTypes[op] ?? 0) + 1;
}
console.log(JSON.stringify({ path, bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  ortFormatVersion: session.ortVersion(), nodes: graph.nodesLength(),
  initializers: graph.initializersLength(), records, nodeTypes }, null, 2));
