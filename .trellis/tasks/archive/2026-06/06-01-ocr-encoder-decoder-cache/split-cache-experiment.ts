import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { detectTextRegionsWithMask } from "../../../src/pipeline/detect";
import { nodePlatform } from "../../../src/runtime/nodePlatform";
import { normalizeTextLight } from "../../../src/pipeline/utils";
import {
  buildOcrInput,
  generateTextDirection,
  type OcrInputData,
} from "../../../src/pipeline/ocr/preprocess";
import {
  OCR_AR_END,
  OCR_AR_PAD,
  OCR_AR_PAD_BIGINT,
  OCR_AR_START,
  avgLogProbToConfidence,
  loadCharset,
  tokenToTextAutoregressive,
} from "../../../src/pipeline/ocr/ocrShared";

const require = createRequire(import.meta.url);
const ort = require("onnxruntime-node");
const { onnx } = require("../../../node_modules/onnxruntime-web/lib/onnxjs/ort-schema/protobuf/onnx.js");

const ROOT = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_IMAGE = join(ROOT, "benchmark/color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png");
const ARTIFACT_DIR = join(ROOT, ".trellis/tasks/06-01-ocr-encoder-decoder-cache/artifacts");
const FULL_MODEL_PATH = join(ROOT, "public/models/ocr.onnx");
const ENCODER_MODEL_PATH = join(ARTIFACT_DIR, "ocr_encoder_exp.onnx");
const DECODER_MODEL_PATH = join(ARTIFACT_DIR, "ocr_decoder_exp.onnx");
const MEMORY_NAME = "/encoders.3/Add_1_output_0";
const INPUT_HEIGHT = 48;
const INPUT_WIDTH = 320;
const SEQ_LEN = 64;
const ENCODER_LEN = 80;
const MEMORY_WIDTH = 320;

type PreparedItem = {
  regionId: string;
  inputData: OcrInputData;
  validEncoderLength: number;
};

type DecodeResult = {
  text: string;
  confidence: number;
  tokenIds: number[];
};

type DecodeSummary = {
  encoderRunMs?: number;
  decoderRunMs?: number;
  modelRunMs: number;
  wallMs: number;
  stepCount: number;
  activeCounts: number[];
  results: DecodeResult[];
};

function imageToDataUrl(path: string): string {
  const buf = readFileSync(path);
  return `data:image/png;base64,${buf.toString("base64")}`;
}

function createMemoryValueInfo(name: string) {
  return onnx.ValueInfoProto.create({
    name,
    type: {
      tensorType: {
        elemType: 1,
        shape: {
          dim: [
            { dimParam: "batch" },
            { dimValue: ENCODER_LEN },
            { dimValue: MEMORY_WIDTH },
          ],
        },
      },
    },
  });
}

