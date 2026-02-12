import * as ort from "onnxruntime-web/all";
import { getModel, getModelSession } from "../runtime/modelRegistry";
import { isContextLostRuntimeError } from "../runtime/onnx";
import type { RuntimeProvider, WebNnDeviceType } from "../runtime/onnx";

export type InpaintResult = {
  canvas: HTMLCanvasElement;
  actualProvider: RuntimeProvider;
  actualWebnnDeviceType?: WebNnDeviceType;
};

type InpaintInputNormalize = "zero_to_one" | "minus_one_to_one";
type InpaintOutputNormalize = InpaintInputNormalize | "zero_to_255";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pickInpaintTensor(outputs: ort.InferenceSession.ReturnType): ort.Tensor | null {
  for (const value of Object.values(outputs)) {
    if (value.dims.length === 4 && value.dims[0] === 1 && value.dims[1] === 3) {
      return value;
    }
  }
  return null;
}

function preprocessInpaintImage(
  source: HTMLCanvasElement,
  mask: HTMLCanvasElement,
  size: number,
  normalize: InpaintInputNormalize
): {
  image: ort.Tensor;
  mask: ort.Tensor;
  sourceRgba: Uint8ClampedArray;
  maskBinary: Float32Array;
} {
  const imageCanvas = document.createElement("canvas");
  imageCanvas.width = size;
  imageCanvas.height = size;
  const imageCtx = imageCanvas.getContext("2d", { willReadFrequently: true });
  if (!imageCtx) {
    throw new Error("去字 ONNX 图像预处理失败");
  }
  imageCtx.drawImage(source, 0, 0, size, size);
  const imageData = imageCtx.getImageData(0, 0, size, size).data;

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = size;
  maskCanvas.height = size;
  const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
  if (!maskCtx) {
    throw new Error("去字 ONNX 遮罩预处理失败");
  }
  maskCtx.drawImage(mask, 0, 0, size, size);
  const maskData = maskCtx.getImageData(0, 0, size, size).data;

  const area = size * size;
  const imageOut = new Float32Array(3 * area);
  const maskOut = new Float32Array(area);
  const sourceRgba = new Uint8ClampedArray(imageData);
  for (let i = 0, p = 0; i < area; i += 1, p += 4) {
    const maskValue = maskData[p] > 127 ? 1 : 0;
    maskOut[i] = maskValue;
    const sourceR = imageData[p];
    const sourceG = imageData[p + 1];
    const sourceB = imageData[p + 2];
    const r = maskValue === 1 ? 0 : sourceR;
    const g = maskValue === 1 ? 0 : sourceG;
    const b = maskValue === 1 ? 0 : sourceB;
    if (normalize === "minus_one_to_one") {
      imageOut[i] = r / 127.5 - 1;
      imageOut[area + i] = g / 127.5 - 1;
      imageOut[2 * area + i] = b / 127.5 - 1;
    } else {
      imageOut[i] = r / 255;
      imageOut[area + i] = g / 255;
      imageOut[2 * area + i] = b / 255;
    }
  }
  return {
    image: new ort.Tensor("float32", imageOut, [1, 3, size, size]),
    mask: new ort.Tensor("float32", maskOut, [1, 1, size, size]),
    sourceRgba,
    maskBinary: maskOut
  };
}

function readCanvasRgba(source: HTMLCanvasElement, width: number, height: number): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("去字 ONNX 读取原图失败");
  }
  ctx.drawImage(source, 0, 0, width, height);
  return new Uint8ClampedArray(ctx.getImageData(0, 0, width, height).data);
}

function readMaskBinary(mask: HTMLCanvasElement, width: number, height: number): Float32Array {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    throw new Error("去字 ONNX 读取遮罩失败");
  }
  ctx.drawImage(mask, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height).data;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i += 1, p += 4) {
    out[i] = data[p] > 127 ? 1 : 0;
  }
  return out;
}

