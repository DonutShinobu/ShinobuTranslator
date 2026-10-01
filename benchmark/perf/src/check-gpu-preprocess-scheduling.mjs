// CPU-only scheduling/resource check. Actual shader arithmetic is a separate GPU quality gate.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

const source = readFileSync(new URL('../../../packages/model-runtime/src/workers/gpuPreprocess.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} }).outputText;

function sandbox(noFence, direct, verify = false, observe = true, autoLayout = undefined) {
  const buffers = [], textures = [], shaders = [], copies = [];
  const explicitLayouts = [], pipelineLayouts = [], pipelines = [], dispatches = [], uniformWrites = [];
  const marks = [];
  let submits = 0, waits = 0, maps = 0, releaseWait;
  const gate = new Promise(resolve => { releaseWait = resolve; });
  const device = {
    queue: {
      copyExternalImageToTexture() {},
      writeBuffer(buffer, offset, data) { uniformWrites.push({ buffer, offset, bytes: [...new Uint8Array(data)] }); },
      submit() { submits++; },
      onSubmittedWorkDone() { waits++; return gate; },
    },
    createTexture(desc) {
      const texture = { desc, destroyed: false, destroyCount: 0,
        createView: () => ({ texture }), destroy() { this.destroyed = true; this.destroyCount++; } };
      textures.push(texture); return texture;
    },
    createBuffer(desc) {
      const buffer = { desc, destroyed: false, destroyCount: 0,
        destroy() { this.destroyed = true; this.destroyCount++; },
        async mapAsync() { maps++; }, getMappedRange: () => new ArrayBuffer(desc.size), unmap() {} };
      buffers.push(buffer); return buffer;
    },
    createShaderModule(desc) { shaders.push(desc.code); return desc; },
    createBindGroupLayout(desc) { explicitLayouts.push(desc); return desc; },
    createPipelineLayout(desc) { pipelineLayouts.push(desc); return desc; },
    createComputePipeline(desc) {
      const layout = desc.layout === 'auto' ? { autoPipelineIndex: pipelines.length } : desc.layout.bindGroupLayouts[0];
      const pipeline = { desc, layout, getBindGroupLayout(index) { assert.equal(index, 0); return layout; } };
      pipelines.push(pipeline); return pipeline;
    },
    createBindGroup: desc => desc,
    createCommandEncoder: () => ({
      beginComputePass() {
        let pipeline, bindGroup;
        return {
          setPipeline(value) { pipeline = value; },
          setBindGroup(index, value) { assert.equal(index, 0); bindGroup = value; },
          dispatchWorkgroups(groups) {
            assert.equal(bindGroup.layout, pipeline.layout, 'dispatch must use this pipeline\'s layout');
            dispatches.push({ pipeline, bindGroup, groups });
          }, end() {},
        };
      },
      copyBufferToBuffer(...args) {
        assert.ok(args[0].desc.usage & 2, 'copy source must have COPY_SRC');
        assert.ok(args[2].desc.usage & 4, 'copy target must have COPY_DST');
        copies.push(args);
      }, finish: () => ({}),
    }),
  };
  const exports = {};
  const ort = { env: { webgpu: { device } }, Tensor: { fromGpuBuffer: (buffer, options) => ({ buffer, ...options,
    getData() { throw new Error('quality verification must not change the feed to CPU'); } }) } };
  const scope = { exports, require: name => { assert.equal(name, 'onnxruntime-web/all'); return ort; },
    __shinobuColdStartGpuPreprocessNoFence: noFence, __shinobuColdStartGpuPreprocessDirect: direct,
    __shinobuColdStartGpuPreprocessAutoLayout: autoLayout,
    __shinobuColdStartGpuPreprocessVerify: verify,
    __shinobuColdStartInitMark: observe ? mark => marks.push(mark) : undefined,
    GPUTextureUsage: { COPY_DST: 1, TEXTURE_BINDING: 2, RENDER_ATTACHMENT: 4 },
    GPUBufferUsage: { STORAGE: 1, COPY_SRC: 2, COPY_DST: 4, UNIFORM: 8, MAP_READ: 16 },
    GPUShaderStage: { COMPUTE: 1 }, GPUMapMode: { READ: 1 },
    ArrayBuffer, DataView, Float32Array, Uint8Array, crypto: webcrypto,
    performance: observe || verify ? performance : { now() { throw new Error('no observer must not read clock'); } },
  };
  runInNewContext(js, scope);
  return { exports, buffers, textures, shaders, copies, releaseWait, marks, scope,
    explicitLayouts, pipelineLayouts, pipelines, dispatches, uniformWrites,
    counters: () => ({ submits, waits, maps }) };
}

for (const noFence of [false, true]) for (const direct of [false, true]) {
  const check = sandbox(noFence, direct);
  let completed = false;
  const pending = check.exports.preprocessLetterboxGpu({ width: 640, height: 480 }, 1024)
    .then(result => { completed = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, noFence, 'only baseline should wait before returning tensor');
  assert.deepEqual(check.counters(), { submits: 1, waits: noFence ? 0 : 1, maps: 0 });
  assert.equal(check.copies.length, direct ? 0 : 3);
  assert.equal(check.buffers.length, direct ? 2 : 5);
  check.releaseWait();
  const { tensor, params } = await pending;
  assert.equal(params.unpaddedWidth, 1024);
  assert.equal(params.unpaddedHeight, 768);
  assert.equal(check.textures[0].destroyed, !noFence);
  assert.equal(tensor.buffer.destroyed, false);
  if (noFence && direct) {
    const data = await tensor.download();
    assert.equal(data.length, 3 * 1024 * 1024);
    assert.deepEqual(check.counters(), { submits: 2, waits: 0, maps: 1 });
  }
  tensor.dispose();
  assert.ok(check.textures.every(texture => texture.destroyed));
  assert.ok(check.buffers.every(buffer => buffer.destroyed));
  assert.ok(check.textures.every(texture => texture.destroyCount === 1));
  assert.ok(check.buffers.every(buffer => buffer.destroyCount === 1));
}

const original = sandbox(false, false), direct = sandbox(true, true);
original.releaseWait();
const originalResult = await original.exports.preprocessLetterboxGpu({ width: 640, height: 480 }, 1024);
const directResult = await direct.exports.preprocessLetterboxGpu({ width: 640, height: 480 }, 1024);
const sampleBody = code => code.slice(code.indexOf('fn bilinearSample'), code.indexOf('@compute'));
assert.equal(sampleBody(original.shaders[0]), sampleBody(direct.shaders[0]));
assert.ok(!direct.shaders[0].includes('dst_ch'));
assert.ok(direct.shaders[0].includes('dst[2u * total + dst_idx] = color.b'));

// Auto layout must keep the original shader, allocation sizes, params and dispatch.
const auto = sandbox(true, false, false, true, true);
const autoResult = await auto.exports.preprocessLetterboxGpu({ width: 640, height: 480 }, 1024);
assert.equal(auto.shaders[0], original.shaders[0]);
assert.equal(auto.explicitLayouts.length, 0);
assert.equal(auto.pipelineLayouts.length, 0);
assert.equal(auto.pipelines[0].desc.layout, 'auto');
assert.equal(auto.dispatches[0].bindGroup.layout, auto.pipelines[0].getBindGroupLayout(0));
assert.equal(JSON.stringify(auto.dispatches[0].bindGroup.entries.map(entry => entry.binding)), '[0,1,2,3,4]');
assert.equal(auto.dispatches[0].bindGroup.entries[0].resource.texture, auto.textures[0]);
for (let binding = 1; binding <= 4; binding++) {
  assert.equal(auto.dispatches[0].bindGroup.entries[binding].resource.buffer, auto.buffers[binding - 1]);
}
assert.equal(auto.dispatches[0].groups, original.dispatches[0].groups);
assert.equal(auto.dispatches[0].groups, 4096);
assert.equal(auto.copies.length, 3);
assert.deepEqual(auto.uniformWrites[0].bytes, original.uniformWrites[0].bytes);
assert.equal(JSON.stringify(auto.buffers.map(buffer => buffer.desc)), JSON.stringify(original.buffers.map(buffer => buffer.desc)));
assert.equal(JSON.stringify(autoResult.params), JSON.stringify(originalResult.params));
assert.equal(JSON.stringify(autoResult.tensor.dims), '[1,3,1024,1024]');
assert.deepEqual(auto.counters(), { submits: 1, waits: 0, maps: 0 });
for (const [check, result] of [[original, originalResult], [direct, directResult], [auto, autoResult]]) {
  result.tensor.dispose();
  assert.ok(check.textures.every(texture => texture.destroyCount === 1));
  assert.ok(check.buffers.every(buffer => buffer.destroyCount === 1));
}

// Changing layout mode on the same device must invalidate the cached pipeline.
const switching = sandbox(true, false);
for (const [flag, expectedPipelines] of [[undefined, 1], [true, 2], [true, 2], [false, 3], ['true', 3]]) {
  switching.scope.__shinobuColdStartGpuPreprocessAutoLayout = flag;
  const result = await switching.exports.preprocessLetterboxGpu({ width: 640, height: 480 }, 1024);
  assert.equal(switching.pipelines.length, expectedPipelines);
  assert.equal(switching.dispatches.at(-1).pipeline.desc.layout === 'auto', flag === true);
  result.tensor.dispose();
}
assert.equal(switching.explicitLayouts.length, 2);
assert.equal(switching.pipelineLayouts.length, 2);
assert.ok(switching.textures.every(texture => texture.destroyCount === 1));
assert.ok(switching.buffers.every(buffer => buffer.destroyCount === 1));

const autoDirect = sandbox(true, true, false, false, true);
const autoDirectResult = await autoDirect.exports.preprocessLetterboxGpu({ width: 640, height: 480 }, 1024);
assert.equal(autoDirect.shaders[0], direct.shaders[0], 'layout flag must not select a different shader');
assert.equal(autoDirect.pipelines[0].desc.layout, 'auto');
assert.equal(autoDirect.explicitLayouts.length, 0);
assert.equal(autoDirect.pipelineLayouts.length, 0);
assert.equal(autoDirect.copies.length, 0);
autoDirectResult.tensor.dispose();
assert.ok(autoDirect.buffers.every(buffer => buffer.destroyCount === 1));

const hashes = new Set();
for (const [noFence, directStore] of [[false, false], [true, false], [true, true]]) {
  const check = sandbox(noFence, directStore, true);
  check.releaseWait();
  const { tensor } = await check.exports.preprocessLetterboxGpu({ width: 640, height: 480 }, 1024);
  const inputMarks = check.marks.filter(mark => mark.phase === 'detector-input-sha256');
  assert.equal(inputMarks.length, 1);
  const mark = inputMarks[0];
  assert.equal(mark.phase, 'detector-input-sha256');
  assert.equal(mark.bytes, 3 * 1024 * 1024 * 4);
  assert.equal(mark.sha256.length, 64);
  assert.equal(JSON.stringify(mark.dims), '[1,3,1024,1024]');
  for (const phase of ['module', 'layout', 'pipeline', 'texturecopy']) {
    assert.equal(check.marks.filter(mark => mark.phase === `detector-preprocess-${phase}`).length, 1);
  }
  assert.equal(check.marks.some(mark => mark.phase === 'detector-preprocess-fence'), !noFence);
  hashes.add(mark.sha256);
  tensor.dispose();
  assert.ok(check.buffers.every(buffer => buffer.destroyed));
}
assert.equal(hashes.size, 1);
for (const autoLayout of [undefined, true]) {
  const unobserved = sandbox(true, false, false, false, autoLayout);
  const unobservedResult = await unobserved.exports.preprocessLetterboxGpu({ width: 640, height: 480 }, 1024);
  assert.equal(unobserved.marks.length, 0);
  unobservedResult.tensor.dispose();
}
console.log('GPU preprocess scheduling/resource check passed');
