import {
  ImagePipelineCancelledError,
  ImagePipelineRuntime,
  createPipelineRecord,
  hasTranslatableText,
  type PipelineConfig as ImagePipelineConfig,
  type PipelineCancellationReason,
} from '@shinobu/image-pipeline';
import type { ExtensionPort } from '../shared/extensionRuntime';
import { base64ToBlob, blobToBase64, canvasToPngBlob } from '../shared/blobCodec';
import {
  RuntimePipelineHostTransport,
  type PipelineHostTransport,
} from '../shared/pipelineHostTransport';
import {
  emitDiagnosticLog,
  emitDiagnosticLogAsync,
  type DiagnosticLogEmitter,
} from '../shared/diagnosticLogClient';
import {
  Base64ChunkAssembler,
  LOCAL_PIPELINE_IDLE_TIMEOUT_MS,
  LOCAL_PIPELINE_HOST_PORT,
  createCancelledError,
  createProtocolError,
  isLocalPipelineClientMessage,
  serializePipelineError,
  splitBase64Chunks,
  summarizePipelineArtifacts,
  type LocalPipelineArtifactMeta,
  type LocalPipelineClientMessage,
  type LocalPipelineFileMeta,
  type LocalPipelineHostMessage,
} from '../shared/localPipelineProtocol';
import { setPerfTraceSink, type PerfTraceRuntimeEvent, type PerfTraceWorkerCall } from '../shared/perfTrace';
import type {
  PipelineArtifacts,
  PipelineConfig as LegacyPipelineConfig,
} from '../types';
import { PipelineStageError, runPipeline } from '../pipeline/orchestrator';
import { disposePipelineArtifacts } from '../pipeline/resources';
import { disposeAllModelSessions } from '../runtime/modelRegistry';
import {
  extensionTextTranslationTransport,
  type TextTranslationTransport,
} from '../translators/transport';

type RuntimeAggregate = {
  model: string;
  provider?: string;
  calls: number;
  totalDurationMs: number;
  maxDurationMs: number;
  inputBytes: number;
  outputBytes: number;
  failures: number;
};

export type PipelineHostDependencies = {
  translationTransport?: TextTranslationTransport;
  diagnostics?: DiagnosticLogEmitter;
};

const extensionPipelineHostDiagnostics: DiagnosticLogEmitter = {
  emit: emitDiagnosticLog,
  emitAsync: emitDiagnosticLogAsync,
};

type PipelineJob = {
  id: string;
  diagnosticRunId?: string;
  fileMeta?: LocalPipelineFileMeta;
  config?: LegacyPipelineConfig;
  input?: Base64ChunkAssembler;
  file?: File;
  abortController: AbortController;
  cancellationReason?: PipelineCancellationReason;
  state: 'prepared' | 'receiving' | 'queued' | 'active' | 'finished';
};

function safelyPost(port: ExtensionPort | null, message: LocalPipelineHostMessage): boolean {
  if (!port) return false;
  try {
    port.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

function toArtifactMeta(contentType: string, chunks: string[], totalChars: number): LocalPipelineArtifactMeta {
  return {
    contentType,
    chunkCount: chunks.length,
    totalChars,
  };
}

function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException && error.name === 'AbortError')
    || Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'TASK_CANCELLED');
}

function toImagePipelineConfig(config: LegacyPipelineConfig): ImagePipelineConfig {
  const { llmApiKey: _runtimeCredential, ...pipeline } = config;
  return pipeline as ImagePipelineConfig;
}

function getMessageJobId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const jobId = (value as { jobId?: unknown }).jobId;
  return typeof jobId === 'string' && jobId.length > 0 ? jobId : null;
}

export class PipelineHost {
  private port: ExtensionPort | null = null;
  private readonly jobs = new Map<string, PipelineJob>();
  private readonly queue: PipelineJob[] = [];
  private activeJob: PipelineJob | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleReleasePromise: Promise<void> | null = null;
  private idleGeneration = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private activeApiKey = '';
  private readonly imageRuntime: ImagePipelineRuntime<PipelineArtifacts>;
  private readonly translationTransport: TextTranslationTransport;
  private readonly diagnostics: DiagnosticLogEmitter;

