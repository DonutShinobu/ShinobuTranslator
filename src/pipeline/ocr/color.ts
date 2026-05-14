import * as ort from "onnxruntime-web/all";
import { OCR_AR_PAD_BIGINT, OCR_AR_START_BIGINT } from "./ocrShared";
import { getOutputByName } from "./decodeAutoregressive";
import type { OcrInputData } from "./preprocess";

function buildBatchImageTensor(
  inputs: OcrInputData[],
  inputHeight: number,
  inputWidth: number
): ort.Tensor {
  const N = inputs.length;
  const pixelsPerImage = 3 * inputHeight * inputWidth;
  const batchData = new Float32Array(N * pixelsPerImage);
  for (let i = 0; i < N; i += 1) {
    batchData.set(inputs[i].data, i * pixelsPerImage);
  }
  return new ort.Tensor("float32", batchData, [N, 3, inputHeight, inputWidth]);
}

export type OcrColorResult = {
  fgColor: [number, number, number];
  bgColor: [number, number, number];
};

export type OcrSessionRunCounter = {
  sessionRunCount: number;
  sessionRunTotalMs: number;
};

function extractColorsFromOutputs(
  fg: Float32Array,
  bg: Float32Array,
  fgInd: Float32Array,
  bgInd: Float32Array,
  stepsPerSample: number,
  sampleOffset: number,
  tokenCount: number
): OcrColorResult | null {
  const maxSteps = Math.min(tokenCount, stepsPerSample);
  if (maxSteps <= 0) {
    return null;
  }

  let fr = 0;
  let fgCh = 0;
  let fb = 0;
  let br = 0;
  let bgCh = 0;
  let bb = 0;
  let cntFg = 0;
  let cntBg = 0;

  for (let t = 0; t < maxSteps; t += 1) {
    const fgBase = (sampleOffset + t) * 3;
    const bgBase = (sampleOffset + t) * 3;
    const fgIndBase = (sampleOffset + t) * 2;
    const bgIndBase = (sampleOffset + t) * 2;
    const hasFg = fgInd[fgIndBase + 1] > fgInd[fgIndBase];
    const hasBg = bgInd[bgIndBase + 1] > bgInd[bgIndBase];
    if (hasFg) {
      fr += Math.round(Math.max(0, Math.min(1, fg[fgBase])) * 255);
      fgCh += Math.round(Math.max(0, Math.min(1, fg[fgBase + 1])) * 255);
      fb += Math.round(Math.max(0, Math.min(1, fg[fgBase + 2])) * 255);
      cntFg += 1;
    }
    if (hasBg) {
      br += Math.round(Math.max(0, Math.min(1, bg[bgBase])) * 255);
      bgCh += Math.round(Math.max(0, Math.min(1, bg[bgBase + 1])) * 255);
      bb += Math.round(Math.max(0, Math.min(1, bg[bgBase + 2])) * 255);
      cntBg += 1;
    } else {
      br += Math.round(Math.max(0, Math.min(1, fg[fgBase])) * 255);
      bgCh += Math.round(Math.max(0, Math.min(1, fg[fgBase + 1])) * 255);
      bb += Math.round(Math.max(0, Math.min(1, fg[fgBase + 2])) * 255);
      cntBg += 1;
    }
  }

  const fgColor: [number, number, number] = [
    cntFg > 0 ? Math.round(fr / cntFg) : 0,
    cntFg > 0 ? Math.round(fgCh / cntFg) : 0,
    cntFg > 0 ? Math.round(fb / cntFg) : 0
  ];
  const bgColor: [number, number, number] = [
    cntBg > 0 ? Math.round(br / cntBg) : 0,
    cntBg > 0 ? Math.round(bgCh / cntBg) : 0,
    cntBg > 0 ? Math.round(bb / cntBg) : 0
  ];
  return { fgColor, bgColor };
}

