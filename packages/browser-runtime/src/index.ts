import {
  createTranslatorCore,
  type TranslationExecutionContext,
  type TranslationExecutor,
  type TranslationRequest,
  type TranslatorCore,
} from '@shinobu/translator-core';

export const WORKER_TRANSLATOR_PROTOCOL_VERSION = 1 as const;

export type WorkerRunMessage<Input, Config> = {
  protocolVersion: typeof WORKER_TRANSLATOR_PROTOCOL_VERSION;
  type: 'run';
  jobId: string;
  request: TranslationRequest<Input, Config>;
};

export type WorkerCancelMessage = {
  protocolVersion: typeof WORKER_TRANSLATOR_PROTOCOL_VERSION;
  type: 'cancel';
  jobId: string;
  reason?: string;
};

export type WorkerClientMessage<Input, Config> =
  | WorkerRunMessage<Input, Config>
  | WorkerCancelMessage;

export type WorkerProgressMessage<Progress> = {
  protocolVersion: typeof WORKER_TRANSLATOR_PROTOCOL_VERSION;
  type: 'progress';
  jobId: string;
  progress: Progress;
};

export type WorkerResultMessage<Result> = {
  protocolVersion: typeof WORKER_TRANSLATOR_PROTOCOL_VERSION;
  type: 'result';
  jobId: string;
  result: Result;
};

export type WorkerFailureMessage = {
  protocolVersion: typeof WORKER_TRANSLATOR_PROTOCOL_VERSION;
  type: 'failure';
  jobId: string;
  error: unknown;
};

export type WorkerHostMessage<Progress, Result> =
  | WorkerProgressMessage<Progress>
  | WorkerResultMessage<Result>
  | WorkerFailureMessage;

export type WorkerSerializedError = {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  stage?: string;
};

type MessageListener = (event: { data: unknown }) => void;
type ErrorListener = (event: { error?: unknown; message?: string }) => void;

export interface WorkerClientEndpoint {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: MessageListener): void;
  addEventListener(type: 'error', listener: ErrorListener): void;
  removeEventListener(type: 'message', listener: MessageListener): void;
  removeEventListener(type: 'error', listener: ErrorListener): void;
  terminate(): void;
}

export interface WorkerHostEndpoint {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: MessageListener): void;
  removeEventListener(type: 'message', listener: MessageListener): void;
}

export interface DisposableTranslatorCore<Input, Config, Progress, Result>
  extends TranslatorCore<Input, Config, Progress, Result> {
  dispose(reason?: unknown): void;
}