  constructor(
    private readonly transport: PipelineHostTransport = new RuntimePipelineHostTransport(),
    dependencies: PipelineHostDependencies = {},
  ) {
    this.translationTransport = dependencies.translationTransport
      ?? extensionTextTranslationTransport;
    this.diagnostics = dependencies.diagnostics
      ?? extensionPipelineHostDiagnostics;
    this.imageRuntime = new ImagePipelineRuntime<PipelineArtifacts>({
      execute: async (request, context) => {
        const source = request.source instanceof File
          ? request.source
          : new File([request.source], 'source-image', {
              type: request.source.type,
            });
        const translationTransport = this.translationTransport;
        const retryingTranslationTransport: TextTranslationTransport = {
          requestChatCompletion(translationRequest) {
            return context.runOperation(
              {
                stage: 'translate',
                operation: 'request-chat-completion',
              },
              () => translationTransport.requestChatCompletion(
                translationRequest,
              ),
            );
          },
          translatePlain(translationRequest) {
            return context.runOperation(
              {
                stage: 'translate',
                operation: 'translate-plain',
              },
              () => translationTransport.translatePlain(
                translationRequest,
              ),
            );
          },
        };
        const artifacts = await runPipeline(
          source,
          {
            ...request.config,
            llmApiKey: this.activeApiKey,
          } as LegacyPipelineConfig,
          (progress) => context.reportProgress({
            stage: progress.stage,
            operation: progress.stage,
            detail: progress.detail,
          }),
          {
            signal: context.signal,
            translationTransport: retryingTranslationTransport,
          },
        );
        return {
          status: hasTranslatableText({ ordered: artifacts.stageRegions.ordered })
            ? 'completed' as const
            : 'no-translatable-text' as const,
          artifacts,
        };
      },
      async finalize(output, request) {
        const finalizeStartedAt = performance.now();
        const image = await canvasToPngBlob(output.artifacts.resultCanvas);
        const debug = request.config.typesetDebug
          && output.artifacts.debugOriginalCanvas
          ? await canvasToPngBlob(output.artifacts.debugOriginalCanvas)
          : undefined;
        output.artifacts.stageTimings.push({
          stage: 'finalize',
          label: '生成结果图片',
          durationMs: performance.now() - finalizeStartedAt,
        });
        return {
          status: output.status,
          image,
          debug,
          record: createPipelineRecord({
            image: {
              width: output.artifacts.original.naturalWidth,
              height: output.artifacts.original.naturalHeight,
            },
            ocr: output.artifacts.stageRegions.ocr,
            ordered: output.artifacts.stageRegions.ordered,
          }, request.workingCopy),
          diagnostics: {
            summary: summarizePipelineArtifacts(output.artifacts),
          },
        };
      },
      release(output) {
        disposePipelineArtifacts(output.artifacts);
      },
      releaseFailure(error) {
        if (error instanceof PipelineStageError) {
          disposePipelineArtifacts(error.artifacts);
        }
      },
      dispose: async () => {
        await disposeAllModelSessions();
      },
    });
  }