function createSplitModels(): void {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const source = onnx.ModelProto.decode(readFileSync(FULL_MODEL_PATH));
  const graph = source.graph;
  const nodes = graph.node;
  const initByName = new Map(graph.initializer.map((tensor: { name: string }) => [tensor.name, tensor]));
  const graphInputByName = new Map(graph.input.map((value: { name: string }) => [value.name, value]));
  const graphOutputByName = new Map(graph.output.map((value: { name: string }) => [value.name, value]));
  const nodeByOutput = new Map<string, number>();

  for (let i = 0; i < nodes.length; i += 1) {
    for (const output of nodes[i].output as string[]) {
      if (output) {
        nodeByOutput.set(output, i);
      }
    }
  }

  const collectNodes = (outputNames: string[], stopNames: Set<string>) => {
    const needed = new Set<number>();
    const seen = new Set<string>();
    const stack = [...outputNames];
    const missing = new Set<string>();
    while (stack.length > 0) {
      const name = stack.pop();
      if (!name || seen.has(name)) {
        continue;
      }
      seen.add(name);
      if (stopNames.has(name) || graphInputByName.has(name) || initByName.has(name)) {
        continue;
      }
      const nodeIndex = nodeByOutput.get(name);
      if (nodeIndex === undefined) {
        missing.add(name);
        continue;
      }
      if (!needed.has(nodeIndex)) {
        needed.add(nodeIndex);
        for (const input of nodes[nodeIndex].input as string[]) {
          stack.push(input);
        }
      }
    }
    if (missing.size > 0) {
      throw new Error(`missing graph values: ${Array.from(missing).slice(0, 5).join(", ")}`);
    }
    return Array.from(needed).sort((a, b) => a - b).map((index) => nodes[index]);
  };

  const collectInitializers = (modelNodes: Array<{ input: string[] }>) => {
    const used = new Set<string>();
    for (const node of modelNodes) {
      for (const input of node.input) {
        if (initByName.has(input)) {
          used.add(input);
        }
      }
    }
    return Array.from(used).map((name) => initByName.get(name));
  };

  const makeModel = (
    name: string,
    modelNodes: Array<{ input: string[] }>,
    inputNames: string[],
    outputInfos: unknown[]
  ) => onnx.ModelProto.encode(onnx.ModelProto.create({
    irVersion: source.irVersion,
    opsetImport: source.opsetImport,
    producerName: "shinobu-ocr-split-experiment",
    producerVersion: source.producerVersion,
    graph: onnx.GraphProto.create({
      name,
      node: modelNodes,
      initializer: collectInitializers(modelNodes),
      input: inputNames.map((inputName) => (
        inputName === MEMORY_NAME ? createMemoryValueInfo(MEMORY_NAME) : graphInputByName.get(inputName)
      )),
      output: outputInfos,
      valueInfo: [],
      sparseInitializer: [],
      quantizationAnnotation: [],
    }),
    metadataProps: [],
    trainingInfo: [],
    functions: [],
  })).finish();

  const encoderNodes = collectNodes([MEMORY_NAME], new Set());
  const decoderNodes = collectNodes(["logits", "fg", "bg", "fg_ind", "bg_ind"], new Set([MEMORY_NAME]));

  writeFileSync(
    ENCODER_MODEL_PATH,
    makeModel("ocr_encoder_exp", encoderNodes, ["image", "encoder_mask"], [createMemoryValueInfo(MEMORY_NAME)])
  );
  writeFileSync(
    DECODER_MODEL_PATH,
    makeModel(
      "ocr_decoder_exp",
      decoderNodes,
      [MEMORY_NAME, "char_idx", "decoder_mask", "encoder_mask"],
      ["logits", "fg", "bg", "fg_ind", "bg_ind"].map((outputName) => graphOutputByName.get(outputName))
    )
  );
}

function buildImageTensor(items: PreparedItem[], indices: readonly number[]) {
  const pixelsPerImage = 3 * INPUT_HEIGHT * INPUT_WIDTH;
  const data = new Float32Array(indices.length * pixelsPerImage);
  for (let local = 0; local < indices.length; local += 1) {
    data.set(items[indices[local]].inputData.data, local * pixelsPerImage);
  }
  return new ort.Tensor("float32", data, [indices.length, 3, INPUT_HEIGHT, INPUT_WIDTH]);
}

function buildEncoderMaskTensor(items: PreparedItem[], indices: readonly number[]) {
  const mask = new Array<boolean>(indices.length * ENCODER_LEN).fill(false);
  for (let local = 0; local < indices.length; local += 1) {
    const valid = items[indices[local]].validEncoderLength;
    const offset = local * ENCODER_LEN;
    for (let pos = valid; pos < ENCODER_LEN; pos += 1) {
      mask[offset + pos] = true;
    }
  }
  return new ort.Tensor("bool", mask, [indices.length, ENCODER_LEN]);
}

