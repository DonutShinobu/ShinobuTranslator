import { base64ToBlob, blobToBase64 } from '@shinobu/image-pipeline/protocol';
import {
  getExtensionRuntime,
  type ExtensionPort,
} from '../../../shared/extensionRuntime';
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
} from '@shinobu/image-pipeline/protocol';
import type {
  PipelineCancellationReason,
  PipelineRecord,
} from '@shinobu/image-pipeline';
import type { PipelineConfig, PipelineProgress } from '@shinobu/image-pipeline';

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

function post(port: ExtensionPort, message: LocalPipelineClientMessage): void {
  port.postMessage(message);
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

export const runLocalPipeline: RunLocalPipeline = (file, config, onProgress, options = {}) => {
  if (options.signal?.aborted) {
    return Promise.reject(cancellationRemoteError(options.signal.reason));
  }
  const runtime = getExtensionRuntime();
  if (!runtime) {
    return Promise.reject(new LocalPipelineRemoteError({
      name: 'PipelineHostError',
      code: 'PIPELINE_HOST_UNAVAILABLE',
      message: '当前环境不支持扩展 Port 通信',
    }));
  }

  const jobId = createJobId();
  const port = runtime.connect(LOCAL_PIPELINE_CLIENT_PORT);
  return new Promise<LocalPipelineResult>((resolve, reject) => {
    let settled = false;
    let transferStarted = false;
    let resultSummary: LocalPipelineArtifactSummary | null = null;
    let resultRecord: PipelineRecord | null = null;
    let resultStatus: LocalPipelineResult['status'] | null = null;
    let resultAssembler: Base64ChunkAssembler | null = null;
    let resultContentType = 'image/png';
    let debugAssembler: Base64ChunkAssembler | null = null;
    let debugContentType = 'image/png';
    let expectsDebug = false;

    const cleanup = (): void => {
      options.signal?.removeEventListener('abort', onAbort);
      port.onMessage.removeListener?.(onMessage);
      port.onDisconnect.removeListener?.(onDisconnect);
      try {
        port.disconnect();
      } catch {
        // Already disconnected.
      }
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
      if (!resultAssembler || !resultSummary || !resultRecord || !resultStatus) {
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
        post(port, {
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
        chunks.forEach((data, index) => {
          post(port, { type: 'input-chunk', jobId, index, data });
        });
        post(port, { type: 'input-complete', jobId });
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
            operation: 'queue',
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
        name: 'PipelineHostError',
        code: 'PIPELINE_HOST_DISCONNECTED',
        message: runtime.getLastErrorMessage() || '本地流水线 Port 已断开',
      }));
    };

    const onAbort = (): void => {
      if (settled) return;
      try {
        post(port, {
          type: 'cancel',
          jobId,
          reason: userCancellationReason(options.signal?.reason),
        });
      } catch (error) {
        fail(error);
      }
    };

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }

    try {
      post(port, {
        type: 'prepare',
        jobId,
        diagnosticRunId: config.diagnosticRunId,
      });
    } catch (error) {
      fail(error);
    }
  });
};
