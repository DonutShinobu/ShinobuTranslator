/**
 * GPU-accelerated preprocessing for ONNX inference in the Web Worker.
 *
 * Uses WebGPU compute shaders to perform letterbox preprocessing entirely
 * on the GPU, avoiding CPU-side Float32Array creation and CPU→GPU uploads.
 *
 * Data flow:
 *   ImageBitmap/OffscreenCanvas
 *     → copyExternalImageToTexture → GPUTexture (rgba8unorm)
 *     → compute shader (resize via texture sampling + pad + normalize + HWC→NCHW)
 *       → 3x GPUBuffer (per-channel float32)
 *     → copyBufferToBuffer → single NCHW GPUBuffer
 *     → ort.Tensor.fromGpuBuffer() → session.run feeds
 */

import * as ortAll from "onnxruntime-web/all";

// ---------------------------------------------------------------------------
// WGSL shader: letterbox preprocessing
//
// Input:  texture_2d<f32> (source image, rgba8unorm copied via copyExternalImageToTexture)
// Output: 3x storage<read_write> arrays (NCHW channel planes, float32, normalized to [0,1])
//
// The shader maps each output pixel (dst_x, dst_y) back to source coordinates
// using the letterbox ratio. GPU texture sampling provides bilinear filtering
// for the resize step. Padding areas are filled with 0.0 (black).
// ---------------------------------------------------------------------------

const LETTERBOX_SHADER = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;

@group(0) @binding(1) var<storage, read_write> dst_ch0: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst_ch1: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst_ch2: array<f32>;

struct Params {
  dst_size: u32,
  unpadded_width: u32,
  unpadded_height: u32,
  src_width: u32,
  src_height: u32,
  ratio: f32,
};

@group(0) @binding(4) var<uniform> params: Params;