function buildCharTensor(tokenIds: number[][], indices: readonly number[]) {
  const data = new BigInt64Array(indices.length * SEQ_LEN);
  data.fill(OCR_AR_PAD_BIGINT);
  for (let local = 0; local < indices.length; local += 1) {
    const tokens = tokenIds[indices[local]];
    const offset = local * SEQ_LEN;
    for (let pos = 0; pos < tokens.length && pos < SEQ_LEN; pos += 1) {
      data[offset + pos] = BigInt(tokens[pos]);
    }
  }
  return new ort.Tensor("int64", data, [indices.length, SEQ_LEN]);
}

function buildDecoderMaskTensor(tokenIds: number[][], indices: readonly number[]) {
  const mask = new Array<boolean>(indices.length * SEQ_LEN).fill(true);
  for (let local = 0; local < indices.length; local += 1) {
    const tokens = tokenIds[indices[local]];
    const offset = local * SEQ_LEN;
    for (let pos = 0; pos < tokens.length && pos < SEQ_LEN; pos += 1) {
      mask[offset + pos] = false;
    }
  }
  return new ort.Tensor("bool", mask, [indices.length, SEQ_LEN]);
}

function buildMemoryTensor(memory: Float32Array, indices: readonly number[]) {
  const valuesPerSample = ENCODER_LEN * MEMORY_WIDTH;
  const data = new Float32Array(indices.length * valuesPerSample);
  for (let local = 0; local < indices.length; local += 1) {
    const sourceOffset = indices[local] * valuesPerSample;
    data.set(memory.subarray(sourceOffset, sourceOffset + valuesPerSample), local * valuesPerSample);
  }
  return new ort.Tensor("float32", data, [indices.length, ENCODER_LEN, MEMORY_WIDTH]);
}

function decodeStep(raw: Float32Array, local: number, decodeStepIndex: number, stepsPerSample: number, classes: number) {
  const stepOffset = local * stepsPerSample * classes + decodeStepIndex * classes;
  let bestToken = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let c = 0; c < classes; c += 1) {
    const score = raw[stepOffset + c];
    if (score > bestScore) {
      bestScore = score;
      bestToken = c;
    }
  }
  let maxLogit = Number.NEGATIVE_INFINITY;
  for (let c = 0; c < classes; c += 1) {
    const score = raw[stepOffset + c];
    if (score > maxLogit) {
      maxLogit = score;
    }
  }
  let sumExp = 0;
  for (let c = 0; c < classes; c += 1) {
    sumExp += Math.exp(raw[stepOffset + c] - maxLogit);
  }
  const probability = sumExp > 0 ? Math.exp(raw[stepOffset + bestToken] - maxLogit) / sumExp : 0;
  return { bestToken, probability };
}

async function decodeFull(session: unknown, items: PreparedItem[], charset: string[] | null): Promise<DecodeSummary> {
  const tokenIds = items.map(() => [OCR_AR_START]);
  const tokenProbs = items.map(() => [] as number[]);
  const finished = items.map(() => false);
  const activeCounts: number[] = [];
  let modelRunMs = 0;
  let stepCount = 0;
  const wallT0 = performance.now();

  for (let step = 0; step < SEQ_LEN - 1; step += 1) {
    const active = tokenIds
      .map((tokens, index) => ({ tokens, index }))
      .filter(({ tokens, index }) => !finished[index] && tokens.length < SEQ_LEN)
      .map(({ index }) => index);
    if (active.length === 0) {
      break;
    }
    activeCounts.push(active.length);
    const runT0 = performance.now();
    const outputs = await (session as { run: (feeds: Record<string, unknown>) => Promise<Record<string, typeof ort.Tensor>> }).run({
      image: buildImageTensor(items, active),
      char_idx: buildCharTensor(tokenIds, active),
      decoder_mask: buildDecoderMaskTensor(tokenIds, active),
      encoder_mask: buildEncoderMaskTensor(items, active),
    });
    modelRunMs += performance.now() - runT0;
    stepCount += 1;
    const logits = outputs.logits;
    const raw = logits.data as Float32Array;
    const stepsPerSample = logits.dims[1];
    const classes = logits.dims[2];
    for (let local = 0; local < active.length; local += 1) {
      const sourceIndex = active[local];
      const stepIndex = Math.min(tokenIds[sourceIndex].length - 1, stepsPerSample - 1);
      const { bestToken, probability } = decodeStep(raw, local, stepIndex, stepsPerSample, classes);
      if (bestToken === OCR_AR_PAD || bestToken === OCR_AR_END) {
        finished[sourceIndex] = true;
        continue;
      }
      tokenIds[sourceIndex].push(bestToken);
      tokenProbs[sourceIndex].push(probability);
    }
  }

  return {
    modelRunMs,
    wallMs: performance.now() - wallT0,
    stepCount,
    activeCounts,
    results: tokenIds.map((tokens, index) => ({
      text: normalizeTextLight(tokens.slice(1).map((id) => tokenToTextAutoregressive(id, charset)).join("")),
      confidence: avgLogProbToConfidence(tokenProbs[index]),
      tokenIds: tokens.slice(1),
    })),
  };
}

