import { base64ToBlob, blobToBase64 } from '../../../shared/blobCodec';
import type {
  RuntimeChannel,
  RuntimeChannelClient,
} from '../../../../apps/extension/src/capabilities/contracts';
import {
  Base64ChunkAssembler,
  LOCAL_PIPELINE_CLIENT_PORT,
  LocalPipelineRemoteError,
  createProtocolError,
  isLocalPipelineHostMessage,
  serializePipelineError,
  splitBase64Chunks,
  type LocalPipelineArtifactSummary,
  type LocalPipelineClientMessage,
  type LocalPipelineResult,
} from '../../../shared/localPipelineProtocol';
import type {
  PipelineCancellationReason,
  PipelineRecord,
  ProviderExecutionReport,
} from '@shinobu/image-pipeline';
import type { PipelineConfig, PipelineProgress } from '../../../types';
import { normalizeJsonValue } from '../../../shared/jsonValue';

export type RunLocalPipeline = (
  file: File,
  config: PipelineConfig,
  onProgress: (progress: PipelineProgress) => void,
  options?: { signal?: AbortSignal },
) => Promise<LocalPipelineResult>;

function createJobId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `pipeline-${crypto.randomUUID()}`
    : `pipeline-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function post(
  channel: RuntimeChannel,
  message: LocalPipelineClientMessage,
): Promise<void> {
  return channel.send(normalizeJsonValue(message));
}

function userCancellationReason(reason: unknown): PipelineCancellationReason {
  return {
    code: 'user-requested',
    messageKey: 'pipeline.cancelled.userRequested',
    diagnosticSummary: reason instanceof Error
      ? reason.message
      : typeof reason === 'string' && reason
        ? reason
        : '内容页请求取消任务',
  };
}

function cancellationRemoteError(reason: unknown): LocalPipelineRemoteError {
  const cancellation = userCancellationReason(reason);
  return new LocalPipelineRemoteError({
    name: 'ImagePipelineCancelledError',
    code: 'TASK_CANCELLED',
    message: cancellation.messageKey,
    messageKey: cancellation.messageKey,
  });
}

export function createRunLocalPipeline(
  channels: RuntimeChannelClient,
): RunLocalPipeline {
  return async (file, config, onProgress, options = {}) => {
    if (options.signal?.aborted) {
      throw cancellationRemoteError(options.signal.reason);
    }
    let channel: RuntimeChannel;
    try {
      channel = await channels.open(LOCAL_PIPELINE_CLIENT_PORT);
    } catch (error) {
      throw new LocalPipelineRemoteError({
        name: 'OffscreenPipelineError',
        code: 'OFFSCREEN_UNAVAILABLE',
        message: error instanceof Error
          ? error.message
          : '当前环境不支持扩展 channel 通信',
      });
    }

    const jobId = createJobId();
    return await new Promise<LocalPipelineResult>((resolve, reject) => {
    let settled = false;
    let transferStarted = false;
    let resultSummary: LocalPipelineArtifactSummary | null = null;
    let resultRecord: PipelineRecord | null = null;
    let resultProviderReports: readonly ProviderExecutionReport[] | null = null;
    let resultStatus: LocalPipelineResult['status'] | null = null;
    let resultAssembler: Base64ChunkAssembler | null = null;
    let resultContentType = 'image/png';
    let debugAssembler: Base64ChunkAssembler | null = null;
    let debugContentType = 'image/png';
    let expectsDebug = false;
    let cancelMessage: () => void = () => undefined;
    let cancelDisconnect: () => void = () => undefined;

    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', onAbort);
      cancelMessage();
      cancelDisconnect();
      void channel.disconnect().catch(() => undefined);
    };

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error instanceof Error) {
        reject(error);
      } else {
        reject(new LocalPipelineRemoteError(serializePipelineError(error, 'TRANSFER_PROTOCOL_ERROR')));
      }
    };

    const finish = (): void => {
      if (options.signal?.aborted) {
        fail(cancellationRemoteError(options.signal.reason));
        return;
      }
      if (
        !resultAssembler
        || !resultSummary
        || !resultRecord
        || !resultProviderReports
        || !resultStatus
      ) {
        fail(createProtocolError('结果完成消息早于结果元数据'));
        return;
      }
      try {
        const resultBase64 = resultAssembler.complete();
        const debugBase64 = expectsDebug ? debugAssembler?.complete() : undefined;
        if (expectsDebug && debugBase64 === undefined) {
          throw createProtocolError('调试图片分块缺失');
        }
        const value: LocalPipelineResult = {
          status: resultStatus,
          result: base64ToBlob(resultBase64, resultContentType),
          debug: debugBase64 === undefined ? undefined : base64ToBlob(debugBase64, debugContentType),
          summary: resultSummary,
          record: resultRecord,
          providerReports: resultProviderReports,
        };
        if (options.signal?.aborted) {
          fail(cancellationRemoteError(options.signal.reason));
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      } catch (error) {
        fail(error);
      }
    };

    const sendInput = async (): Promise<void> => {
      if (transferStarted || settled) return;
      transferStarted = true;
      try {
        const base64 = await blobToBase64(file);
        const chunks = splitBase64Chunks(base64);
        await post(channel, {
          type: 'start',
          jobId,
          file: {
            name: file.name,
            type: file.type || 'image/png',
            size: file.size,
            lastModified: file.lastModified,
          },
          config,
          input: {
            chunkCount: chunks.length,
            totalChars: base64.length,
          },
        });
        for (const [index, data] of chunks.entries()) {
          await post(channel, { type: 'input-chunk', jobId, index, data });
        }
        await post(channel, { type: 'input-complete', jobId });
      } catch (error) {
        fail(error);
      }
    };

    const onMessage = (value: unknown): void => {
      if (settled) return;
      if (!isLocalPipelineHostMessage(value) || ('jobId' in value && value.jobId !== jobId)) {
        fail(createProtocolError('后台返回了无效的本地流水线消息'));
        return;
      }
      if (value.type === 'host-ready' || value.type === 'idle-close') return;
      switch (value.type) {
        case 'ready':
          void sendInput();
          break;
        case 'queued':
          onProgress({
            stage: 'queued',
            detail: value.position === 0 ? '本地流水线任务开始执行' : `本地流水线排队中（前方 ${value.position} 个任务）`,
          });
          break;
        case 'progress':
          onProgress(value.progress);
          break;
        case 'result-meta':
          if (resultAssembler) {
            fail(createProtocolError('收到重复结果元数据'));
            return;
          }
          resultAssembler = new Base64ChunkAssembler(value.result);
          resultContentType = value.result.contentType;
          resultSummary = value.summary;
          resultRecord = value.record;
          resultProviderReports = value.providerReports;
          resultStatus = value.status;
          expectsDebug = Boolean(value.debug);
          if (value.debug) {
            debugAssembler = new Base64ChunkAssembler(value.debug);
            debugContentType = value.debug.contentType;
          }
          break;
        case 'result-chunk':
          try {
            const assembler = value.artifact === 'result' ? resultAssembler : debugAssembler;
            if (!assembler) throw createProtocolError(`${value.artifact} 结果分块早于元数据`);
            assembler.add(value.index, value.data);
          } catch (error) {
            fail(error);
          }
          break;
        case 'complete':
          finish();
          break;
        case 'error':
          fail(new LocalPipelineRemoteError(value.error));
          break;
      }
    };

    const onDisconnect = (): void => {
      if (settled) return;
      fail(new LocalPipelineRemoteError({
        name: 'OffscreenPipelineError',
        code: 'OFFSCREEN_DISCONNECTED',
        message: '本地流水线 channel 已断开',
      }));
    };

    const onAbort = (): void => {
      if (settled) return;
      try {
        void post(channel, {
          type: 'cancel',
          jobId,
          reason: userCancellationReason(options.signal?.reason),
        }).catch(fail);
      } catch (error) {
        fail(error);
      }
    };

    cancelMessage = channel.onMessage(onMessage);
    cancelDisconnect = channel.onDisconnect(onDisconnect);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }

    try {
      void post(channel, {
        type: 'prepare',
        jobId,
        diagnosticRunId: config.diagnosticRunId,
      }).catch(fail);
    } catch (error) {
      fail(error);
    }
    });
  };
}