export async function decodeTokenColors(
  session: ort.InferenceSession,
  inputs: {
    imageInput: string;
    imageTensor: ort.Tensor;
    charIdxInput: string;
    decoderMaskInput: string;
    encoderMaskInput: string;
  },
  options: {
    seqLen: number;
    encoderLen: number;
    validEncoderLength: number;
    tokenIds: number[];
  },
  runCounter?: OcrSessionRunCounter
): Promise<OcrColorResult | null> {
  const { imageInput, imageTensor, charIdxInput, decoderMaskInput, encoderMaskInput } = inputs;
  const { seqLen, encoderLen, validEncoderLength, tokenIds } = options;
  if (tokenIds.length === 0) {
    return null;
  }
  const charData = new BigInt64Array(seqLen);
  charData.fill(OCR_AR_PAD_BIGINT);
  charData[0] = OCR_AR_START_BIGINT;
  for (let i = 0; i < tokenIds.length && i + 1 < seqLen; i += 1) {
    charData[i + 1] = BigInt(tokenIds[i]);
  }

  const decoderMask = new Array<boolean>(seqLen).fill(true);
  for (let i = 0; i < tokenIds.length + 1 && i < seqLen; i += 1) {
    decoderMask[i] = false;
  }

  const encoderMask = new Array<boolean>(encoderLen).fill(false);
  for (let i = validEncoderLength; i < encoderLen; i += 1) {
    encoderMask[i] = true;
  }

  const runT0 = performance.now();
  const outputs = await session.run({
    [imageInput]: imageTensor,
    [charIdxInput]: new ort.Tensor("int64", charData, [1, seqLen]),
    [decoderMaskInput]: new ort.Tensor("bool", decoderMask, [1, seqLen]),
    [encoderMaskInput]: new ort.Tensor("bool", encoderMask, [1, encoderLen])
  });
  const runDurationMs = performance.now() - runT0;
  if (runCounter) {
    runCounter.sessionRunCount += 1;
    runCounter.sessionRunTotalMs += runDurationMs;
  }

  const fg = getOutputByName(outputs, "fg", 3);
  const bg = getOutputByName(outputs, "bg", 3);
  const fgInd = getOutputByName(outputs, "fg_ind", 3);
  const bgInd = getOutputByName(outputs, "bg_ind", 3);
  if (!fg || !bg || !fgInd || !bgInd) {
    return null;
  }
  if (!(fg.data instanceof Float32Array) || !(bg.data instanceof Float32Array) || !(fgInd.data instanceof Float32Array) || !(bgInd.data instanceof Float32Array)) {
    return null;
  }

  const stepsPerSample = Math.min(fg.dims[1] ?? 0, bg.dims[1] ?? 0, fgInd.dims[1] ?? 0, bgInd.dims[1] ?? 0);
  return extractColorsFromOutputs(fg.data, bg.data, fgInd.data, bgInd.data, stepsPerSample, 0, tokenIds.length);
}

export type BatchColorItem = {
  inputData: OcrInputData;
  validEncoderLength: number;
  tokenIds: number[];
};

export async function decodeTokenColorsBatch(
  session: ort.InferenceSession,
  inputNames: {
    imageInput: string;
    charIdxInput: string;
    decoderMaskInput: string;
    encoderMaskInput: string;
  },
  items: BatchColorItem[],
  seqLen: number,
  encoderLen: number,
  inputHeight: number,
  inputWidth: number,
  runCounter?: OcrSessionRunCounter
): Promise<(OcrColorResult | null)[]> {
  const N = items.length;
  if (N === 0) {
    return [];
  }

  const { imageInput, charIdxInput, decoderMaskInput, encoderMaskInput } = inputNames;

  const batchImage = buildBatchImageTensor(items.map((item) => item.inputData), inputHeight, inputWidth);
  const batchCharData = new BigInt64Array(N * seqLen);
  const batchDecoderMask = new Array<boolean>(N * seqLen);
  const batchEncoderMask = new Array<boolean>(N * encoderLen);

  for (let n = 0; n < N; n += 1) {
    const { validEncoderLength, tokenIds } = items[n];
    const charOffset = n * seqLen;
    for (let i = 0; i < seqLen; i += 1) {
      batchCharData[charOffset + i] = OCR_AR_PAD_BIGINT;
    }
    batchCharData[charOffset] = OCR_AR_START_BIGINT;
    for (let i = 0; i < tokenIds.length && i + 1 < seqLen; i += 1) {
      batchCharData[charOffset + i + 1] = BigInt(tokenIds[i]);
    }

    const dmOffset = n * seqLen;
    for (let i = 0; i < seqLen; i += 1) {
      batchDecoderMask[dmOffset + i] = i >= tokenIds.length + 1;
    }

    const emOffset = n * encoderLen;
    for (let i = 0; i < encoderLen; i += 1) {
      batchEncoderMask[emOffset + i] = i >= validEncoderLength;
    }
  }

  const runT0 = performance.now();
  const outputs = await session.run({
    [imageInput]: batchImage,
    [charIdxInput]: new ort.Tensor("int64", batchCharData, [N, seqLen]),
    [decoderMaskInput]: new ort.Tensor("bool", batchDecoderMask, [N, seqLen]),
    [encoderMaskInput]: new ort.Tensor("bool", batchEncoderMask, [N, encoderLen])
  });
  const runDurationMs = performance.now() - runT0;
  if (runCounter) {
    runCounter.sessionRunCount += 1;
    runCounter.sessionRunTotalMs += runDurationMs;
  }

  const fg = getOutputByName(outputs, "fg", 3);
  const bg = getOutputByName(outputs, "bg", 3);
  const fgInd = getOutputByName(outputs, "fg_ind", 3);
  const bgInd = getOutputByName(outputs, "bg_ind", 3);
  if (!fg || !bg || !fgInd || !bgInd) {
    return items.map(() => null);
  }
  if (!(fg.data instanceof Float32Array) || !(bg.data instanceof Float32Array) || !(fgInd.data instanceof Float32Array) || !(bgInd.data instanceof Float32Array)) {
    return items.map(() => null);
  }

  const stepsPerSample = fg.dims[1] ?? 0;
  const results: (OcrColorResult | null)[] = [];
  for (let n = 0; n < N; n += 1) {
    results.push(
      extractColorsFromOutputs(
        fg.data,
        bg.data,
        fgInd.data,
        bgInd.data,
        stepsPerSample,
        n * stepsPerSample,
        items[n].tokenIds.length
      )
    );
  }
  return results;
}