/**
 * Browser WebGPU OCR argmax prototype.
 *
 * This benchmark keeps production OCR untouched. It prepares real OCR inputs in
 * Node, runs the OCR ONNX model in Chrome WebGPU twice, and compares:
 *
 * - CPU path: logits downloaded to CPU, then argmax in JS.
 * - GPU path: logits kept as GPUBuffer, argmax via WGSL, then small readback.
 */

import { createServer } from "http";
import type { AddressInfo } from "net";
import { existsSync, readFileSync } from "fs";
import { readFile } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { detectTextRegionsWithMask } from "../../../src/pipeline/detect";
import { buildOcrInput, generateTextDirection } from "../../../src/pipeline/ocr/preprocess";
import { getModel } from "../../../src/runtime/modelRegistry";
import { nodePlatform } from "../../../src/runtime/nodePlatform";

const ROOT = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_IMAGE = resolve(ROOT, "benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png");
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].filter((value): value is string => !!value);

type PreparedBatch = {
  imagePath: string;
  detectedRegions: number;
  batchSize: number;
  inputHeight: number;
  inputWidth: number;
  seqLen: number;
  encoderLen: number;
  decodeStep: number;
  validEncoderLengths: number[];
  batchImage: number[];
};

type BrowserPayload = {
  rootUrl: string;
  batch: PreparedBatch;
};

type TokenScore = {
  token: number;
  score: number;
};

type ProbeResult = {
  gpu: {
    secureContext: boolean;
    hasNavigatorGpu: boolean;
    adapter: boolean;
    adapterInfo: {
      vendor?: string;
      architecture?: string;
      device?: string;
      description?: string;
    } | null;
  };
  batchSize: number;
  classes: number;
  steps: number;
  cpuPath: {
    sessionCreateMs: number;
    runMs: number;
    argmaxMs: number;
    tokens: TokenScore[];
  };
  gpuPath: {
    sessionCreateMs: number;
    pipelineCreateMs: number;
    runMs: number;
    argmaxReadbackMs: number;
    outputLocation: string;
    tokens: TokenScore[];
  };
  comparison: {
    tokenMismatches: number;
    maxScoreDiff: number;
    bytesDownloadedCpuLogits: number;
    bytesDownloadedGpuResult: number;
  };
};

function imageToDataUrl(path: string): string {
  const buf = readFileSync(path);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

function pickImagePath(): string {
  const arg = process.argv.find((value) => value.startsWith("--image="));
  const imagePath = arg ? resolve(arg.slice("--image=".length)) : DEFAULT_IMAGE;
  if (!existsSync(imagePath)) {
    throw new Error(`图片不存在: ${imagePath}`);
  }
  return imagePath;
}

function pickBatchLimit(): number {
  const arg = process.argv.find((value) => value.startsWith("--batch="));
  const parsed = arg ? Number.parseInt(arg.slice("--batch=".length), 10) : 4;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`无效 batch 参数: ${arg}`);
  }
  return Math.min(24, parsed);
}

function findChromeExecutable(): string {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("未找到 Chrome。可通过 CHROME_PATH 指定 chrome.exe 路径。");
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".mjs") || filePath.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (filePath.endsWith(".wasm")) return "application/wasm";
  if (filePath.endsWith(".onnx")) return "application/octet-stream";
  if (filePath.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function prepareBatch(imagePath: string, batchLimit: number): Promise<PreparedBatch> {
  const model = await getModel("ocr");
  const inputHeight = model.input?.[0] ?? 48;
  const inputWidth = model.input?.[1] ?? 320;
  const normalize = model.normalize ?? "minus_one_to_one";
  const seqLen = 64;
  const encoderLen = 80;
  const image = await nodePlatform.loadImage(imageToDataUrl(imagePath));
  const detected = await detectTextRegionsWithMask(image, nodePlatform);
  const candidates = generateTextDirection(detected.regions).slice(0, batchLimit);
  if (candidates.length === 0) {
    throw new Error("未检测到可用于 OCR 的文字区域");
  }

  const pixelsPerImage = 3 * inputHeight * inputWidth;
  const batchImage = new Float32Array(candidates.length * pixelsPerImage);
  const validEncoderLengths: number[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const { region, direction } = candidates[i];
    const input = buildOcrInput(image, region, direction, inputHeight, inputWidth, normalize, nodePlatform);
    batchImage.set(input.data, i * pixelsPerImage);
    validEncoderLengths.push(Math.min(encoderLen, Math.floor((input.resizedWidth + 3) / 4) + 2));
  }

  return {
    imagePath,
    detectedRegions: detected.regions.length,
    batchSize: candidates.length,
    inputHeight,
    inputWidth,
    seqLen,
    encoderLen,
    decodeStep: 0,
    validEncoderLengths,
    batchImage: Array.from(batchImage),
  };
}

async function startStaticServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    if (!req.url) {
      res.writeHead(400).end("bad request");
      return;
    }
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__probe.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><meta charset=\"utf-8\"><title>ocr gpu argmax probe</title>");
      return;
    }
    const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const fullPath = resolve(ROOT, relativePath);
    if (!fullPath.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    try {
      const data = await readFile(fullPath);
      res.writeHead(200, { "content-type": contentType(fullPath) });
      res.end(data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.writeHead(404).end(message);
    }
  });

  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) {
          rejectClose(error);
        } else {
          resolveClose();
        }
      });
    }),
  };
}

