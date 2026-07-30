import {
  createWorkerTranslatorCore,
  type DisposableTranslatorCore,
  type WorkerClientEndpoint,
} from '@shinobu/browser-runtime';
import type {
  ImagePipelineResult,
  NormalizedWorkingCopySpec,
  PipelineConfig,
  PipelineProgress,
  ProviderExecutionPolicy,
} from '@shinobu/image-pipeline';
import {
  isCurrentPipelineRecord,
  isProviderExecutionReport,
} from '@shinobu/image-pipeline';
import type { LocalPipelineArtifactSummary } from '../../../../src/shared/localPipelineProtocol';
import { LocalPipelineRemoteError } from '../../../../src/shared/localPipelineProtocol';

export type WebPipelineRuntimeCapabilities = {
  textTranslation: {
    apiKey: string;
  };
  providerExecution?: {
    policy: ProviderExecutionPolicy;
  };
};

export type WebPipelineInput = {
  file: File;
  workingCopy:
    | NormalizedWorkingCopySpec
    | {
        width: number;
        height: number;
      };
};

export type WebPipelineResult = ImagePipelineResult & {
  summary: LocalPipelineArtifactSummary;
};

type WebWorkerPipelineConfig = {
  pipeline: PipelineConfig;
  capabilities: WebPipelineRuntimeCapabilities;
};

export type WebTranslatorCore = DisposableTranslatorCore<
  WebPipelineInput,
  PipelineConfig,
  PipelineProgress,
  WebPipelineResult
>;

function revivePipelineError(value: unknown): Error {
  if (
    value
    && typeof value === 'object'
    && 'name' in value
    && 'code' in value
    && 'message' in value
  ) {
    return new LocalPipelineRemoteError(
      value as ConstructorParameters<typeof LocalPipelineRemoteError>[0],
    );
  }
  return new Error('翻译 Worker 返回了无法识别的错误');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isWebPipelineResult(value: unknown): value is WebPipelineResult {
  if (
    !isRecord(value)
    || (value.status !== 'completed' && value.status !== 'no-translatable-text')
    || !(value.image instanceof Blob)
    || (value.debug !== undefined && !(value.debug instanceof Blob))
    || !isCurrentPipelineRecord(value.record)
    || !Array.isArray(value.providerReports)
    || !value.providerReports.every(isProviderExecutionReport)
    || !isRecord(value.summary)
    || !isRecord(value.summary.image)
  ) {
    return false;
  }
  return typeof value.summary.image.width === 'number'
    && Number.isFinite(value.summary.image.width)
    && typeof value.summary.image.height === 'number'
    && Number.isFinite(value.summary.image.height)
    && Number.isInteger(value.summary.detectedRegionCount)
    && (value.summary.detectedRegionCount as number) >= 0
    && Array.isArray(value.summary.stageTimings)
    && Array.isArray(value.summary.runtimeStages)
    && Array.isArray(value.summary.providerReports)
    && value.summary.providerReports.every(isProviderExecutionReport);
}

export function createWebTranslatorCore(
  capabilities: WebPipelineRuntimeCapabilities = {
    textTranslation: { apiKey: '' },
  },
): WebTranslatorCore {
  const workerCore = createWorkerTranslatorCore<
    WebPipelineInput,
    WebWorkerPipelineConfig,
    PipelineProgress,
    WebPipelineResult
  >({
    createWorker: () => new Worker(
      new URL('./pipeline.worker.ts', import.meta.url),
      {
        type: 'module',
        name: 'shinobu-web-pipeline',
      },
    ) as unknown as WorkerClientEndpoint,
    reviveError: revivePipelineError,
    validateResult: isWebPipelineResult,
  });
  return {
    run({ input, config }) {
      return workerCore.run({
        input,
        config: {
          pipeline: config,
          capabilities,
        },
      });
    },
    dispose(reason) {
      return workerCore.dispose(reason);
    },
  };
}

export type { WebWorkerPipelineConfig };