// Bilinear sampling — matches canvas.drawImage with imageSmoothingEnabled=true
fn bilinearSample(u: f32, v: f32) -> vec4<f32> {
  let w = f32(params.src_width);
  let h = f32(params.src_height);
  let x = u * w - 0.5;
  let y = v * h - 0.5;
  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let x1 = x0 + 1;
  let y1 = y0 + 1;
  let fx = x - f32(x0);
  let fy = y - f32(y0);

  let c00 = textureLoad(src, vec2<i32>(clamp(x0, 0, i32(params.src_width) - 1), clamp(y0, 0, i32(params.src_height) - 1)), 0);
  let c10 = textureLoad(src, vec2<i32>(clamp(x1, 0, i32(params.src_width) - 1), clamp(y0, 0, i32(params.src_height) - 1)), 0);
  let c01 = textureLoad(src, vec2<i32>(clamp(x0, 0, i32(params.src_width) - 1), clamp(y1, 0, i32(params.src_height) - 1)), 0);
  let c11 = textureLoad(src, vec2<i32>(clamp(x1, 0, i32(params.src_width) - 1), clamp(y1, 0, i32(params.src_height) - 1)), 0);

  let top = mix(c00, c10, fx);
  let bot = mix(c01, c11, fx);
  return mix(top, bot, fy);
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dst_idx = gid.x;
  let total = params.dst_size * params.dst_size;
  if (dst_idx >= total) { return; }

  let dst_x = dst_idx % params.dst_size;
  let dst_y = dst_idx / params.dst_size;

  // CPU letterbox: image drawn at (0,0), top-left aligned, bilinear interpolation
  if (dst_x < params.unpadded_width && dst_y < params.unpadded_height) {
    let u = (f32(dst_x) + 0.5) / f32(params.unpadded_width);
    let v = (f32(dst_y) + 0.5) / f32(params.unpadded_height);
    let color = bilinearSample(u, v);
    dst_ch0[dst_idx] = color.r;
    dst_ch1[dst_idx] = color.g;
    dst_ch2[dst_idx] = color.b;
  } else {
    dst_ch0[dst_idx] = 0.0;
    dst_ch1[dst_idx] = 0.0;
    dst_ch2[dst_idx] = 0.0;
  }
}
`;

// Experimental direct stores retain the original sampling expressions. Only
// destination bindings and channel offsets change; all values remain float32.
const LETTERBOX_DIRECT_SHADER = LETTERBOX_SHADER
  .replace(/@group\(0\) @binding\(1\) var<storage, read_write> dst_ch0: array<f32>;\s*@group\(0\) @binding\(2\) var<storage, read_write> dst_ch1: array<f32>;\s*@group\(0\) @binding\(3\) var<storage, read_write> dst_ch2: array<f32>;/,
    "@group(0) @binding(1) var<storage, read_write> dst: array<f32>;")
  .replace("@binding(4) var<uniform>", "@binding(2) var<uniform>")
  .replaceAll("dst_ch0[dst_idx]", "dst[dst_idx]")
  .replaceAll("dst_ch1[dst_idx]", "dst[total + dst_idx]")
  .replaceAll("dst_ch2[dst_idx]", "dst[2u * total + dst_idx]");

// ---------------------------------------------------------------------------
// Letterbox parameters (shared with CPU implementation)
// ---------------------------------------------------------------------------

export type LetterboxParams = {
  ratio: number;
  unpaddedWidth: number;
  unpaddedHeight: number;
  padX: number;
  padY: number;
};

export function computeLetterboxParams(
  srcWidth: number,
  srcHeight: number,
  dstSize: number
): LetterboxParams {
  const ratio = Math.min(dstSize / srcHeight, dstSize / srcWidth);
  const unpaddedWidth = Math.max(1, Math.round(srcWidth * ratio));
  const unpaddedHeight = Math.max(1, Math.round(srcHeight * ratio));
  // CPU letterbox draws at (0,0) — top-left aligned, no centering
  return { ratio, unpaddedWidth, unpaddedHeight, padX: 0, padY: 0 };
}

// ---------------------------------------------------------------------------
// Pipeline cache (one per GPUDevice)
// ---------------------------------------------------------------------------

let cachedDevice: GPUDevice | null = null;
let cachedPipeline: GPUComputePipeline | null = null;
let cachedBindGroupLayout: GPUBindGroupLayout | null = null;
let cachedDirect = false;
let cachedAutoLayout = false;

type PreprocessMark = {
  phase: string; startedAt: number; durationMs: number; model: string;
  bytes?: number; dims?: readonly number[]; sha256?: string;
};
type PreprocessObserver = (mark: PreprocessMark) => void;

function markStart(observer?: PreprocessObserver): number {
  return observer ? performance.now() : 0;
}
function markEnd(observer: PreprocessObserver | undefined, phase: string, startedAt: number): void {
  observer?.({ phase, startedAt, durationMs: performance.now() - startedAt, model: "detector" });
}

function getOrtDevice(): GPUDevice {
  const device = (ortAll.env.webgpu as unknown as { device?: GPUDevice }).device;
  if (!device) {
    throw new Error("[gpuPreprocess] ort.env.webgpu.device 不可用。请确保 WebGPU session 已创建。");
  }
  return device;
}

function ensurePipeline(device: GPUDevice, direct: boolean, autoLayout: boolean, observer?: PreprocessObserver): {
  pipeline: GPUComputePipeline;
  bindGroupLayout: GPUBindGroupLayout;
} {
  if (cachedDevice === device && cachedDirect === direct && cachedAutoLayout === autoLayout
    && cachedPipeline && cachedBindGroupLayout) {
    return { pipeline: cachedPipeline, bindGroupLayout: cachedBindGroupLayout };
  }

  const moduleStart = markStart(observer);
  const shaderModule = device.createShaderModule({ code: direct ? LETTERBOX_DIRECT_SHADER : LETTERBOX_SHADER });
  markEnd(observer, "detector-preprocess-module", moduleStart);

  let bindGroupLayout: GPUBindGroupLayout | undefined;
  let pipelineLayout: GPUPipelineLayout | "auto" = "auto";
  if (!autoLayout) {
    const layoutStart = markStart(observer);
    bindGroupLayout = device.createBindGroupLayout({
      entries: direct ? [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ] : [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      ],
    });

    pipelineLayout = device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });
    markEnd(observer, "detector-preprocess-layout", layoutStart);
  }

  const pipelineStart = markStart(observer);
  const pipeline = device.createComputePipeline({
    layout: pipelineLayout,
    compute: { module: shaderModule, entryPoint: "main" },
  });
  markEnd(observer, "detector-preprocess-pipeline", pipelineStart);
  if (!bindGroupLayout) {
    // An auto layout belongs to this exact pipeline, including a reused
    // asynchronously compiled template returned by the benchmark probe.
    const layoutStart = markStart(observer);
    bindGroupLayout = pipeline.getBindGroupLayout(0);
    markEnd(observer, "detector-preprocess-layout", layoutStart);
  }

  cachedDevice = device;
  cachedDirect = direct;
  cachedAutoLayout = autoLayout;
  cachedPipeline = pipeline;
  cachedBindGroupLayout = bindGroupLayout;
  return { pipeline, bindGroupLayout };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type LetterboxGpuResult = {
  tensor: ortAll.Tensor;
  params: LetterboxParams;
};

/**
 * Perform letterbox preprocessing on the GPU.
 *
 * Steps:
 * 1. copyExternalImageToTexture → GPUTexture (rgba8unorm)
 * 2. compute shader (resize via texture sampling + pad + normalize + HWC→NCHW)
 *    → 3x GPUBuffer (per-channel float32)
 * 3. copyBufferToBuffer → single NCHW GPUBuffer [1, 3, dstSize, dstSize]
 * 4. Wrap as ort.Tensor via fromGpuBuffer
 */
export async function preprocessLetterboxGpu(
  imageSource: ImageBitmap | OffscreenCanvas,
  dstSize: number
): Promise<LetterboxGpuResult> {
  const device = getOrtDevice();
  const experimental = globalThis as typeof globalThis & {
    __shinobuColdStartGpuPreprocessNoFence?: boolean;
    __shinobuColdStartGpuPreprocessDirect?: boolean;
    __shinobuColdStartGpuPreprocessAutoLayout?: boolean;
    __shinobuColdStartGpuPreprocessVerify?: boolean;
    __shinobuColdStartInitMark?: PreprocessObserver;
  };
  const noFence = experimental.__shinobuColdStartGpuPreprocessNoFence === true;
  const direct = experimental.__shinobuColdStartGpuPreprocessDirect === true;
  const autoLayout = experimental.__shinobuColdStartGpuPreprocessAutoLayout === true;
  const verify = experimental.__shinobuColdStartGpuPreprocessVerify === true;
  const observer = experimental.__shinobuColdStartInitMark;

  const srcWidth = imageSource.width;
  const srcHeight = imageSource.height;
  const lbParams = computeLetterboxParams(srcWidth, srcHeight, dstSize);

  // Step 1: Copy image to GPUTexture via copyExternalImageToTexture
  const textureStart = markStart(observer);
  const srcTexture = device.createTexture({
    size: [srcWidth, srcHeight],
    format: "rgba8unorm",
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
  });

  device.queue.copyExternalImageToTexture(
    { source: imageSource as ImageBitmap | OffscreenCanvas },
    { texture: srcTexture },
    [srcWidth, srcHeight]
  );
  markEnd(observer, "detector-preprocess-texturecopy", textureStart);

  // Step 2: Create output buffers for 3 channels
  const pixelCount = dstSize * dstSize;
  const bufferSize = pixelCount * 4; // float32 per pixel per channel
  const nchwBufferSize = 3 * bufferSize;
  const nchwBuffer = direct ? device.createBuffer({
    size: nchwBufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  }) : null;

  const ch0Buffer = direct ? null : device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const ch1Buffer = direct ? null : device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const ch2Buffer = direct ? null : device.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  // Step 3: Create uniform buffer for shader params
  // Params struct: dst_size(u32), unpadded_width(u32), unpadded_height(u32),
  //               src_width(u32), src_height(u32), ratio(f32) = 24 bytes
  // Padded to 32 for WGSL uniform struct alignment (must be 16-byte aligned)
  const uniformData = new ArrayBuffer(32);
  const uniformView = new DataView(uniformData);
  uniformView.setUint32(0, dstSize, true);
  uniformView.setUint32(4, lbParams.unpaddedWidth, true);
  uniformView.setUint32(8, lbParams.unpaddedHeight, true);
  uniformView.setUint32(12, srcWidth, true);
  uniformView.setUint32(16, srcHeight, true);
  uniformView.setFloat32(20, lbParams.ratio, true);

  const uniformBuffer = device.createBuffer({
    size: uniformData.byteLength,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(uniformBuffer, 0, uniformData);

  // Step 4: Create bind group and dispatch compute
  const { pipeline, bindGroupLayout } = ensurePipeline(device, direct, autoLayout, observer);

  const textureView = srcTexture.createView();

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: direct ? [
      { binding: 0, resource: textureView },
      { binding: 1, resource: { buffer: nchwBuffer! } },
      { binding: 2, resource: { buffer: uniformBuffer } },
    ] : [
      { binding: 0, resource: textureView },
      { binding: 1, resource: { buffer: ch0Buffer! } },
      { binding: 2, resource: { buffer: ch1Buffer! } },
      { binding: 3, resource: { buffer: ch2Buffer! } },
      { binding: 4, resource: { buffer: uniformBuffer } },
    ],
  });

  const workgroupCount = Math.ceil(pixelCount / 256);

  const commandEncoder = device.createCommandEncoder();
  const passEncoder = commandEncoder.beginComputePass();
  passEncoder.setPipeline(pipeline);
  passEncoder.setBindGroup(0, bindGroup);
  passEncoder.dispatchWorkgroups(workgroupCount);
  passEncoder.end();

  // Step 5: Copy 3 channel buffers into a single NCHW buffer
  const outputBuffer = nchwBuffer ?? device.createBuffer({
    size: nchwBufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE | (verify ? GPUBufferUsage.COPY_SRC : 0),
  });

  if (!direct) {
    commandEncoder.copyBufferToBuffer(ch0Buffer!, 0, outputBuffer, 0, bufferSize);
    commandEncoder.copyBufferToBuffer(ch1Buffer!, 0, outputBuffer, bufferSize, bufferSize);
    commandEncoder.copyBufferToBuffer(ch2Buffer!, 0, outputBuffer, bufferSize * 2, bufferSize);
  }

  device.queue.submit([commandEncoder.finish()]);

  let intermediatesDisposed = false;
  const disposeIntermediates = () => {
    if (intermediatesDisposed) return;
    intermediatesDisposed = true;
    srcTexture.destroy();
    ch0Buffer?.destroy();
    ch1Buffer?.destroy();
    ch2Buffer?.destroy();
    uniformBuffer.destroy();
  };
  if (!noFence) {
    const fenceStart = markStart(observer);
    await device.queue.onSubmittedWorkDone();
    markEnd(observer, "detector-preprocess-fence", fenceStart);
    disposeIntermediates();
  }
  // The same queue executes preprocessing before ORT inference. With noFence,
  // retain inputs until the Worker disposes this tensor after reading outputs.

  const downloadNchw = async () => {
    const stagingBuffer = device.createBuffer({
      size: nchwBufferSize,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(outputBuffer, 0, stagingBuffer, 0, nchwBufferSize);
      device.queue.submit([encoder.finish()]);
      if (!noFence) await device.queue.onSubmittedWorkDone();
      await stagingBuffer.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(stagingBuffer.getMappedRange().slice(0));
      stagingBuffer.unmap();
      return data;
    } finally {
      stagingBuffer.destroy();
    }
  };

  // Step 6: Create ort.Tensor from the NCHW GPUBuffer
  const tensor = ortAll.Tensor.fromGpuBuffer(outputBuffer, {
    dims: [1, 3, dstSize, dstSize],
    dataType: "float32",
    download: downloadNchw,
    dispose: () => {
      disposeIntermediates();
      outputBuffer.destroy();
    },
  });

  // Quality-only probe. Do not call tensor.getData(): ORT would change its
  // location to CPU and subsequent inference would test a different feed path.
  if (verify) {
    const startedAt = performance.now();
    try {
      const data = await downloadNchw();
      const digest = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
      const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
      experimental.__shinobuColdStartInitMark?.({
        phase: "detector-input-sha256", startedAt, durationMs: performance.now() - startedAt,
        model: "detector", bytes: data.byteLength, dims: [1, 3, dstSize, dstSize], sha256,
      });
    } catch (error) {
      tensor.dispose();
      throw error;
    }
  }

  return { tensor, params: lbParams };
}
