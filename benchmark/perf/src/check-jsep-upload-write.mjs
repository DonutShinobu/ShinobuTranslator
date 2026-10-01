// Tiny CPU byte/lifecycle check of the actual patched ORT upload method. No build/GPU.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { patchJsepUploadWriteBuffer, UPLOAD_WRITE_BUFFER_FLAG } from './cold-jsep-upload-write-patch.mjs';

const source = readFileSync(new URL('../../../node_modules/onnxruntime-web/lib/wasm/jsep/webgpu/gpu-data-manager.ts', import.meta.url), 'utf8');
const patch = patchJsepUploadWriteBuffer(source);
assert.equal(patch.metadata.defaultEnabled, false);
assert.throws(() => patchJsepUploadWriteBuffer(source + '\n'), /Unexpected ORT/);
const ast = ts.createSourceFile('gpu-data-manager.ts', patch.contents, ts.ScriptTarget.ES2022, true);
const owner = ast.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'GpuDataManagerImpl');
const method = owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(ast) === 'upload');
const js = ts.transpileModule(`class UploadMethod {\n${method.getText(ast)}\n}\nexports.upload = UploadMethod.prototype.upload;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const usage = { MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, STORAGE: 128 };

function fixture(flag, length, hasCopyDst = true, failWrite = false) {
  const calls = { created: 0, submits: 0, writes: 0, destroys: 0, logs: [] };
  const destination = { size: Math.max(64, Math.ceil(length / 16) * 16),
    usage: usage.STORAGE | (hasCopyDst ? usage.COPY_DST : 0) };
  destination.bytes = new Uint8Array(destination.size).fill(0xff);
  const backing = new ArrayBuffer(length + 11);
  const data = new Uint8Array(backing, 5, length);
  for (let i = 0; i < data.length; i++) data[i] = (i * 29 + 128) & 255;
  const expected = new Uint8Array(destination.bytes);
  expected.set(data);
  expected.fill(0, length, Math.ceil(length / 16) * 16);
  const nativeError = new Error('native-write-failure');
  const device = {
    queue: {
      writeBuffer(target, offset, input) {
        assert.equal(target, destination); assert.equal(offset, 0); assert.equal(input, data);
        if (failWrite) throw nativeError;
        calls.writes++;
        target.bytes.set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
      },
      submit(commands) { calls.submits++; for (const copy of commands[0]) {
        if (!(copy.target.usage & usage.COPY_DST)) throw new Error('native-copy-destination-usage');
        copy.target.bytes.set(copy.source.bytes.subarray(0, copy.size));
      } },
    },
    createBuffer(desc) {
      calls.created++;
      assert.equal(desc.mappedAtCreation, true);
      assert.equal(desc.usage, usage.MAP_WRITE | usage.COPY_SRC);
      const bytes = new Uint8Array(desc.size);
      return { bytes, getMappedRange: () => bytes.buffer, unmap() {}, destroy() { calls.destroys++; } };
    },
    createCommandEncoder() {
      const copies = [];
      return { copyBufferToBuffer(source, sourceOffset, target, targetOffset, size) {
        assert.equal(sourceOffset, 0); assert.equal(targetOffset, 0);
        copies.push({ source, target, size });
      }, finish: () => copies };
    },
  };
  const exports = {};
  runInNewContext(js, { exports, [UPLOAD_WRITE_BUFFER_FLAG]: flag, GPUBufferUsage: usage,
    calcNormalizedBufferSize: value => Math.ceil(value / 16) * 16,
    LOG_DEBUG: (level, message) => { assert.equal(level, 'verbose'); calls.logs.push(message()); },
    Uint8Array,
  });
  const cache = { originalSize: length, gpuData: { buffer: destination } };
  const receiver = { storageCache: new Map([[7, cache]]), backend: { device } };
  return { calls, data, expected, destination, cache, receiver, nativeError,
    upload: (id = 7) => exports.upload.call(receiver, id, data) };
}

for (const flag of [undefined, false, 'true', true]) for (const length of [0, 1, 4, 15, 16, 20, 32]) {
  const check = fixture(flag, length);
  check.upload();
  const direct = flag === true && length > 0 && length % 16 === 0;
  assert.equal(check.calls.writes, direct ? 1 : 0);
  assert.equal(check.calls.created, direct ? 0 : 1);
  assert.equal(check.calls.submits, direct ? 0 : 1);
  assert.equal(check.calls.destroys, direct ? 0 : 1);
  assert.deepEqual(check.destination.bytes, check.expected, 'payload, zero padding and untouched tail match original');
  check.data.fill(0);
  assert.deepEqual(check.destination.bytes, check.expected, 'view mutation after the synchronous API must not affect destination');
  assert.deepEqual(check.calls.logs, ['[WebGPU] GpuDataManager.upload(id=7)']);
}
const missing = fixture(true, 16);
assert.throws(() => missing.upload(9), /gpu data for uploading does not exist/);
assert.equal(missing.calls.writes + missing.calls.created, 0);
const mismatch = fixture(true, 16);
mismatch.cache.originalSize = 32;
assert.throws(() => mismatch.upload(), /inconsistent data size/);
assert.equal(mismatch.calls.writes + mismatch.calls.created, 0);
const unsupported = fixture(true, 16, false);
assert.throws(() => unsupported.upload(), /native-copy-destination-usage/);
assert.equal(unsupported.calls.writes, 0);
assert.equal(unsupported.calls.created, 1, 'unsupported usage takes the original path');
const failed = fixture(true, 16, true, true);
assert.throws(() => failed.upload(), error => error === failed.nativeError);
assert.equal(failed.calls.created, 0, 'a native write failure must propagate without a second upload');
assert.equal(failed.calls.logs.length, 0);
console.log('PASS exact ORT upload source, strict flag, aligned byte oracle, zero padding, original errors/LOG_DEBUG');
