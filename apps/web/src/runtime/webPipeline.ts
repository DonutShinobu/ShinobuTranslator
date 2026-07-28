import {
  createWorkerTranslatorCore,
  type DisposableTranslatorCore,
  type WorkerClientEndpoint,
} from '@shinobu/browser-runtime';
import type { LocalPipelineArtifactSummary } from '../../../../src/shared/localPipelineProtocol';
import { LocalPipelineRemoteError } from '../../../../src/shared/localPipelineProtocol';
import type {
  PipelineConfig,
  PipelineProgress,
} from '../../../../src/types';
import type { WebPipelineRecord } from '../domain/pipelineRecord';

export type WebPipelineInput = {
  file: File;
  workingCopy: {
    width: number;
    height: number;
  };
};

export type WebPipelineResult = {
  image: Blob;
  debug?: Blob;
  summary: LocalPipelineArtifactSummary;
  record: WebPipelineRecord;
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

export function createWebTranslatorCore(): WebTranslatorCore {
  return createWorkerTranslatorCore({
    createWorker: () => new Worker(
      new URL('./pipeline.worker.ts', import.meta.url),
      {
        type: 'module',
        name: 'shinobu-web-pipeline',
      },
    ) as unknown as WorkerClientEndpoint,
    reviveError: revivePipelineError,
  });
}
