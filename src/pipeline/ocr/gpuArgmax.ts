import type * as ort from "onnxruntime-web/all";

export type OcrGpuStepResult = {
  token: number;
  score: number;
  probability: number;
};

type GpuBestReducerBuffers = {
  partialBest: GPUBuffer;
  best: GPUBuffer;
  partialSums: GPUBuffer;
  result: GPUBuffer;
  readback: GPUBuffer;
  params: GPUBuffer;
};

const WORKGROUP_SIZE = 256;

export class OcrGpuStepReducer {
  private readonly passBestChunk: GPUComputePipeline;
  private readonly passBestFinal: GPUComputePipeline;
  private readonly passSumChunk: GPUComputePipeline;
  private readonly passResultFinal: GPUComputePipeline;

  constructor(private readonly device: GPUDevice) {
    const passBestChunkModule = device.createShaderModule({
      code: `
struct Best {
  score: f32,
  token: u32,
};
struct Params {
  classes: u32,
  steps: u32,
  decode_step: u32,
  chunks_per_sample: u32,
};
@group(0) @binding(0) var<storage, read> logits: array<f32>;
@group(0) @binding(1) var<storage, read_write> partial_best: array<Best>;
@group(0) @binding(2) var<uniform> params: Params;
var<workgroup> scores: array<f32, 256>;
var<workgroup> tokens: array<u32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) local_id: vec3<u32>, @builtin(workgroup_id) workgroup_id: vec3<u32>) {
  let local = local_id.x;
  let chunk = workgroup_id.x;
  let sample = workgroup_id.y;
  let class_id = chunk * 256u + local;
  let base = (sample * params.steps + params.decode_step) * params.classes;
  var score = -3.4028234663852886e38;
  var token = 0u;
  if (class_id < params.classes) {
    score = logits[base + class_id];
    token = class_id;
  }
  scores[local] = score;
  tokens[local] = token;
  workgroupBarrier();
  var stride = 128u;
  loop {
    if (stride == 0u) {
      break;
    }
    if (local < stride) {
      let other = local + stride;
      let other_score = scores[other];
      let other_token = tokens[other];
      if (other_score > scores[local] || (other_score == scores[local] && other_token < tokens[local])) {
        scores[local] = other_score;
        tokens[local] = other_token;
      }
    }
    workgroupBarrier();
    stride = stride / 2u;
  }
  if (local == 0u) {
    partial_best[sample * params.chunks_per_sample + chunk] = Best(scores[0], tokens[0]);
  }
}
`,
    });
    const passBestFinalModule = device.createShaderModule({
      code: `
struct Best {
  score: f32,
  token: u32,
};
struct Params {
  classes: u32,
  steps: u32,
  decode_step: u32,
  chunks_per_sample: u32,
};
@group(0) @binding(0) var<storage, read> partial_best: array<Best>;
@group(0) @binding(1) var<storage, read_write> best: array<Best>;
@group(0) @binding(2) var<uniform> params: Params;
var<workgroup> scores: array<f32, 256>;
var<workgroup> tokens: array<u32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) local_id: vec3<u32>, @builtin(workgroup_id) workgroup_id: vec3<u32>) {
  let local = local_id.x;
  let sample = workgroup_id.x;
  var score = -3.4028234663852886e38;
  var token = 0u;
  if (local < params.chunks_per_sample) {
    let item = partial_best[sample * params.chunks_per_sample + local];
    score = item.score;
    token = item.token;
  }
  scores[local] = score;
  tokens[local] = token;
  workgroupBarrier();
  var stride = 128u;
  loop {
    if (stride == 0u) {
      break;
    }
    if (local < stride) {
      let other = local + stride;
      let other_score = scores[other];
      let other_token = tokens[other];
      if (other_score > scores[local] || (other_score == scores[local] && other_token < tokens[local])) {
        scores[local] = other_score;
        tokens[local] = other_token;
      }
    }
    workgroupBarrier();
    stride = stride / 2u;
  }
  if (local == 0u) {
    best[sample] = Best(scores[0], tokens[0]);
  }
}
`,
    });
    const passSumChunkModule = device.createShaderModule({
      code: `
struct Best {
  score: f32,
  token: u32,
};
struct Params {
  classes: u32,
  steps: u32,
  decode_step: u32,
  chunks_per_sample: u32,
};
@group(0) @binding(0) var<storage, read> logits: array<f32>;
@group(0) @binding(1) var<storage, read> best: array<Best>;
@group(0) @binding(2) var<storage, read_write> partial_sums: array<f32>;
@group(0) @binding(3) var<uniform> params: Params;
var<workgroup> sums: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) local_id: vec3<u32>, @builtin(workgroup_id) workgroup_id: vec3<u32>) {
  let local = local_id.x;
  let chunk = workgroup_id.x;
  let sample = workgroup_id.y;
  let class_id = chunk * 256u + local;
  let base = (sample * params.steps + params.decode_step) * params.classes;
  var sum = 0.0;
  if (class_id < params.classes) {
    sum = exp(logits[base + class_id] - best[sample].score);
  }
  sums[local] = sum;
  workgroupBarrier();
  var stride = 128u;
  loop {
    if (stride == 0u) {
      break;
    }
    if (local < stride) {
      sums[local] = sums[local] + sums[local + stride];
    }
    workgroupBarrier();
    stride = stride / 2u;
  }
  if (local == 0u) {
    partial_sums[sample * params.chunks_per_sample + chunk] = sums[0];
  }
}
`,
    });
    const passResultFinalModule = device.createShaderModule({
      code: `
struct Best {
  score: f32,
  token: u32,
};
struct Params {
  classes: u32,
  steps: u32,
  decode_step: u32,
  chunks_per_sample: u32,
};
@group(0) @binding(0) var<storage, read> best: array<Best>;
@group(0) @binding(1) var<storage, read> partial_sums: array<f32>;
@group(0) @binding(2) var<storage, read_write> results: array<vec4<f32>>;
@group(0) @binding(3) var<uniform> params: Params;
var<workgroup> sums: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) local_id: vec3<u32>, @builtin(workgroup_id) workgroup_id: vec3<u32>) {
  let local = local_id.x;
  let sample = workgroup_id.x;
  var sum = 0.0;
  if (local < params.chunks_per_sample) {
    sum = partial_sums[sample * params.chunks_per_sample + local];
  }
  sums[local] = sum;
  workgroupBarrier();
  var stride = 128u;
  loop {
    if (stride == 0u) {
      break;
    }
    if (local < stride) {
      sums[local] = sums[local] + sums[local + stride];
    }
    workgroupBarrier();
    stride = stride / 2u;
  }
  if (local == 0u) {
    let item = best[sample];
    let probability = select(0.0, 1.0 / sums[0], sums[0] > 0.0);
    results[sample] = vec4<f32>(f32(item.token), item.score, probability, 0.0);
  }
}
`,
    });

    this.passBestChunk = device.createComputePipeline({ layout: "auto", compute: { module: passBestChunkModule, entryPoint: "main" } });
    this.passBestFinal = device.createComputePipeline({ layout: "auto", compute: { module: passBestFinalModule, entryPoint: "main" } });
    this.passSumChunk = device.createComputePipeline({ layout: "auto", compute: { module: passSumChunkModule, entryPoint: "main" } });
    this.passResultFinal = device.createComputePipeline({ layout: "auto", compute: { module: passResultFinalModule, entryPoint: "main" } });
  }