async function runBrowserProbe(payload: BrowserPayload): Promise<ProbeResult> {
  const chromePath = findChromeExecutable();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({
      executablePath: chromePath,
      headless: false,
      args: [
        "--enable-unsafe-webgpu",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
      ],
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(180000);
    await page.goto(`${payload.rootUrl}/__probe.html`);
    await page.addScriptTag({ content: "var __name = (target) => target;" });
    return await page.evaluate<ProbeResult, BrowserPayload>(async (browserPayload) => {
      type OrtTensor = {
        dims: number[];
        data: unknown;
        location: string;
        gpuBuffer: GPUBuffer;
        dispose?: () => void;
      };
      type OrtSession = {
        run: (feeds: Record<string, unknown>, fetches?: string[]) => Promise<Record<string, OrtTensor>>;
        release?: () => Promise<void>;
      };
      type OrtLike = {
        env: {
          wasm: { wasmPaths: string; numThreads: number };
          webgpu?: { powerPreference?: string; device?: GPUDevice };
        };
        Tensor: new (type: string, data: unknown, dims: number[]) => unknown;
        InferenceSession: {
          create: (url: string, options: Record<string, unknown>) => Promise<OrtSession>;
        };
      };

      const round = (value: number) => Math.round(value * 100) / 100;
      const time = async <T>(fn: () => Promise<T>): Promise<{ value: T; elapsedMs: number }> => {
        const start = performance.now();
        const value = await fn();
        return { value, elapsedMs: performance.now() - start };
      };
      const disposeOutputs = (outputs: Record<string, OrtTensor>): void => {
        for (const tensor of Object.values(outputs)) {
          tensor.dispose?.();
        }
      };
      const buildFeeds = (ort: OrtLike): Record<string, unknown> => {
        const batch = browserPayload.batch;
        const charData = new BigInt64Array(batch.batchSize * batch.seqLen);
        charData.fill(0n);
        const decoderMask = new Array<boolean>(batch.batchSize * batch.seqLen).fill(true);
        const encoderMask = new Array<boolean>(batch.batchSize * batch.encoderLen).fill(false);
        for (let n = 0; n < batch.batchSize; n += 1) {
          const charOffset = n * batch.seqLen;
          charData[charOffset] = 1n;
          decoderMask[charOffset] = false;
          const encoderOffset = n * batch.encoderLen;
          const validEncoderLength = batch.validEncoderLengths[n];
          for (let i = validEncoderLength; i < batch.encoderLen; i += 1) {
            encoderMask[encoderOffset + i] = true;
          }
        }
        return {
          image: new ort.Tensor(
            "float32",
            Float32Array.from(batch.batchImage),
            [batch.batchSize, 3, batch.inputHeight, batch.inputWidth]
          ),
          char_idx: new ort.Tensor("int64", charData, [batch.batchSize, batch.seqLen]),
          decoder_mask: new ort.Tensor("bool", decoderMask, [batch.batchSize, batch.seqLen]),
          encoder_mask: new ort.Tensor("bool", encoderMask, [batch.batchSize, batch.encoderLen]),
        };
      };
      const cpuArgmax = (logits: Float32Array, batchSize: number, steps: number, classes: number, decodeStep: number): TokenScore[] => {
        const tokens: TokenScore[] = [];
        for (let n = 0; n < batchSize; n += 1) {
          const base = (n * steps + decodeStep) * classes;
          let bestToken = 0;
          let bestScore = Number.NEGATIVE_INFINITY;
          for (let c = 0; c < classes; c += 1) {
            const score = logits[base + c];
            if (score > bestScore) {
              bestScore = score;
              bestToken = c;
            }
          }
          tokens.push({ token: bestToken, score: bestScore });
        }
        return tokens;
      };

      class GpuArgmaxReducer {
        private readonly device: GPUDevice;
        private readonly pass1: GPUComputePipeline;
        private readonly pass2: GPUComputePipeline;

        constructor(device: GPUDevice) {
          this.device = device;
          const pass1Module = device.createShaderModule({
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
@group(0) @binding(1) var<storage, read_write> partials: array<Best>;
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
    partials[sample * params.chunks_per_sample + chunk] = Best(scores[0], tokens[0]);
  }
}
`,
          });
          const pass2Module = device.createShaderModule({
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
@group(0) @binding(0) var<storage, read> partials: array<Best>;
@group(0) @binding(1) var<storage, read_write> results: array<Best>;
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
    let item = partials[sample * params.chunks_per_sample + local];
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
    results[sample] = Best(scores[0], tokens[0]);
  }
}
`,
          });
          this.pass1 = device.createComputePipeline({ layout: "auto", compute: { module: pass1Module, entryPoint: "main" } });
          this.pass2 = device.createComputePipeline({ layout: "auto", compute: { module: pass2Module, entryPoint: "main" } });
        }

        async reduce(logitsBuffer: GPUBuffer, batchSize: number, steps: number, classes: number, decodeStep: number): Promise<TokenScore[]> {
          const chunksPerSample = Math.ceil(classes / 256);
          if (chunksPerSample > 256) {
            throw new Error(`chunksPerSample 超出 prototype 限制: ${chunksPerSample}`);
          }
          const partialBuffer = this.device.createBuffer({
            size: batchSize * chunksPerSample * 8,
            usage: GPUBufferUsage.STORAGE,
          });
          const resultBuffer = this.device.createBuffer({
            size: batchSize * 8,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
          });
          const readbackBuffer = this.device.createBuffer({
            size: batchSize * 8,
            usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
          });
          const paramsBuffer = this.device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          });
          this.device.queue.writeBuffer(paramsBuffer, 0, new Uint32Array([classes, steps, decodeStep, chunksPerSample]));

          const encoder = this.device.createCommandEncoder();
          const pass1 = encoder.beginComputePass();
          pass1.setPipeline(this.pass1);
          pass1.setBindGroup(0, this.device.createBindGroup({
            layout: this.pass1.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: logitsBuffer } },
              { binding: 1, resource: { buffer: partialBuffer } },
              { binding: 2, resource: { buffer: paramsBuffer } },
            ],
          }));
          pass1.dispatchWorkgroups(chunksPerSample, batchSize);
          pass1.end();

          const pass2 = encoder.beginComputePass();
          pass2.setPipeline(this.pass2);
          pass2.setBindGroup(0, this.device.createBindGroup({
            layout: this.pass2.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: partialBuffer } },
              { binding: 1, resource: { buffer: resultBuffer } },
              { binding: 2, resource: { buffer: paramsBuffer } },
            ],
          }));
          pass2.dispatchWorkgroups(batchSize);
          pass2.end();
          encoder.copyBufferToBuffer(resultBuffer, 0, readbackBuffer, 0, batchSize * 8);
          this.device.queue.submit([encoder.finish()]);
          await readbackBuffer.mapAsync(GPUMapMode.READ);
          const view = new DataView(readbackBuffer.getMappedRange());
          const tokens: TokenScore[] = [];
          for (let n = 0; n < batchSize; n += 1) {
            tokens.push({
              score: view.getFloat32(n * 8, true),
              token: view.getUint32(n * 8 + 4, true),
            });
          }
          readbackBuffer.unmap();
          partialBuffer.destroy();
          resultBuffer.destroy();
          readbackBuffer.destroy();
          paramsBuffer.destroy();
          return tokens;
        }
      }

      const gpu = {
        secureContext: window.isSecureContext,
        hasNavigatorGpu: !!navigator.gpu,
        adapter: false,
        adapterInfo: null as ProbeResult["gpu"]["adapterInfo"],
      };
      if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        gpu.adapter = !!adapter;
        gpu.adapterInfo = adapter?.info ? {
          vendor: adapter.info.vendor,
          architecture: adapter.info.architecture,
          device: adapter.info.device,
          description: adapter.info.description,
        } : null;
      }
      if (!gpu.adapter) {
        throw new Error("WebGPU adapter 不可用");
      }

      const ortModule = await import("/node_modules/onnxruntime-web/dist/ort.all.bundle.min.mjs");
      const ort = (("default" in ortModule ? ortModule.default : ortModule) as unknown) as OrtLike;
      ort.env.wasm.wasmPaths = "/node_modules/onnxruntime-web/dist/";
      ort.env.wasm.numThreads = 1;
      if (ort.env.webgpu) {
        ort.env.webgpu.powerPreference = "high-performance";
      }

      const cpuCreate = await time(() => ort.InferenceSession.create("/public/models/ocr.onnx", {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "all",
      }));
      const cpuSession = cpuCreate.value;
      const cpuWarmOutputs = await cpuSession.run(buildFeeds(ort), ["logits"]);
      disposeOutputs(cpuWarmOutputs);
      const cpuRun = await time(() => cpuSession.run(buildFeeds(ort), ["logits"]));
      const logitsTensor = cpuRun.value.logits;
      if (!(logitsTensor.data instanceof Float32Array)) {
        throw new Error("CPU path logits 未返回 Float32Array");
      }
      const [batchSize, steps, classes] = logitsTensor.dims;
      const cpuArgmaxTime = await time(async () => cpuArgmax(
        logitsTensor.data as Float32Array,
        batchSize,
        steps,
        classes,
        browserPayload.batch.decodeStep
      ));
      disposeOutputs(cpuRun.value);
      await cpuSession.release?.();

      const gpuCreate = await time(() => ort.InferenceSession.create("/public/models/ocr.onnx", {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "all",
        preferredOutputLocation: { logits: "gpu-buffer" },
      }));
      const gpuSession = gpuCreate.value;
      const device = ort.env.webgpu?.device;
      if (!device) {
        throw new Error("ort.env.webgpu.device 不可用");
      }
      const pipelineCreate = await time(async () => new GpuArgmaxReducer(device));
      const reducer = pipelineCreate.value;

      const gpuWarmOutputs = await gpuSession.run(buildFeeds(ort), ["logits"]);
      const warmLogits = gpuWarmOutputs.logits;
      if (warmLogits.location !== "gpu-buffer") {
        throw new Error(`GPU path logits location 异常: ${warmLogits.location}`);
      }
      await reducer.reduce(warmLogits.gpuBuffer, browserPayload.batch.batchSize, steps, classes, browserPayload.batch.decodeStep);
      disposeOutputs(gpuWarmOutputs);

      const gpuRun = await time(() => gpuSession.run(buildFeeds(ort), ["logits"]));
      const gpuLogits = gpuRun.value.logits;
      if (gpuLogits.location !== "gpu-buffer") {
        throw new Error(`GPU path logits location 异常: ${gpuLogits.location}`);
      }
      const gpuOutputLocation = gpuLogits.location;
      const gpuArgmaxTime = await time(() => reducer.reduce(
        gpuLogits.gpuBuffer,
        batchSize,
        steps,
        classes,
        browserPayload.batch.decodeStep
      ));
      disposeOutputs(gpuRun.value);
      await gpuSession.release?.();

      let tokenMismatches = 0;
      let maxScoreDiff = 0;
      for (let i = 0; i < cpuArgmaxTime.value.length; i += 1) {
        if (cpuArgmaxTime.value[i].token !== gpuArgmaxTime.value[i].token) {
          tokenMismatches += 1;
        }
        maxScoreDiff = Math.max(maxScoreDiff, Math.abs(cpuArgmaxTime.value[i].score - gpuArgmaxTime.value[i].score));
      }

      return {
        gpu,
        batchSize,
        classes,
        steps,
        cpuPath: {
          sessionCreateMs: round(cpuCreate.elapsedMs),
          runMs: round(cpuRun.elapsedMs),
          argmaxMs: round(cpuArgmaxTime.elapsedMs),
          tokens: cpuArgmaxTime.value.map((item) => ({ token: item.token, score: round(item.score) })),
        },
        gpuPath: {
          sessionCreateMs: round(gpuCreate.elapsedMs),
          pipelineCreateMs: round(pipelineCreate.elapsedMs),
          runMs: round(gpuRun.elapsedMs),
          argmaxReadbackMs: round(gpuArgmaxTime.elapsedMs),
          outputLocation: gpuOutputLocation,
          tokens: gpuArgmaxTime.value.map((item) => ({ token: item.token, score: round(item.score) })),
        },
        comparison: {
          tokenMismatches,
          maxScoreDiff: round(maxScoreDiff),
          bytesDownloadedCpuLogits: batchSize * steps * classes * 4,
          bytesDownloadedGpuResult: batchSize * 8,
        },
      };
    }, payload);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function main(): Promise<void> {
  const imagePath = pickImagePath();
  const batchLimit = pickBatchLimit();
  const batch = await prepareBatch(imagePath, batchLimit);
  const server = await startStaticServer();
  try {
    const result = await runBrowserProbe({ rootUrl: server.url, batch });
    console.log(JSON.stringify({
      image: batch.imagePath,
      detectedRegions: batch.detectedRegions,
      ...result,
    }, null, 2));
  } finally {
    await server.close();
  }
}

await main();
