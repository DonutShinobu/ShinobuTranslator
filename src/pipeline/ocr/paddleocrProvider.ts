import type { OcrProvider, OcrRecognizeOutput, OcrRecognizeResult } from './provider';
import type { TextRegion, QuadPoint } from '../../types';
import type { PlatformProvider, PipelineImage } from '../../runtime/platform';
import { getModel, getModelSession } from '../../runtime/modelRegistry';
import { buildPaddleOcrInput } from './paddleocrPreprocess';
import { decodePaddleCtc } from './paddleocrDecode';
import { loadCharset } from './ocrShared';
import { runInference } from '../../runtime/onnxBridge';
import type { Direction } from './preprocess';

const PADDLEOCR_CONFIDENCE_THRESHOLD = 0.2;

function inferDirection(region: TextRegion): Direction {
  if (region.direction) return region.direction;
  return region.box.height > region.box.width ? 'v' : 'h';
}

export const paddleocrProvider: OcrProvider = {
  name: 'paddleocr',
  async recognize(image: PipelineImage, regions: TextRegion[], platform?: PlatformProvider): Promise<OcrRecognizeOutput> {
    const model = await getModel('paddleocr_rec');
    const sessionHandle = await getModelSession('paddleocr_rec', model.runtime ?? ['webgpu', 'webnn', 'wasm']);
    const charset = await loadCharset(model.dictUrl);
    if (!charset) {
      throw new Error('PaddleOCR 字典加载失败');
    }
    // CTC 解码需要索引 0 为 blank，在字典前插入空字符串作为 blank token
    // PaddleOCR use_space_char: 在字典末尾追加半角空格
    const ctcCharset = ['', ...charset, ' '];

    const inputHeight = model.input[0];
    const maxInputWidth = model.input[1];

    const imageInputName = sessionHandle.inputNames[0];
    if (!imageInputName) {
      return { results: [], provider: sessionHandle.provider, webnnDeviceType: sessionHandle.webnnDeviceType };
    }

    const results: OcrRecognizeResult[] = [];

    for (const region of regions) {
      const direction = inferDirection(region);
      const inputData = buildPaddleOcrInput(
        image, region, direction, inputHeight, maxInputWidth, model.normalize ?? 'minus_one_to_one', platform!
      );

      const feeds: Record<string, import('../../runtime/onnxWorkerTypes').TensorTransport> = {
        [imageInputName]: {
          data: inputData.data,
          dims: inputData.dims,
          type: 'float32' as const,
        },
      };

      const inferenceResult = await runInference(sessionHandle.sessionId, feeds);

      if (inferenceResult.error) {
        throw new Error(inferenceResult.error);
      }

      const outputs = inferenceResult.outputs;

      // PaddleOCR rec 输出: [1, timeSteps, numClasses] 或 [timeSteps, numClasses]
      const logitsOutput = outputs[sessionHandle.outputNames[0]];
      if (!logitsOutput) continue;

      const logitsData = logitsOutput.data as Float32Array;
      const logitsDims = logitsOutput.dims;

      let timeSteps: number;
      let numClasses: number;
      let logits: Float32Array;

      if (logitsDims.length === 3) {
        // [1, timeSteps, numClasses] — remove batch dimension
        timeSteps = logitsDims[1];
        numClasses = logitsDims[2];
        logits = logitsData;
      } else if (logitsDims.length === 2) {
        // [timeSteps, numClasses]
        timeSteps = logitsDims[0];
        numClasses = logitsDims[1];
        logits = logitsData;
      } else {
        continue;
      }

      const decoded = decodePaddleCtc(logits, timeSteps, numClasses, ctcCharset);

      if (decoded.confidence < PADDLEOCR_CONFIDENCE_THRESHOLD || decoded.text.trim() === '') {
        continue;
      }

      // Build quad from region.box if region.quad is missing
      const quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint] = region.quad ?? [
        { x: region.box.x, y: region.box.y },
        { x: region.box.x + region.box.width, y: region.box.y },
        { x: region.box.x + region.box.width, y: region.box.y + region.box.height },
        { x: region.box.x, y: region.box.y + region.box.height },
      ];

      results.push({
        text: decoded.text,
        confidence: decoded.confidence,
        quad,
      });
    }

    return { results, provider: sessionHandle.provider, webnnDeviceType: sessionHandle.webnnDeviceType };
  },
};
