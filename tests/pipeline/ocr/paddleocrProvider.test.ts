import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelRuntime, TensorTransport } from '@shinobu/model-runtime';
import type {
  PipelineImage,
  PlatformProvider,
} from '../../../packages/image-pipeline/src/runtime/platform';
import type { TextRegion } from '../../../packages/image-pipeline/src/types';

const paddleMocks = vi.hoisted(() => ({
  buildPaddleOcrInput: vi.fn(),
}));

vi.mock('../../../packages/image-pipeline/src/pipeline/ocr/paddleocrPreprocess', () => ({
  buildPaddleOcrInput: paddleMocks.buildPaddleOcrInput,
}));

import { paddleocrV6MediumProvider } from '../../../packages/image-pipeline/src/pipeline/ocr/paddleocrProvider';

const image = {
  src: 'fixture.png',
  naturalWidth: 100,
  naturalHeight: 200,
  onload: null,
  onerror: null,
} as PipelineImage;

const regions: TextRegion[] = [{
  id: 'region-1',
  box: { x: 10, y: 20, width: 30, height: 80 },
  direction: 'v',
  sourceText: '',
  translatedText: '',
}];

function createRuntime(options: {
  inputNames?: string[];
  outputNames?: string[];
  outputs?: Record<string, TensorTransport>;
} = {}): ModelRuntime {
  return {
    readModel: vi.fn().mockResolvedValue({
      input: [48, 320],
      dictUrl: 'fixture-paddle-dict',
      normalize: 'minus_one_to_one',
      channelOrder: 'rgb',
      runtime: ['webgpu'],
    }),
    getSession: vi.fn().mockResolvedValue({
      sessionId: 'paddle-fixture-session',
      provider: 'webgpu',
      inputNames: options.inputNames ?? ['x'],
      outputNames: options.outputNames ?? ['logits'],
    }),
    run: vi.fn().mockResolvedValue({
      outputs: options.outputs ?? {},
    }),
    readTextResource: vi.fn().mockResolvedValue('A'),
  } as unknown as ModelRuntime;
}

describe('paddleocrV6MediumProvider', () => {
  beforeEach(() => {
    paddleMocks.buildPaddleOcrInput.mockReset();
    paddleMocks.buildPaddleOcrInput.mockReturnValue({
      data: new Float32Array(3 * 48),
      dims: [1, 3, 48, 1],
      resizedWidth: 1,
    });
  });

  it('treats a missing model input name as a runtime error', async () => {
    const runtime = createRuntime({ inputNames: [] });

    await expect(paddleocrV6MediumProvider.recognize(
      image,
      regions,
      {} as PlatformProvider,
      runtime,
    )).rejects.toThrow('PaddleOCR 模型缺少输入名称');
  });

  it('treats a missing logits tensor as a runtime error', async () => {
    const runtime = createRuntime({ outputs: {} });

    await expect(paddleocrV6MediumProvider.recognize(
      image,
      regions,
      {} as PlatformProvider,
      runtime,
    )).rejects.toThrow('模型未返回 logits 输出');
  });

  it('treats unsupported logits dimensions as a runtime error', async () => {
    const runtime = createRuntime({
      outputs: {
        logits: {
          data: new Float32Array([1]),
          dims: [1],
          type: 'float32',
        },
      },
    });

    await expect(paddleocrV6MediumProvider.recognize(
      image,
      regions,
      {} as PlatformProvider,
      runtime,
    )).rejects.toThrow('不支持的 logits 维度: 1');
  });

  it('returns an empty successful result for valid logits containing no text', async () => {
    const runtime = createRuntime({
      outputs: {
        logits: {
          data: new Float32Array([10, 0, 0]),
          dims: [1, 1, 3],
          type: 'float32',
        },
      },
    });

    const result = await paddleocrV6MediumProvider.recognize(
      image,
      regions,
      {} as PlatformProvider,
      runtime,
    );

    expect(result.results).toEqual([]);
    expect(result.debug?.paddle).toMatchObject({
      acceptedCount: 0,
      rejectedCount: 1,
      missingOutputCount: 0,
    });
  });
});