  connect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const port = this.transport.connect(LOCAL_PIPELINE_HOST_PORT);
    this.port = port;
    port.onMessage.addListener((message) => {
      void this.handleMessage(message);
    });
    port.onDisconnect.addListener(() => {
      this.handleDisconnect(port);
    });
    safelyPost(port, { type: 'host-ready' });
    this.scheduleIdleClose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdleClose();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const cancellation = createCancelledError('流水线宿主已关闭');
    if (this.activeJob) {
      this.activeJob.cancellationReason = {
        code: 'runtime-disposed',
        messageKey: 'pipeline.cancelled.runtimeDisposed',
        diagnosticSummary: cancellation.message,
      };
    }
    this.activeJob?.abortController.abort(cancellation);
    for (const job of this.jobs.values()) {
      if (job !== this.activeJob) job.abortController.abort(cancellation);
    }
    this.queue.length = 0;
    this.jobs.clear();
    void this.imageRuntime.dispose({
      code: 'runtime-disposed',
      messageKey: 'pipeline.cancelled.runtimeDisposed',
      diagnosticSummary: cancellation.message,
    });
    const port = this.port;
    this.port = null;
    port?.disconnect();
  }

  private async handleMessage(value: unknown): Promise<void> {
    if (!isLocalPipelineClientMessage(value)) {
      const jobId = getMessageJobId(value);
      if (jobId) this.failJobId(jobId, createProtocolError('流水线宿主收到无效消息'));
      return;
    }
    this.clearIdleClose();
    try {
      switch (value.type) {
        case 'prepare':
          this.prepare(value);
          break;
        case 'start':
          this.startTransfer(value);
          break;
        case 'input-chunk':
          this.receiveChunk(value);
          break;
        case 'input-complete':
          this.completeTransfer(value);
          break;
        case 'cancel':
          this.cancel(value.jobId, value.reason);
          break;
      }
    } catch (error) {
      this.failJobId(value.jobId, error);
    }
  }

  private prepare(message: Extract<LocalPipelineClientMessage, { type: 'prepare' }>): void {
    if (this.jobs.has(message.jobId)) {
      throw createProtocolError(`任务 ID 已存在: ${message.jobId}`);
    }
    if (this.jobs.size > 0 || this.activeJob) {
      const error = new Error('流水线宿主正在处理另一张图片') as Error & {
        code: 'RUNTIME_BUSY';
      };
      error.name = 'ImagePipelineAdmissionError';
      error.code = 'RUNTIME_BUSY';
      throw error;
    }
    this.jobs.set(message.jobId, {
      id: message.jobId,
      diagnosticRunId: message.diagnosticRunId,
      abortController: new AbortController(),
      state: 'prepared',
    });
    safelyPost(this.port, { type: 'ready', jobId: message.jobId });
  }

  private startTransfer(message: Extract<LocalPipelineClientMessage, { type: 'start' }>): void {
    const job = this.requireJob(message.jobId, 'prepared');
    job.fileMeta = message.file;
    job.config = message.config;
    job.input = new Base64ChunkAssembler(message.input);
    job.state = 'receiving';
  }

  private receiveChunk(message: Extract<LocalPipelineClientMessage, { type: 'input-chunk' }>): void {
    const job = this.requireJob(message.jobId, 'receiving');
    job.input?.add(message.index, message.data);
  }

  private completeTransfer(message: Extract<LocalPipelineClientMessage, { type: 'input-complete' }>): void {
    const job = this.requireJob(message.jobId, 'receiving');
    if (!job.input || !job.fileMeta || !job.config) {
      throw createProtocolError('输入传输尚未初始化');
    }
    const base64 = job.input.complete();
    const blob = base64ToBlob(base64, job.fileMeta.type);
    if (blob.size !== job.fileMeta.size) {
      throw createProtocolError(`输入图片大小不符: 期望 ${job.fileMeta.size}, 实际 ${blob.size}`);
    }
    job.file = new File([blob], job.fileMeta.name, {
      type: job.fileMeta.type,
      lastModified: job.fileMeta.lastModified,
    });
    job.state = 'queued';
    this.queue.push(job);
    this.postQueuePositions();
    void this.pump();
  }

  private cancel(
    jobId: string,
    reason?: PipelineCancellationReason | string,
  ): void {
    const job = this.jobs.get(jobId);
    if (!job || job.state === 'finished') return;
    const cancellationReason: PipelineCancellationReason = (
      reason
      && typeof reason === 'object'
    ) ? reason : {
      code: typeof reason === 'string' ? 'user-requested' : 'unknown',
      messageKey: typeof reason === 'string'
        ? 'pipeline.cancelled.userRequested'
        : 'pipeline.cancelled.unknown',
      diagnosticSummary: reason || '本地流水线任务已取消',
    };
    const cancellation = new ImagePipelineCancelledError(cancellationReason);
    if (job === this.activeJob) {
      job.cancellationReason = cancellationReason;
      job.abortController.abort(cancellation);
      return;
    }
    const queueIndex = this.queue.indexOf(job);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    this.failJob(job, cancellation);
    this.postQueuePositions();
    this.scheduleIdleClose();
  }

  private requireJob(jobId: string, state: PipelineJob['state']): PipelineJob {
    const job = this.jobs.get(jobId);
    if (!job) throw createProtocolError(`未知任务: ${jobId}`);
    if (job.state !== state) {
      throw createProtocolError(`任务 ${jobId} 状态错误: 期望 ${state}, 实际 ${job.state}`);
    }
    return job;
  }

  private async pump(): Promise<void> {
    if (this.activeJob) return;
    if (this.idleReleasePromise) {
      await this.idleReleasePromise.catch(() => undefined);
      if (this.activeJob) return;
    }
    const job = this.queue.shift();
    if (!job) {
      this.scheduleIdleClose();
      return;
    }
    this.activeJob = job;
    job.state = 'active';
    this.postQueuePositions();
    await this.execute(job);
    this.activeJob = null;
    this.postQueuePositions();
    void this.pump();
  }

  private async execute(job: PipelineJob): Promise<void> {
    if (!job.file || !job.config) {
      this.failJob(job, createProtocolError('任务缺少图片或流水线配置'));
      return;
    }

    const aggregates = new Map<string, RuntimeAggregate>();
    const removePerfSink = setPerfTraceSink({
      recordWorkerCall: (call) => this.aggregateWorkerCall(aggregates, call),
      recordRuntimeEvent: (event) => this.recordRuntimeEvent(job, event),
    });
    const startedAt = performance.now();
    await this.diagnostics.emitAsync({
      runId: job.diagnosticRunId,
      level: 'info',
      category: 'pipeline.stage',
      source: { context: 'pipeline-host', module: 'pipelineHost.ts' },
      message: '本地流水线宿主开始执行',
      data: {
        jobId: job.id,
        queueDepth: this.queue.length,
        file: {
          name: job.file.name,
          type: job.file.type,
          size: job.file.size,
        },
      },
    });

    let stopProgress = (): void => undefined;
    let stopCancellation = (): void => undefined;
    try {
      this.activeApiKey = job.config.llmApiKey;
      const task = this.imageRuntime.run({
        source: job.file,
        config: toImagePipelineConfig(job.config),
        workingCopy: { strategy: 'source-native' },
      });
      stopProgress = task.progress((progress) => {
        safelyPost(this.port, {
          type: 'progress',
          jobId: job.id,
          progress: {
            ...progress,
            detail: progress.detail ?? progress.operation,
          },
        });
      });
      const cancel = (): void => task.cancel(
        job.cancellationReason ?? {
          code: 'unknown',
          messageKey: 'pipeline.cancelled.unknown',
          diagnosticSummary: job.abortController.signal.reason instanceof Error
            ? job.abortController.signal.reason.message
            : String(job.abortController.signal.reason ?? ''),
        },
      );
      job.abortController.signal.addEventListener('abort', cancel, { once: true });
      stopCancellation = () => {
        job.abortController.signal.removeEventListener('abort', cancel);
      };
      if (job.abortController.signal.aborted) cancel();

      const throwIfJobCancelled = (): void => {
        if (!job.abortController.signal.aborted) return;
        throw new ImagePipelineCancelledError(
          job.cancellationReason ?? {
            code: 'unknown',
            messageKey: 'pipeline.cancelled.unknown',
            diagnosticSummary: job.abortController.signal.reason instanceof Error
              ? job.abortController.signal.reason.message
              : String(job.abortController.signal.reason ?? ''),
          },
        );
      };
      const pipelineResult = await task.result;
      throwIfJobCancelled();
      const summary = pipelineResult.diagnostics?.summary as ReturnType<
        typeof summarizePipelineArtifacts
      >;
      const resultBlob = pipelineResult.image;
      const debugBlob = pipelineResult.debug;
      const resultBase64 = await blobToBase64(resultBlob);
      throwIfJobCancelled();
      const resultChunks = splitBase64Chunks(resultBase64);
      const debugBase64 = debugBlob ? await blobToBase64(debugBlob) : undefined;
      throwIfJobCancelled();
      const debugChunks = debugBase64 === undefined ? undefined : splitBase64Chunks(debugBase64);

      const deliveryPort = this.port;
      let delivered = safelyPost(deliveryPort, {
        type: 'result-meta',
        jobId: job.id,
        status: pipelineResult.status,
        result: toArtifactMeta(resultBlob.type || 'image/png', resultChunks, resultBase64.length),
        debug: debugBlob && debugBase64 !== undefined && debugChunks
          ? toArtifactMeta(debugBlob.type || 'image/png', debugChunks, debugBase64.length)
          : undefined,
        summary,
        record: pipelineResult.record,
      });
      throwIfJobCancelled();
      delivered = delivered && this.postArtifactChunks(job.id, 'result', resultChunks);
      throwIfJobCancelled();
      delivered = delivered
        && (!debugChunks || this.postArtifactChunks(job.id, 'debug', debugChunks));
      throwIfJobCancelled();
      delivered = delivered
        && safelyPost(deliveryPort, { type: 'complete', jobId: job.id });
      if (!delivered) {
        if (deliveryPort) this.handleDisconnect(deliveryPort);
        throw createProtocolError('流水线宿主结果传输失败');
      }
      job.state = 'finished';
      this.jobs.delete(job.id);

      await this.diagnostics.emitAsync({
        runId: job.diagnosticRunId,
        level: 'info',
        category: 'pipeline.stage',
        source: { context: 'pipeline-host', module: 'pipelineHost.ts' },
        message: '本地流水线宿主执行完成',
        data: {
          jobId: job.id,
          durationMs: performance.now() - startedAt,
          resultBytes: resultBlob.size,
          debugBytes: debugBlob?.size,
          runtimeInference: [...aggregates.values()],
        },
      });
    } catch (error) {
      const finalError = job.abortController.signal.aborted && !isAbortError(error)
        ? job.abortController.signal.reason ?? createCancelledError()
        : error;
      this.failJob(job, finalError);
      await this.diagnostics.emitAsync({
        runId: job.diagnosticRunId,
        level: 'error',
        category: 'error',
        source: { context: 'pipeline-host', module: 'pipelineHost.ts' },
        message: `本地流水线宿主失败：${finalError instanceof Error ? finalError.message : String(finalError)}`,
        data: {
          jobId: job.id,
          durationMs: performance.now() - startedAt,
          runtimeInference: [...aggregates.values()],
        },
        error: serializePipelineError(finalError, isAbortError(finalError) ? 'TASK_CANCELLED' : 'PIPELINE_STAGE_FAILED'),
      });
    } finally {
      stopCancellation();
      stopProgress();
      await this.imageRuntime.whenIdle();
      this.activeApiKey = '';
      removePerfSink();
    }
  }

  private aggregateWorkerCall(aggregates: Map<string, RuntimeAggregate>, call: PerfTraceWorkerCall): void {
    if (call.kind !== 'runInference' && call.kind !== 'runDetectWithGpuPreprocess') return;
    const model = call.model ?? 'unknown';
    const current = aggregates.get(model) ?? {
      model,
      provider: call.provider,
      calls: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
      inputBytes: 0,
      outputBytes: 0,
      failures: 0,
    };
    current.provider = call.provider ?? current.provider;
    current.calls += 1;
    current.totalDurationMs += call.durationMs;
    current.maxDurationMs = Math.max(current.maxDurationMs, call.durationMs);
    current.inputBytes += call.inputBytes ?? 0;
    current.outputBytes += call.outputBytes ?? 0;
    if (call.error) current.failures += 1;
    aggregates.set(model, current);
  }

  private recordRuntimeEvent(job: PipelineJob, event: PerfTraceRuntimeEvent): void {
    this.diagnostics.emit({
      runId: job.diagnosticRunId,
      level: event.error === undefined ? 'info' : 'error',
      category: 'model.runtime',
      source: { context: 'pipeline-host', module: 'onnxWorkerBridge.ts' },
      message: event.message,
      data: {
        kind: event.kind,
        model: event.model,
        provider: event.provider,
        ...event.data,
      },
      error: event.error === undefined ? undefined : serializePipelineError(event.error, 'WORKER_BOOTSTRAP_FAILED'),
    });
  }

  private postArtifactChunks(jobId: string, artifact: 'result' | 'debug', chunks: string[]): boolean {
    return chunks.every((data, index) =>
      safelyPost(this.port, {
        type: 'result-chunk',
        jobId,
        artifact,
        index,
        data,
      }));
  }

  private postQueuePositions(): void {
    if (this.activeJob) {
      safelyPost(this.port, { type: 'queued', jobId: this.activeJob.id, position: 0 });
    }
    this.queue.forEach((job, index) => {
      safelyPost(this.port, {
        type: 'queued',
        jobId: job.id,
        position: index + (this.activeJob ? 1 : 0),
      });
    });
  }

  private failJobId(jobId: string, error: unknown): void {
    const job = this.jobs.get(jobId);
    if (job) {
      this.failJob(job, error);
      return;
    }
    safelyPost(this.port, {
      type: 'error',
      jobId,
      error: serializePipelineError(error, 'TRANSFER_PROTOCOL_ERROR'),
    });
  }

  private failJob(job: PipelineJob, error: unknown): void {
    job.state = 'finished';
    this.jobs.delete(job.id);
    const queueIndex = this.queue.indexOf(job);
    if (queueIndex >= 0) this.queue.splice(queueIndex, 1);
    const port = this.port;
    if (!safelyPost(port, {
      type: 'error',
      jobId: job.id,
      error: serializePipelineError(error, isAbortError(error) ? 'TASK_CANCELLED' : 'PIPELINE_STAGE_FAILED'),
    }) && port) {
      this.handleDisconnect(port);
    }
  }

  private handleDisconnect(port: ExtensionPort): void {
    if (this.port !== port) return;
    this.port = null;
    if (this.activeJob) {
      const cancellation = createCancelledError('流水线宿主连接已断开');
      this.activeJob.cancellationReason = {
        code: 'transport-disconnected',
        messageKey: 'pipeline.cancelled.transportDisconnected',
        diagnosticSummary: cancellation.message,
      };
      this.activeJob.abortController.abort(cancellation);
    }
    for (const job of [...this.queue]) {
      job.abortController.abort(createCancelledError('流水线宿主连接已断开'));
      job.state = 'finished';
      this.jobs.delete(job.id);
    }
    this.queue.length = 0;
    for (const job of this.jobs.values()) {
      if (job !== this.activeJob) {
        job.state = 'finished';
      }
    }
    for (const [jobId, job] of this.jobs) {
      if (job !== this.activeJob) this.jobs.delete(jobId);
    }
    if (!this.disposed && this.transport.reconnectOnDisconnect) {
      this.reconnectTimer = setTimeout(() => this.connect(), 250);
    }
  }

  private clearIdleClose(): void {
    this.idleGeneration += 1;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private scheduleIdleClose(): void {
    this.clearIdleClose();
    if (this.disposed || this.activeJob || this.queue.length > 0 || this.jobs.size > 0) return;
    const generation = this.idleGeneration;
    this.idleTimer = setTimeout(() => {
      void this.releaseIdleResources(generation);
    }, LOCAL_PIPELINE_IDLE_TIMEOUT_MS);
  }

  private async releaseIdleResources(generation: number): Promise<void> {
    if (generation !== this.idleGeneration || this.activeJob || this.jobs.size > 0) return;
    const releasePromise = disposeAllModelSessions();
    this.idleReleasePromise = releasePromise;
    try {
      await releasePromise;
      await this.diagnostics.emitAsync({
        level: 'info',
        category: 'model.runtime',
        source: { context: 'pipeline-host', module: 'pipelineHost.ts' },
        message: '流水线宿主空闲 5 分钟，已释放模型 Session 与 Worker',
      });
    } catch (error) {
      this.diagnostics.emit({
        level: 'warn',
        category: 'model.runtime',
        source: { context: 'pipeline-host', module: 'pipelineHost.ts' },
        message: '流水线宿主空闲资源释放失败',
        error: serializePipelineError(error),
      });
    } finally {
      if (this.idleReleasePromise === releasePromise) {
        this.idleReleasePromise = null;
      }
    }
    if (generation === this.idleGeneration && !this.activeJob && this.jobs.size === 0) {
      safelyPost(this.port, { type: 'idle-close' });
    }
  }
}