async function decodeSplit(encoder: unknown, decoder: unknown, items: PreparedItem[], charset: string[] | null): Promise<DecodeSummary> {
  const tokenIds = items.map(() => [OCR_AR_START]);
  const tokenProbs = items.map(() => [] as number[]);
  const finished = items.map(() => false);
  const allIndices = items.map((_, index) => index);
  const wallT0 = performance.now();
  const encoderT0 = performance.now();
  const encoderOutputs = await (encoder as { run: (feeds: Record<string, unknown>) => Promise<Record<string, typeof ort.Tensor>> }).run({
    image: buildImageTensor(items, allIndices),
    encoder_mask: buildEncoderMaskTensor(items, allIndices),
  });
  const encoderRunMs = performance.now() - encoderT0;
  const memory = encoderOutputs[MEMORY_NAME].data as Float32Array;

  const activeCounts: number[] = [];
  let decoderRunMs = 0;
  let stepCount = 0;

  for (let step = 0; step < SEQ_LEN - 1; step += 1) {
    const active = tokenIds
      .map((tokens, index) => ({ tokens, index }))
      .filter(({ tokens, index }) => !finished[index] && tokens.length < SEQ_LEN)
      .map(({ index }) => index);
    if (active.length === 0) {
      break;
    }
    activeCounts.push(active.length);
    const decoderT0 = performance.now();
    const outputs = await (decoder as { run: (feeds: Record<string, unknown>) => Promise<Record<string, typeof ort.Tensor>> }).run({
      [MEMORY_NAME]: buildMemoryTensor(memory, active),
      char_idx: buildCharTensor(tokenIds, active),
      decoder_mask: buildDecoderMaskTensor(tokenIds, active),
      encoder_mask: buildEncoderMaskTensor(items, active),
    });
    decoderRunMs += performance.now() - decoderT0;
    stepCount += 1;
    const logits = outputs.logits;
    const raw = logits.data as Float32Array;
    const stepsPerSample = logits.dims[1];
    const classes = logits.dims[2];
    for (let local = 0; local < active.length; local += 1) {
      const sourceIndex = active[local];
      const stepIndex = Math.min(tokenIds[sourceIndex].length - 1, stepsPerSample - 1);
      const { bestToken, probability } = decodeStep(raw, local, stepIndex, stepsPerSample, classes);
      if (bestToken === OCR_AR_PAD || bestToken === OCR_AR_END) {
        finished[sourceIndex] = true;
        continue;
      }
      tokenIds[sourceIndex].push(bestToken);
      tokenProbs[sourceIndex].push(probability);
    }
  }

  return {
    encoderRunMs,
    decoderRunMs,
    modelRunMs: encoderRunMs + decoderRunMs,
    wallMs: performance.now() - wallT0,
    stepCount,
    activeCounts,
    results: tokenIds.map((tokens, index) => ({
      text: normalizeTextLight(tokens.slice(1).map((id) => tokenToTextAutoregressive(id, charset)).join("")),
      confidence: avgLogProbToConfidence(tokenProbs[index]),
      tokenIds: tokens.slice(1),
    })),
  };
}