  async reduce(
    logitsTensor: ort.Tensor,
    batchSize: number,
    steps: number,
    classes: number,
    decodeStep: number
  ): Promise<OcrGpuStepResult[] | null> {
    if (logitsTensor.location !== "gpu-buffer") {
      return null;
    }
    const chunksPerSample = Math.ceil(classes / WORKGROUP_SIZE);
    if (chunksPerSample > WORKGROUP_SIZE) {
      return null;
    }

    const buffers = this.createBuffers(batchSize, chunksPerSample);
    let mapped = false;
    try {
      this.device.queue.writeBuffer(buffers.params, 0, new Uint32Array([classes, steps, decodeStep, chunksPerSample]));
      const encoder = this.device.createCommandEncoder();

      const passBestChunk = encoder.beginComputePass();
      passBestChunk.setPipeline(this.passBestChunk);
      passBestChunk.setBindGroup(0, this.device.createBindGroup({
        layout: this.passBestChunk.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: logitsTensor.gpuBuffer } },
          { binding: 1, resource: { buffer: buffers.partialBest } },
          { binding: 2, resource: { buffer: buffers.params } },
        ],
      }));
      passBestChunk.dispatchWorkgroups(chunksPerSample, batchSize);
      passBestChunk.end();

      const passBestFinal = encoder.beginComputePass();
      passBestFinal.setPipeline(this.passBestFinal);
      passBestFinal.setBindGroup(0, this.device.createBindGroup({
        layout: this.passBestFinal.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: buffers.partialBest } },
          { binding: 1, resource: { buffer: buffers.best } },
          { binding: 2, resource: { buffer: buffers.params } },
        ],
      }));
      passBestFinal.dispatchWorkgroups(batchSize);
      passBestFinal.end();

      const passSumChunk = encoder.beginComputePass();
      passSumChunk.setPipeline(this.passSumChunk);
      passSumChunk.setBindGroup(0, this.device.createBindGroup({
        layout: this.passSumChunk.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: logitsTensor.gpuBuffer } },
          { binding: 1, resource: { buffer: buffers.best } },
          { binding: 2, resource: { buffer: buffers.partialSums } },
          { binding: 3, resource: { buffer: buffers.params } },
        ],
      }));
      passSumChunk.dispatchWorkgroups(chunksPerSample, batchSize);
      passSumChunk.end();

      const passResultFinal = encoder.beginComputePass();
      passResultFinal.setPipeline(this.passResultFinal);
      passResultFinal.setBindGroup(0, this.device.createBindGroup({
        layout: this.passResultFinal.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: buffers.best } },
          { binding: 1, resource: { buffer: buffers.partialSums } },
          { binding: 2, resource: { buffer: buffers.result } },
          { binding: 3, resource: { buffer: buffers.params } },
        ],
      }));
      passResultFinal.dispatchWorkgroups(batchSize);
      passResultFinal.end();

      encoder.copyBufferToBuffer(buffers.result, 0, buffers.readback, 0, batchSize * 16);
      this.device.queue.submit([encoder.finish()]);
      await buffers.readback.mapAsync(GPUMapMode.READ);
      mapped = true;
      const view = new Float32Array(buffers.readback.getMappedRange());
      const results: OcrGpuStepResult[] = [];
      for (let n = 0; n < batchSize; n += 1) {
        const offset = n * 4;
        results.push({
          token: Math.round(view[offset]),
          score: view[offset + 1],
          probability: view[offset + 2],
        });
      }
      return results;
    } finally {
      if (mapped) {
        buffers.readback.unmap();
      }
      this.destroyBuffers(buffers);
    }
  }

  private createBuffers(batchSize: number, chunksPerSample: number): GpuBestReducerBuffers {
    return {
      partialBest: this.device.createBuffer({
        size: batchSize * chunksPerSample * 8,
        usage: GPUBufferUsage.STORAGE,
      }),
      best: this.device.createBuffer({
        size: batchSize * 8,
        usage: GPUBufferUsage.STORAGE,
      }),
      partialSums: this.device.createBuffer({
        size: batchSize * chunksPerSample * 4,
        usage: GPUBufferUsage.STORAGE,
      }),
      result: this.device.createBuffer({
        size: batchSize * 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      }),
      readback: this.device.createBuffer({
        size: batchSize * 16,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      }),
      params: this.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
    };
  }

  private destroyBuffers(buffers: GpuBestReducerBuffers): void {
    buffers.partialBest.destroy();
    buffers.best.destroy();
    buffers.partialSums.destroy();
    buffers.result.destroy();
    buffers.readback.destroy();
    buffers.params.destroy();
  }
}
