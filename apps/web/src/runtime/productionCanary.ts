import { decodeWebSettings } from '@shinobu/shared-config';
import { recoverPipelineRecord } from '@shinobu/image-pipeline';
import {
  createWebTranslatorCore,
  type WebPipelineInput,
  type WebPipelineResult,
  type WebTranslatorCore,
} from './webPipeline';
import { toWebPipelineConfig } from './webPipelineConfig';

type ProductionCanaryDependencies = {
  createCore: () => WebTranslatorCore;
  createInput: () => Promise<WebPipelineInput>;
};

const CANARY_EDGE = 512;
const CANARY_TIMEOUT_MS = 120_000;

async function createSyntheticInput(): Promise<WebPipelineInput> {
  const canvas = new OffscreenCanvas(CANARY_EDGE, CANARY_EDGE);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('合成流水线测试无法创建 Canvas');

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, CANARY_EDGE, CANARY_EDGE);
  context.fillStyle = '#fffdf8';
  context.strokeStyle = '#161412';
  context.lineWidth = 8;
  context.beginPath();
  context.ellipse(256, 240, 190, 125, -0.08, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.fillStyle = '#161412';
  context.font = '700 54px sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText('テスト', 256, 240);

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return {
    file: new File([blob], 'shinobu-runtime-canary.png', {
      type: 'image/png',
      lastModified: 0,
    }),
    workingCopy: {
      strategy: 'normalized',
      sourceSize: {
        width: CANARY_EDGE,
        height: CANARY_EDGE,
      },
      size: {
        width: CANARY_EDGE,
        height: CANARY_EDGE,
      },
      imageOrientation: 'from-image',
      background: '#ffffff',
    },
  };
}

function validateCanaryResult(result: WebPipelineResult): void {
  const record = recoverPipelineRecord(result.record);
  if (
    result.image.type !== 'image/png'
    || result.image.size === 0
    || record.workingCopy.width !== CANARY_EDGE
    || record.workingCopy.height !== CANARY_EDGE
  ) {
    throw new Error('合成流水线测试没有生成有效的 512×512 PNG');
  }
}

export async function runSyntheticProductionCanary(options: {
  signal?: AbortSignal;
  dependencies?: Partial<ProductionCanaryDependencies>;
} = {}): Promise<void> {
  const dependencies: ProductionCanaryDependencies = {
    createCore: createWebTranslatorCore,
    createInput: createSyntheticInput,
    ...options.dependencies,
  };
  const core = dependencies.createCore();
  let cancelTask: ((reason?: unknown) => void) | undefined;
  const abort = (): void => cancelTask?.(options.signal?.reason);
  options.signal?.addEventListener('abort', abort, { once: true });

  try {
    if (options.signal?.aborted) throw options.signal.reason;
    const input = await dependencies.createInput();
    if (options.signal?.aborted) throw options.signal.reason;

    const settings = decodeWebSettings(null, 'zh-CN').settings;
    const task = core.run({
      input,
      config: toWebPipelineConfig({
        ...settings,
        processMode: 'erase',
      }),
    });
    cancelTask = task.cancel.bind(task);
    const timeout = globalThis.setTimeout(() => {
      task.cancel(new DOMException('合成流水线能力测试超时', 'TimeoutError'));
    }, CANARY_TIMEOUT_MS);
    try {
      validateCanaryResult(await task.result);
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    options.signal?.removeEventListener('abort', abort);
    await core.dispose(new DOMException('合成流水线能力测试已结束', 'AbortError'));
  }
}