type PendingJob<Progress, Result> = {
  signal: AbortSignal;
  reportProgress: (progress: Progress) => void;
  resolve: (result: Result) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHostMessage(value: unknown): value is WorkerHostMessage<unknown, unknown> {
  if (!isRecord(value)) return false;
  return (
    value.protocolVersion === WORKER_TRANSLATOR_PROTOCOL_VERSION
    && typeof value.jobId === 'string'
    && (value.type === 'progress' || value.type === 'result' || value.type === 'failure')
  );
}

function isClientMessage(value: unknown): value is WorkerClientMessage<unknown, unknown> {
  if (!isRecord(value)) return false;
  return (
    value.protocolVersion === WORKER_TRANSLATOR_PROTOCOL_VERSION
    && typeof value.jobId === 'string'
    && (value.type === 'run' || value.type === 'cancel')
  );
}

function createJobId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `web-pipeline-${crypto.randomUUID()}`
    : `web-pipeline-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cancellationError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new DOMException(
    typeof reason === 'string' && reason ? reason : '任务已取消',
    'AbortError',
  );
}

export class WorkerTranslatorError extends Error {
  readonly code?: string;
  readonly stage?: string;

  constructor(serialized: WorkerSerializedError) {
    super(serialized.message);
    this.name = serialized.name;
    this.stack = serialized.stack ?? this.stack;
    this.code = serialized.code;
    this.stage = serialized.stage;
  }
}

export function serializeWorkerError(error: unknown): WorkerSerializedError {
  if (!isRecord(error)) {
    return {
      name: 'Error',
      message: String(error),
    };
  }
  return {
    name: typeof error.name === 'string' ? error.name : 'Error',
    message: typeof error.message === 'string' ? error.message : String(error),
    stack: typeof error.stack === 'string' ? error.stack : undefined,
    code: typeof error.code === 'string' ? error.code : undefined,
    stage: typeof error.stage === 'string' ? error.stage : undefined,
  };
}

export function reviveWorkerError(value: unknown): Error {
  if (
    isRecord(value)
    && typeof value.name === 'string'
    && typeof value.message === 'string'
  ) {
    return new WorkerTranslatorError(value as WorkerSerializedError);
  }
  return new Error('Worker 返回了无法识别的错误');
}

export function createWorkerTranslatorCore<Input, Config, Progress, Result>(options: {
  createWorker: () => WorkerClientEndpoint;
  reviveError?: (value: unknown) => unknown;
}): DisposableTranslatorCore<Input, Config, Progress, Result> {
  const pending = new Map<string, PendingJob<Progress, Result>>();
  const reviveError = options.reviveError ?? reviveWorkerError;
  let endpoint: WorkerClientEndpoint | null = null;
  let disposed = false;

  const settle = (
    jobId: string,
    finish: (job: PendingJob<Progress, Result>) => void,
  ): void => {
    const job = pending.get(jobId);
    if (!job) return;
    pending.delete(jobId);
    job.signal.removeEventListener('abort', job.onAbort);
    finish(job);
  };

  const failAll = (reason: unknown): void => {
    for (const jobId of [...pending.keys()]) {
      settle(jobId, (job) => job.reject(reason));
    }
  };

  const onMessage: MessageListener = (event) => {
    if (!isHostMessage(event.data)) return;
    const message = event.data;
    const job = pending.get(message.jobId);
    if (!job) return;
    if (message.type === 'progress') {
      job.reportProgress(message.progress as Progress);
      return;
    }
    if (message.type === 'result') {
      settle(message.jobId, (activeJob) => activeJob.resolve(message.result as Result));
      return;
    }
    settle(message.jobId, (activeJob) => activeJob.reject(reviveError(message.error)));
  };

  const onError: ErrorListener = (event) => {
    const reason = event.error ?? new Error(event.message || '翻译 Worker 异常退出');
    failAll(reason);
    endpoint?.removeEventListener('message', onMessage);
    endpoint?.removeEventListener('error', onError);
    endpoint?.terminate();
    endpoint = null;
  };

  const ensureWorker = (): WorkerClientEndpoint => {
    if (disposed) throw new Error('翻译 Worker 已释放');
    if (!endpoint) {
      endpoint = options.createWorker();
      endpoint.addEventListener('message', onMessage);
      endpoint.addEventListener('error', onError);
    }
    return endpoint;
  };

  const core = createTranslatorCore<Input, Config, Progress, Result>(
    async (request, { signal, reportProgress }) => {
      const worker = ensureWorker();
      const jobId = createJobId();
      return new Promise<Result>((resolve, reject) => {
        const onAbort = (): void => {
          try {
            worker.postMessage({
              protocolVersion: WORKER_TRANSLATOR_PROTOCOL_VERSION,
              type: 'cancel',
              jobId,
              reason: signal.reason instanceof Error
                ? signal.reason.message
                : String(signal.reason ?? ''),
            } satisfies WorkerCancelMessage);
          } finally {
            settle(jobId, (job) => job.reject(cancellationError(signal.reason)));
          }
        };

        pending.set(jobId, {
          signal,
          reportProgress,
          resolve,
          reject,
          onAbort,
        });
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }

        try {
          worker.postMessage({
            protocolVersion: WORKER_TRANSLATOR_PROTOCOL_VERSION,
            type: 'run',
            jobId,
            request,
          } satisfies WorkerRunMessage<Input, Config>);
        } catch (error) {
          settle(jobId, (job) => job.reject(error));
        }
      });
    },
  );

  return {
    run: core.run,
    dispose(reason = new Error('翻译 Worker 已释放')) {
      if (disposed) return;
      disposed = true;
      failAll(reason);
      endpoint?.removeEventListener('message', onMessage);
      endpoint?.removeEventListener('error', onError);
      endpoint?.terminate();
      endpoint = null;
    },
  };
}

export function attachWorkerTranslatorHost<Input, Config, Progress, Result>(options: {
  endpoint: WorkerHostEndpoint;
  execute: TranslationExecutor<Input, Config, Progress, Result>;
  serializeError?: (error: unknown) => unknown;
  transferResult?: (result: Result) => Transferable[];
  maxConcurrent?: number;
}): () => void {
  const {
    endpoint,
    execute,
    serializeError = serializeWorkerError,
    transferResult,
    maxConcurrent = 1,
  } = options;
  const active = new Map<string, AbortController>();

  const post = (message: WorkerHostMessage<Progress, Result>, transfer?: Transferable[]): void => {
    endpoint.postMessage(message, transfer);
  };

  const onMessage: MessageListener = (event) => {
    if (!isClientMessage(event.data)) return;
    const message = event.data;
    if (message.type === 'cancel') {
      active.get(message.jobId)?.abort(
        new DOMException(message.reason || '任务已取消', 'AbortError'),
      );
      return;
    }

    if (active.size >= maxConcurrent) {
      post({
        protocolVersion: WORKER_TRANSLATOR_PROTOCOL_VERSION,
        type: 'failure',
        jobId: message.jobId,
        error: serializeError({
          name: 'WorkerBusyError',
          code: 'WORKER_BUSY',
          message: '翻译 Worker 正在处理另一张图片',
        }),
      });
      return;
    }

    const controller = new AbortController();
    active.set(message.jobId, controller);
    const context: TranslationExecutionContext<Progress> = {
      signal: controller.signal,
      reportProgress(progress) {
        post({
          protocolVersion: WORKER_TRANSLATOR_PROTOCOL_VERSION,
          type: 'progress',
          jobId: message.jobId,
          progress,
        });
      },
    };

    void execute(
      message.request as TranslationRequest<Input, Config>,
      context,
    ).then((result) => {
      post({
        protocolVersion: WORKER_TRANSLATOR_PROTOCOL_VERSION,
        type: 'result',
        jobId: message.jobId,
        result,
      }, transferResult?.(result));
    }).catch((error: unknown) => {
      post({
        protocolVersion: WORKER_TRANSLATOR_PROTOCOL_VERSION,
        type: 'failure',
        jobId: message.jobId,
        error: serializeError(error),
      });
    }).finally(() => {
      active.delete(message.jobId);
    });
  };

  endpoint.addEventListener('message', onMessage);
  return () => {
    endpoint.removeEventListener('message', onMessage);
    for (const controller of active.values()) {
      controller.abort(new DOMException('翻译 Worker 已释放', 'AbortError'));
    }
    active.clear();
  };
}