async function main(): Promise<void> {
  const imagePathArg = process.argv.find((arg) => arg.startsWith("--image="));
  const imagePath = imagePathArg ? resolve(imagePathArg.slice("--image=".length)) : DEFAULT_IMAGE;
  if (!existsSync(imagePath)) {
    throw new Error(`image does not exist: ${imagePath}`);
  }

  createSplitModels();
  const image = await nodePlatform.loadImage(imageToDataUrl(imagePath));
  const detected = await detectTextRegionsWithMask(image, nodePlatform);
  const candidates = generateTextDirection(detected.regions);
  const prepared: PreparedItem[] = [];
  for (const candidate of candidates) {
    const inputData = buildOcrInput(image, candidate.region, candidate.direction, INPUT_HEIGHT, INPUT_WIDTH, "minus_one_to_one", nodePlatform);
    const validEncoderLength = Math.min(ENCODER_LEN, Math.floor((inputData.resizedWidth + 3) / 4) + 2);
    prepared.push({ regionId: candidate.region.id, inputData, validEncoderLength });
  }

  const charset = await loadCharset(join(ROOT, "public/models/ocr_dict.txt"));
  const full = await ort.InferenceSession.create(FULL_MODEL_PATH, { executionProviders: ["cpu"] });
  const encoder = await ort.InferenceSession.create(ENCODER_MODEL_PATH, { executionProviders: ["cpu"] });
  const decoder = await ort.InferenceSession.create(DECODER_MODEL_PATH, { executionProviders: ["cpu"] });

  const fullSummary = await decodeFull(full, prepared, charset);
  const splitSummary = await decodeSplit(encoder, decoder, prepared, charset);
  const mismatches = fullSummary.results
    .map((result, index) => ({
      index,
      full: result.text,
      split: splitSummary.results[index]?.text ?? "",
    }))
    .filter((item) => item.full !== item.split);

  console.log(JSON.stringify({
    image: imagePath,
    detectedRegions: detected.regions.length,
    preparedCount: prepared.length,
    splitModels: {
      encoderMB: Math.round(statSync(ENCODER_MODEL_PATH).size / 1024 / 1024 * 100) / 100,
      decoderMB: Math.round(statSync(DECODER_MODEL_PATH).size / 1024 / 1024 * 100) / 100,
    },
    full: {
      modelRunMs: Math.round(fullSummary.modelRunMs * 100) / 100,
      wallMs: Math.round(fullSummary.wallMs * 100) / 100,
      stepCount: fullSummary.stepCount,
      activeCounts: fullSummary.activeCounts,
    },
    split: {
      encoderRunMs: Math.round((splitSummary.encoderRunMs ?? 0) * 100) / 100,
      decoderRunMs: Math.round((splitSummary.decoderRunMs ?? 0) * 100) / 100,
      modelRunMs: Math.round(splitSummary.modelRunMs * 100) / 100,
      wallMs: Math.round(splitSummary.wallMs * 100) / 100,
      stepCount: splitSummary.stepCount,
      activeCounts: splitSummary.activeCounts,
    },
    modelRunReductionPct: Math.round((1 - splitSummary.modelRunMs / fullSummary.modelRunMs) * 10000) / 100,
    wallReductionPct: Math.round((1 - splitSummary.wallMs / fullSummary.wallMs) * 10000) / 100,
    mismatches,
    samples: splitSummary.results.slice(0, 5).map((result, index) => ({
      index,
      text: result.text,
      confidence: Math.round(result.confidence * 10000) / 10000,
    })),
  }, null, 2));
}

await main();
