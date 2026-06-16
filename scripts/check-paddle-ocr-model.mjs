#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import ort from "onnxruntime-node";

function usage() {
  console.log(`Usage: node scripts/check-paddle-ocr-model.mjs <model.onnx> <dict.txt> [height] [width]

Checks a PaddleOCR recognition ONNX model against its CTC dictionary.
`);
}

function parsePositiveInt(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid positive integer: ${value}`);
  }
  return parsed;
}

async function main() {
  const [modelPath, dictPath, heightArg, widthArg] = process.argv.slice(2);
  if (!modelPath || !dictPath || process.argv.includes("--help")) {
    usage();
    process.exit(modelPath && dictPath ? 0 : 1);
  }

  const inputHeight = parsePositiveInt(heightArg, 48);
  const inputWidth = parsePositiveInt(widthArg, 320);
  const dictText = await readFile(dictPath, "utf8");
  const dictSize = dictText.split(/\r?\n/g).filter((line) => line.length > 0).length;
  const expectedClasses = dictSize + 2;

  const session = await ort.InferenceSession.create(modelPath);
  const input = session.inputMetadata[0];
  const output = session.outputMetadata[0];
  if (!input || !output) {
    throw new Error("Model metadata is missing input or output");
  }

  const inputDims = [1, 3, inputHeight, inputWidth];
  const feeds = {
    [input.name]: new ort.Tensor("float32", new Float32Array(3 * inputHeight * inputWidth), inputDims),
  };
  const outputs = await session.run(feeds);
  const outputTensor = outputs[output.name];
  if (!outputTensor) {
    throw new Error(`Output ${output.name} was not returned`);
  }
  const outputDims = outputTensor.dims;
  const outputClasses = outputDims[outputDims.length - 1];

  const report = {
    modelPath,
    dictPath,
    input: {
      name: input.name,
      metadataShape: input.shape,
      smokeShape: inputDims,
    },
    output: {
      name: output.name,
      metadataShape: output.shape,
      smokeShape: outputDims,
    },
    dictSize,
    expectedClasses,
    outputClasses,
    ok: outputClasses === expectedClasses,
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    throw new Error(`Output classes ${outputClasses} did not match dict size + 2 (${expectedClasses})`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
