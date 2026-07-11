import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { onnx } = require("../node_modules/onnxruntime-web/lib/onnxjs/ort-schema/protobuf/onnx.js");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_INPUT = resolve(ROOT, "public/models/ocr.onnx");
const DEFAULT_ENCODER = resolve(ROOT, "public/models/ocr_encoder.onnx");
const DEFAULT_DECODER = resolve(ROOT, "public/models/ocr_decoder.onnx");
const MEMORY_NAME = "/encoders.3/Add_1_output_0";
const ENCODER_LEN = 80;
const MEMORY_WIDTH = 320;

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? resolve(found.slice(prefix.length)) : fallback;
}

function memoryValueInfo(name) {
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

function splitModel(inputPath, encoderPath, decoderPath) {
  const source = onnx.ModelProto.decode(readFileSync(inputPath));
  const graph = source.graph;
  const nodes = graph.node;
  const initByName = new Map(graph.initializer.map((tensor) => [tensor.name, tensor]));
  const graphInputByName = new Map(graph.input.map((value) => [value.name, value]));
  const graphOutputByName = new Map(graph.output.map((value) => [value.name, value]));
  const nodeByOutput = new Map();

  for (let i = 0; i < nodes.length; i += 1) {
    for (const output of nodes[i].output) {
      if (output) nodeByOutput.set(output, i);
    }
  }

  function collectNodes(outputNames, stopNames) {
    const needed = new Set();
    const seen = new Set();
    const missing = new Set();
    const stack = [...outputNames];

    while (stack.length > 0) {
      const name = stack.pop();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      if (stopNames.has(name) || graphInputByName.has(name) || initByName.has(name)) continue;

      const index = nodeByOutput.get(name);
      if (index === undefined) {
        missing.add(name);
        continue;
      }
      if (!needed.has(index)) {
        needed.add(index);
        for (const input of nodes[index].input) stack.push(input);
      }
    }

    if (missing.size > 0) {
      throw new Error(`Missing graph values: ${Array.from(missing).slice(0, 8).join(", ")}`);
    }

    return Array.from(needed).sort((a, b) => a - b).map((index) => nodes[index]);
  }

  function collectInitializers(modelNodes) {
    const used = new Set();
    for (const node of modelNodes) {
      for (const input of node.input) {
        if (initByName.has(input)) used.add(input);
      }
    }
    return Array.from(used).map((name) => initByName.get(name));
  }

  function makeModel(name, modelNodes, inputNames, outputInfos) {
    const model = onnx.ModelProto.create({
      irVersion: source.irVersion,
      opsetImport: source.opsetImport,
      producerName: "shinobu-ocr-split",
      producerVersion: source.producerVersion,
      graph: onnx.GraphProto.create({
        name,
        node: modelNodes,
        initializer: collectInitializers(modelNodes),
        input: inputNames.map((inputName) => (
          inputName === MEMORY_NAME ? memoryValueInfo(MEMORY_NAME) : graphInputByName.get(inputName)
        )),
        output: outputInfos,
        valueInfo: [],
        sparseInitializer: [],
        quantizationAnnotation: [],
      }),
      metadataProps: [],
      trainingInfo: [],
      functions: [],
    });
    return onnx.ModelProto.encode(model).finish();
  }

  const encoderNodes = collectNodes([MEMORY_NAME], new Set());
  const decoderNodes = collectNodes(["logits", "fg", "bg", "fg_ind", "bg_ind"], new Set([MEMORY_NAME]));

  mkdirSync(dirname(encoderPath), { recursive: true });
  mkdirSync(dirname(decoderPath), { recursive: true });
  writeFileSync(
    encoderPath,
    makeModel("ocr_encoder", encoderNodes, ["image", "encoder_mask"], [memoryValueInfo(MEMORY_NAME)])
  );
  writeFileSync(
    decoderPath,
    makeModel(
      "ocr_decoder",
      decoderNodes,
      [MEMORY_NAME, "char_idx", "decoder_mask", "encoder_mask"],
      ["logits", "fg", "bg", "fg_ind", "bg_ind"].map((name) => graphOutputByName.get(name))
    )
  );

  return {
    encoderNodes: encoderNodes.length,
    decoderNodes: decoderNodes.length,
    encoderMB: Math.round(statSync(encoderPath).size / 1024 / 1024 * 100) / 100,
    decoderMB: Math.round(statSync(decoderPath).size / 1024 / 1024 * 100) / 100,
  };
}

const inputPath = readArg("in", DEFAULT_INPUT);
const encoderPath = readArg("encoder-out", DEFAULT_ENCODER);
const decoderPath = readArg("decoder-out", DEFAULT_DECODER);
const result = splitModel(inputPath, encoderPath, decoderPath);
console.log(JSON.stringify({ inputPath, encoderPath, decoderPath, ...result }, null, 2));