function resizeRgba(
  sourceRgba: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  outWidth: number,
  outHeight: number
): Uint8ClampedArray {
  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = sourceWidth;
  sourceCanvas.height = sourceHeight;
  const sourceCtx = sourceCanvas.getContext("2d");
  if (!sourceCtx) {
    throw new Error("去字 ONNX 图像缩放失败");
  }
  const sourceImage = sourceCtx.createImageData(sourceWidth, sourceHeight);
  sourceImage.data.set(sourceRgba);
  sourceCtx.putImageData(sourceImage, 0, 0);

  const outCanvas = document.createElement("canvas");
  outCanvas.width = outWidth;
  outCanvas.height = outHeight;
  const outCtx = outCanvas.getContext("2d", { willReadFrequently: true });
  if (!outCtx) {
    throw new Error("去字 ONNX 图像缩放失败");
  }
  outCtx.drawImage(sourceCanvas, 0, 0, outWidth, outHeight);
  return new Uint8ClampedArray(outCtx.getImageData(0, 0, outWidth, outHeight).data);
}

function decodeInpaintTensor(
  tensor: ort.Tensor,
  width: number,
  height: number,
  normalize: InpaintOutputNormalize
): Uint8ClampedArray {
  const area = width * height;
  const data = tensor.data;
  if (!(data instanceof Float32Array)) {
    throw new Error("去字 ONNX 输出类型不支持");
  }
  const out = new Uint8ClampedArray(area * 4);
  for (let i = 0, p = 0; i < area; i += 1, p += 4) {
    const r = data[i];
    const g = data[area + i];
    const b = data[2 * area + i];
    const rr =
      normalize === "minus_one_to_one" ? (r + 1) * 127.5 : normalize === "zero_to_255" ? r : r * 255;
    const gg =
      normalize === "minus_one_to_one" ? (g + 1) * 127.5 : normalize === "zero_to_255" ? g : g * 255;
    const bb =
      normalize === "minus_one_to_one" ? (b + 1) * 127.5 : normalize === "zero_to_255" ? b : b * 255;
    out[p] = clamp(Math.round(rr), 0, 255);
    out[p + 1] = clamp(Math.round(gg), 0, 255);
    out[p + 2] = clamp(Math.round(bb), 0, 255);
    out[p + 3] = 255;
  }
  return out;
}

