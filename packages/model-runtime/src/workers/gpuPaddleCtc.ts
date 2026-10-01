import type { TensorTransport } from '../runtime/onnxWorkerTypes';

// Compare the original float32 values; retain the first class on ties.
export const PADDLE_CTC_SHADER = `
struct Params { rows: u32, classes: u32, pad0: u32, pad1: u32 };
@group(0) @binding(0) var<storage, read> logits: array<f32>;
@group(0) @binding(1) var<storage, read_write> maxima: array<vec2<f32>>;
@group(0) @binding(2) var<uniform> params: Params;
var<workgroup> values: array<f32, 128>;
var<workgroup> indices: array<u32, 128>;
@compute @workgroup_size(128)
fn main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
  let row = group.x;
  var best = 0.0;
  var index = 0xffffffffu;
  for (var c = lane; c < params.classes; c += 128u) {
    let p = logits[row * params.classes + c];
    // Explicit bit check also keeps NaN behavior stable under GPU optimizations.
    if ((bitcast<u32>(p) & 0x7fffffffu) <= 0x7f800000u &&
        (index == 0xffffffffu || p > best || (p == best && c < index))) {
      best = p;
      index = c;
    }
  }
  values[lane] = best;
  indices[lane] = index;
  workgroupBarrier();
  for (var stride = 64u; stride > 0u; stride /= 2u) {
    if (lane < stride) {
      let p = values[lane + stride];
      let c = indices[lane + stride];
      if (c != 0xffffffffu && (indices[lane] == 0xffffffffu ||
          p > values[lane] || (p == values[lane] && c < indices[lane]))) {
        values[lane] = p;
        indices[lane] = c;
      }
    }
    workgroupBarrier();
  }
  if (lane == 0u) {
    let first = logits[row * params.classes];
    if ((bitcast<u32>(first) & 0x7fffffffu) > 0x7f800000u) {
      maxima[row] = vec2<f32>(0.0, first);
    } else {
      maxima[row] = vec2<f32>(f32(indices[0]), values[0]);
    }
  }
}`;

const pipelines = new WeakMap<GPUDevice, GPUComputePipeline>();

export async function reducePaddleCtc(
  device: GPUDevice,
  source: GPUBuffer,
  dims: readonly number[],
): Promise<TensorTransport> {
  if (dims.length !== 3 || dims.some(v => !Number.isSafeInteger(v) || v <= 0)) {
    throw new Error('Paddle CTC requires [batch, time, classes]');
  }
  const [batch, time, classes] = dims;
  const rows = batch * time;
  if (rows > device.limits.maxComputeWorkgroupsPerDimension || classes >= 16777216) {
    throw new Error('Paddle CTC shape exceeds reduction limits');
  }
  let pipeline = pipelines.get(device);
  if (!pipeline) {
    pipeline = device.createComputePipeline({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code: PADDLE_CTC_SHADER }), entryPoint: 'main' },
    });
    pipelines.set(device, pipeline);
  }
  const size = rows * 8;
  const output = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  try {
    device.queue.writeBuffer(params, 0, new Uint32Array([rows, classes, 0, 0]));
    const bindings = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: source } },
        { binding: 1, resource: { buffer: output } },
        { binding: 2, resource: { buffer: params } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindings);
    pass.dispatchWorkgroups(rows);
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, size);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    return { data, dims: [batch, time, 2], type: 'float32', ctcClassCount: classes };
  } finally {
    output.destroy();
    readback.destroy();
    params.destroy();
  }
}
