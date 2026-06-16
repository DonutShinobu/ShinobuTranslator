import type { OcrProvider, OcrRecognizeOutput, OcrRecognizeResult } from './provider';
import type { TextRegion, QuadPoint } from '../../types';
import type { PlatformProvider, PipelineImage } from '../../runtime/platform';
import type { ModelName } from '../../runtime/modelRegistry';
import type { TensorTransport } from '../../runtime/onnxWorkerTypes';
import { getModel, getModelSession } from '../../runtime/modelRegistry';
import { buildPaddleOcrInput } from './paddleocrPreprocess';
import { decodePaddleCtc } from './paddleocrDecode';
import { loadCharset } from './ocrShared';
import { runInference } from '../../runtime/onnxBridge';
import type { Direction } from './preprocess';

const PADDLEOCR_CONFIDENCE_THRESHOLD = 0.2;

type PaddleOcrModelName = Extract<
  ModelName,
  'paddleocr_v6_medium_rec'
>;

function inferDirection(region: TextRegion): Direction {
  if (region.direction) return region.direction;
  return region.box.height > region.box.width ? 'v' : 'h';
}

function createPaddleOcrProvider(name: string, modelName: PaddleOcrModelName): OcrProvider {
  return {
    name,
    async recognize(image: PipelineImage, regions: TextRegion[], platform?: PlatformProvider): Promise<OcrRecognizeOutput> {
      if (!platform) {
        throw new Error('PaddleOCR 需要可用的运行平台');
      }
      const model = await getModel(modelName);
      const sessionHandle = await getModelSession(modelName, model.runtime ?? ['webgpu', 'webnn', 'wasm']);
      const charset = await loadCharset(model.dictUrl);
      if (!charset) {
        throw new Error('PaddleOCR 字典加载失败');
      }

      // CTC 解码需要索引 0 为 blank，在字典前插入空字符串作为 blank token。
      // PaddleOCR use_space_char: 在字典末尾追加半角空格。
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
          image,
          region,
          direction,
          inputHeight,
          maxInputWidth,
          model.normalize ?? 'minus_one_to_one',
          platform,
          model.channelOrder ?? 'rgb',
        );

        const feeds: Record<string, TensorTransport> = {
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

        const logitsOutput = inferenceResult.outputs[sessionHandle.outputNames[0]];
        if (!logitsOutput) continue;

        const logitsData = logitsOutput.data as Float32Array;
        const logitsDims = logitsOutput.dims;
        let timeSteps: number;
        let numClasses: number;
        let logits: Float32Array;
        if (logitsDims.length === 3) {
          timeSteps = logitsDims[1];
          numClasses = logitsDims[2];
          logits = logitsData;
        } else if (logitsDims.length === 2) {
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
}

export const paddleocrV6MediumProvider = createPaddleOcrProvider('paddleocr_v6_medium', 'paddleocr_v6_medium_rec');