function composeInpaintResult(
  sourceRgba: Uint8ClampedArray,
  inpaintedRgba: Uint8ClampedArray,
  maskBinary: Float32Array,
  width: number,
  height: number
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("去字 ONNX 合成失败");
  }
  const image = ctx.createImageData(width, height);
  const area = width * height;
  for (let i = 0, p = 0; i < area; i += 1, p += 4) {
    const useInpainted = maskBinary[i] >= 0.5;
    image.data[p] = useInpainted ? inpaintedRgba[p] : sourceRgba[p];
    image.data[p + 1] = useInpainted ? inpaintedRgba[p + 1] : sourceRgba[p + 1];
    image.data[p + 2] = useInpainted ? inpaintedRgba[p + 2] : sourceRgba[p + 2];
    image.data[p + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

function isLikelyInvalidInpaintResult(
  sourceRgba: Uint8ClampedArray,
  inpaintedRgba: Uint8ClampedArray,
  maskBinary: Float32Array
): boolean {
  let maskedCount = 0;
  let sourceLumaSum = 0;
  let inpaintLumaSum = 0;
  let nearlyBlackCount = 0;

  for (let i = 0, p = 0; i < maskBinary.length; i += 1, p += 4) {
    if (maskBinary[i] < 0.5) {
      continue;
    }
    maskedCount += 1;

    const sourceLuma =
      sourceRgba[p] * 0.299 + sourceRgba[p + 1] * 0.587 + sourceRgba[p + 2] * 0.114;
    const inpaintLuma =
      inpaintedRgba[p] * 0.299 + inpaintedRgba[p + 1] * 0.587 + inpaintedRgba[p + 2] * 0.114;

    sourceLumaSum += sourceLuma;
    inpaintLumaSum += inpaintLuma;
    if (inpaintLuma <= 8) {
      nearlyBlackCount += 1;
    }
  }

  if (maskedCount < 64) {
    return false;
  }

  const sourceMean = sourceLumaSum / maskedCount;
  const inpaintMean = inpaintLumaSum / maskedCount;
  const blackRatio = nearlyBlackCount / maskedCount;

  return sourceMean >= 40 && inpaintMean <= 10 && blackRatio >= 0.9;
}

async function runInpaintByOnnx(
  originalCanvas: HTMLCanvasElement,
  refinedMaskCanvas: HTMLCanvasElement
): Promise<InpaintResult> {
  const model = await getModel("inpaint");
  const primaryHandle = await getModelSession("inpaint", ["webgpu", "webnn", "wasm"]);
  const size = model.input?.[0] ?? 512;
  const normalize = model.normalize ?? "zero_to_one";
  const outputNormalize = model.outputNormalize ?? normalize;
  if (refinedMaskCanvas.width <= 0 || refinedMaskCanvas.height <= 0) {
    throw new Error("去字 ONNX 缺少有效 refined mask，已禁用文本框遮罩回退");
  }
  const feeds = preprocessInpaintImage(originalCanvas, refinedMaskCanvas, size, normalize);
  const runWithHandle = async (handle: { session: ort.InferenceSession }): Promise<ort.InferenceSession.ReturnType> => {
    const imageName = handle.session.inputNames[0];
    const maskName = model.maskInputName ?? handle.session.inputNames[1];
    if (!imageName || !maskName) {
      throw new Error("去字 ONNX 模型输入定义不完整");
    }
    return handle.session.run({
      [imageName]: feeds.image,
      [maskName]: feeds.mask
    });
  };

  const decodeOutputs = (outputs: ort.InferenceSession.ReturnType): Uint8ClampedArray => {
    const outTensor = pickInpaintTensor(outputs);
    if (!outTensor) {
      throw new Error("去字 ONNX 模型输出未匹配到图像张量");
    }
    return decodeInpaintTensor(outTensor, size, size, outputNormalize);
  };

  let actualProvider: RuntimeProvider = primaryHandle.provider;
  let actualWebnnDeviceType = primaryHandle.webnnDeviceType;
  let outputs: ort.InferenceSession.ReturnType;
  try {
    outputs = await runWithHandle(primaryHandle);
  } catch (error) {
    const message = toErrorMessage(error);
    const reason = isContextLostRuntimeError(error) ? "context lost" : "run failed";
    if (primaryHandle.provider === "wasm") {
      throw error;
    }

    const fallbackPlans: RuntimeProvider[][] = [];
    if (primaryHandle.provider === "webgpu") {
      fallbackPlans.push(["webnn", "wasm"]);
    }
    fallbackPlans.push(["wasm"]);

    let recovered: ort.InferenceSession.ReturnType | null = null;
    let lastFallbackError: unknown = null;
    console.warn(`[inpaint] ${primaryHandle.provider} ${reason}, 尝试回退: ${message}`);

    for (const preferred of fallbackPlans) {
      try {
        const handle = await getModelSession("inpaint", preferred);
        recovered = await runWithHandle(handle);
        if (handle.provider !== primaryHandle.provider) {
          console.warn(`[inpaint] 已回退到 ${handle.provider}`);
          actualProvider = handle.provider;
          actualWebnnDeviceType = handle.webnnDeviceType;
        }
        break;
      } catch (fallbackError) {
        lastFallbackError = fallbackError;
      }
    }

    if (!recovered) {
      const fallbackMessage = lastFallbackError ? toErrorMessage(lastFallbackError) : "未知错误";
      throw new Error(`去字推理失败且回退失败: ${message} | fallback: ${fallbackMessage}`);
    }

    outputs = recovered;
  }

  let inpaintedRgba = decodeOutputs(outputs);

  if (
    actualProvider === "webnn" &&
    isLikelyInvalidInpaintResult(feeds.sourceRgba, inpaintedRgba, feeds.maskBinary)
  ) {
    const wasmHandle = await getModelSession("inpaint", ["wasm"]);
    const wasmOutputs = await runWithHandle(wasmHandle);
    inpaintedRgba = decodeOutputs(wasmOutputs);
    actualProvider = "wasm";
    actualWebnnDeviceType = undefined;
  }

  const outputWidth = originalCanvas.width;
  const outputHeight = originalCanvas.height;
  const originalSourceRgba = readCanvasRgba(originalCanvas, outputWidth, outputHeight);
  const originalMaskBinary = readMaskBinary(refinedMaskCanvas, outputWidth, outputHeight);
  const inpaintedRgbaAtOriginalSize = resizeRgba(inpaintedRgba, size, size, outputWidth, outputHeight);

  const canvas = composeInpaintResult(
    originalSourceRgba,
    inpaintedRgbaAtOriginalSize,
    originalMaskBinary,
    outputWidth,
    outputHeight
  );

  return { canvas, actualProvider, actualWebnnDeviceType };
}

export async function runInpaint(
  originalCanvas: HTMLCanvasElement,
  refinedMaskCanvas: HTMLCanvasElement
): Promise<InpaintResult> {
  return runInpaintByOnnx(originalCanvas, refinedMaskCanvas);
}
