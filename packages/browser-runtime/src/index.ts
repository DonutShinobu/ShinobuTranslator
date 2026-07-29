import {
  createTranslatorCore,
  TranslationCancelledError,
  type TranslationCancellationReason,
  type TranslationExecutionContext,
  type TranslationExecutor,
  type TranslationFailure,
  type TranslationRequest,
  type TranslatorCore,
} from '@shinobu/translator-core';

export type DirectChatCompletionRequesterOptions = {
  fetchImpl?: typeof fetch;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  maxRetries?: number;
};

export type DirectChatCompletionRequest = {
  endpoint: string;
  apiKey: string;
  body: unknown;
  signal?: AbortSignal;
};

export class DirectChatCompletionError extends Error {
  constructor(
    message: string,
    readonly metadata: {
      status?: number;
      responseText?: string;
      retryAfterMs?: number;
      retryable?: boolean;
      detail?: string;
    } = {},
  ) {
    super(message);
    this.name = 'DirectChatCompletionError';
  }

  get status(): number | undefined {
    return this.metadata.status;
  }

  get responseText(): string | undefined {
    return this.metadata.responseText;
  }

  get retryAfterMs(): number | undefined {
    return this.metadata.retryAfterMs;
  }

  get retryable(): boolean | undefined {
    return this.metadata.retryable;
  }

  get detail(): string | undefined {
    return this.metadata.detail;
  }
}

const DIRECT_CHAT_DEFAULT_MAX_RETRIES = 2;
const DIRECT_CHAT_MAX_RETRY_DELAY_MS = 10_000;

function directChatSleep(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason ?? new DOMException('请求已取消', 'AbortError'),
    );
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('请求已取消', 'AbortError'));
    };
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function directChatRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function directChatRetryDelay(response: Response, retryIndex: number): number {
  const retryAfter = response.headers.get('retry-after')?.trim();
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(DIRECT_CHAT_MAX_RETRY_DELAY_MS, seconds * 1_000);
    }
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) {
      return Math.min(
        DIRECT_CHAT_MAX_RETRY_DELAY_MS,
        Math.max(0, at - Date.now()),
      );
    }
  }
  return Math.min(
    DIRECT_CHAT_MAX_RETRY_DELAY_MS,
    500 * 2 ** retryIndex,
  );
}

function directChatErrorDetail(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (isRecord(value.error) && typeof value.error.message === 'string') {
    return value.error.message;
  }
  for (const key of ['message', 'detail', 'error_description', 'error']) {
    if (typeof value[key] === 'string') return value[key];
  }
  return null;
}

export function createDirectChatCompletionRequester(
  options: DirectChatCompletionRequesterOptions = {},
): {
  request(request: DirectChatCompletionRequest): Promise<unknown>;
} {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? directChatSleep;
  const maxRetries = Math.max(
    0,
    Math.floor(options.maxRetries ?? DIRECT_CHAT_DEFAULT_MAX_RETRIES),
  );
  return {
    async request(request) {
      let response: Response | null = null;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
          response = await fetchImpl(request.endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${request.apiKey}`,
            },
            body: JSON.stringify(request.body),
            cache: 'no-store',
            signal: request.signal,
          });
        } catch (error) {
          if (request.signal?.aborted) throw error;
          throw new DirectChatCompletionError(
            'LLM 翻译网络请求失败',
            { retryable: error instanceof TypeError },
          );
        }
        if (
          !directChatRetryableStatus(response.status)
          || attempt === maxRetries
        ) {
          break;
        }
        const delayMs = directChatRetryDelay(response, attempt);
        await response.body?.cancel().catch(() => undefined);
        await sleep(delayMs, request.signal);
      }
      if (!response) {
        throw new DirectChatCompletionError('LLM 请求未能启动');
      }
      let responseText: string;
      try {
        responseText = await response.text();
      } catch (error) {
        if (request.signal?.aborted) throw error;
        throw new DirectChatCompletionError(
          'LLM 翻译响应读取失败',
          {
            status: response.status,
            retryable: error instanceof TypeError,
          },
        );
      }
      let parsed: unknown;
      try {
        parsed = responseText ? JSON.parse(responseText) as unknown : null;
      } catch {
        parsed = null;
      }
      if (!response.ok) {
        const detail = directChatErrorDetail(parsed)
          ?? (responseText || null);
        throw new DirectChatCompletionError(
          `LLM 翻译请求失败: ${detail ?? `HTTP ${response.status}`}`,
          {
            status: response.status,
            responseText,
            retryAfterMs: directChatRetryableStatus(response.status)
              ? directChatRetryDelay(response, 0)
              : undefined,
            detail: detail ?? undefined,
          },
        );
      }
      if (!isRecord(parsed)) {
        throw new DirectChatCompletionError('LLM 响应解析失败', {
          status: response.status,
          responseText,
        });
      }
      return parsed;
    },
  };
}

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
  reason?: TranslationCancellationReason;
};

export type WorkerDisposeMessage = {
  protocolVersion: typeof WORKER_TRANSLATOR_PROTOCOL_VERSION;
  type: 'dispose';
  requestId: string;
  reason?: TranslationCancellationReason;
};

export type WorkerClientMessage<Input, Config> =
  | WorkerRunMessage<Input, Config>
  | WorkerCancelMessage
  | WorkerDisposeMessage;

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

export type WorkerDisposedMessage = {
  protocolVersion: typeof WORKER_TRANSLATOR_PROTOCOL_VERSION;
  type: 'disposed';
  requestId: string;
  error?: unknown;
};

export type WorkerHostMessage<Progress, Result> =
  | WorkerProgressMessage<Progress>
  | WorkerResultMessage<Result>
  | WorkerFailureMessage
  | WorkerDisposedMessage;

export type WorkerSerializedError = {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  stage?: string;
  scope?: TranslationFailure['scope'];
  retryable?: boolean;
  messageKey?: string;
  diagnostics?: TranslationFailure['diagnostics'];
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
  dispose(reason?: unknown): Promise<void>;
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
  if (value.type === 'disposed') {
    return value.protocolVersion === WORKER_TRANSLATOR_PROTOCOL_VERSION
      && typeof value.requestId === 'string';
  }
  return (
    value.protocolVersion === WORKER_TRANSLATOR_PROTOCOL_VERSION
    && typeof value.jobId === 'string'
    && (value.type === 'progress' || value.type === 'result' || value.type === 'failure')
  );
}

function isClientMessage(value: unknown): value is WorkerClientMessage<unknown, unknown> {
  if (!isRecord(value)) return false;
  if (value.type === 'dispose') {
    return value.protocolVersion === WORKER_TRANSLATOR_PROTOCOL_VERSION
      && typeof value.requestId === 'string';
  }
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

function cancellationReason(
  reason: unknown,
  fallback: TranslationCancellationReason,
): TranslationCancellationReason {
  if (reason instanceof TranslationCancelledError) return reason.reason;
  if (
    isRecord(reason)
    && typeof reason.code === 'string'
    && typeof reason.messageKey === 'string'
  ) {
    return {
      code: reason.code,
      messageKey: reason.messageKey,
      diagnosticSummary: typeof reason.diagnosticSummary === 'string'
        ? reason.diagnosticSummary
        : undefined,
    };
  }
  return {
    ...fallback,
    diagnosticSummary: reason instanceof Error
      ? reason.message
      : typeof reason === 'string' && reason
        ? reason
        : fallback.diagnosticSummary,
  };
}

function cancellationError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  return new TranslationCancelledError(cancellationReason(reason, {
    code: 'cancelled',
    messageKey: 'translation.cancelled',
  }));
}

export class WorkerTranslatorError extends Error {
  readonly code?: string;
  readonly stage?: string;
  readonly scope?: TranslationFailure['scope'];
  readonly retryable?: boolean;
  readonly messageKey?: string;
  readonly diagnostics?: TranslationFailure['diagnostics'];

  constructor(serialized: WorkerSerializedError) {
    super(serialized.message);
    this.name = serialized.name;
    this.stack = serialized.stack ?? this.stack;
    this.code = serialized.code;
    this.stage = serialized.stage;
    this.scope = serialized.scope;
    this.retryable = serialized.retryable;
    this.messageKey = serialized.messageKey;
    this.diagnostics = serialized.diagnostics;
  }
}

export function serializeWorkerError(error: unknown): WorkerSerializedError {
  if (!isRecord(error)) {
    return {
      name: 'Error',
      message: String(error),
    };
  }
  const failure = isRecord(error.failure) ? error.failure : error;
  return {
    name: typeof error.name === 'string' ? error.name : 'Error',
    message: typeof error.message === 'string' ? error.message : String(error),
    stack: typeof error.stack === 'string' ? error.stack : undefined,
    code: typeof failure.code === 'string'
      ? failure.code
      : typeof error.code === 'string'
        ? error.code
        : undefined,
    stage: typeof failure.stage === 'string'
      ? failure.stage
      : typeof error.stage === 'string'
        ? error.stage
        : undefined,
    scope: failure.scope === 'image' || failure.scope === 'runtime'
      ? failure.scope
      : undefined,
    retryable: typeof failure.retryable === 'boolean'
      ? failure.retryable
      : undefined,
    messageKey: typeof failure.messageKey === 'string'
      ? failure.messageKey
      : undefined,
    diagnostics: isRecord(failure.diagnostics)
      ? failure.diagnostics
      : undefined,
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
  validateResult?: (value: unknown) => boolean;
}): DisposableTranslatorCore<Input, Config, Progress, Result> {
  const pending = new Map<string, PendingJob<Progress, Result>>();
  const reviveError = options.reviveError ?? reviveWorkerError;
  let endpoint: WorkerClientEndpoint | null = null;
  let disposed = false;
  let executionTail = Promise.resolve();
  let disposal: Promise<void> | null = null;
  let disposalRequestId: string | null = null;
  let resolveDisposal: (() => void) | null = null;
  let rejectDisposal: ((reason: unknown) => void) | null = null;
  const publicTasks = new Set<ReturnType<TranslatorCore<Input, Config, Progress, Result>['run']>>();

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
    if (message.type === 'disposed') {
      if (message.requestId === disposalRequestId) {
        if (message.error === undefined) resolveDisposal?.();
        else rejectDisposal?.(reviveError(message.error));
      }
      return;
    }
    const job = pending.get(message.jobId);
    if (!job) return;
    if (message.type === 'progress') {
      job.reportProgress(message.progress as Progress);
      return;
    }
    if (message.type === 'result') {
      if (options.validateResult && !options.validateResult(message.result)) {
        settle(message.jobId, (activeJob) => activeJob.reject(
          new WorkerTranslatorError({
            name: 'WorkerProtocolError',
            code: 'WORKER_INVALID_RESULT',
            message: 'Worker 返回了无效结果',
          }),
        ));
        return;
      }
      settle(message.jobId, (activeJob) => activeJob.resolve(message.result as Result));
      return;
    }
    settle(message.jobId, (activeJob) => activeJob.reject(reviveError(message.error)));
  };

  const onError: ErrorListener = (event) => {
    const reason = event.error ?? new Error(event.message || '翻译 Worker 异常退出');
    failAll(reason);
    rejectDisposal?.(reason);
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
      const previousExecution = executionTail;
      let releaseExecution!: () => void;
      executionTail = new Promise<void>((resolve) => {
        releaseExecution = resolve;
      });
      await previousExecution;
      try {
        if (signal.aborted) throw cancellationError(signal.reason);
        const worker = ensureWorker();
        const jobId = createJobId();
        return await new Promise<Result>((resolve, reject) => {
          const onAbort = (): void => {
            try {
              worker.postMessage({
                protocolVersion: WORKER_TRANSLATOR_PROTOCOL_VERSION,
                type: 'cancel',
                jobId,
                reason: cancellationReason(signal.reason, {
                  code: 'cancelled',
                  messageKey: 'translation.cancelled',
                }),
              } satisfies WorkerCancelMessage);
            } catch (error) {
              settle(jobId, (job) => job.reject(error));
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
      } finally {
        releaseExecution();
      }
    },
  );

  return {
    run(request) {
      const task = core.run(request);
      publicTasks.add(task);
      const remove = (): void => {
        publicTasks.delete(task);
      };
      void task.result.then(remove, remove);
      return task;
    },
    dispose(reason = new Error('翻译 Worker 已释放')): Promise<void> {
      if (disposal) return disposal;
      disposed = true;
      const disposalReason = cancellationReason(reason, {
        code: 'owner-ended',
        messageKey: 'translation.cancelled.ownerEnded',
      });
      for (const task of publicTasks) task.cancel(disposalReason);
      failAll(reason);
      const worker = endpoint;
      if (!worker) return Promise.resolve();
      disposalRequestId = createJobId();
      disposal = new Promise<void>((resolve, reject) => {
        resolveDisposal = resolve;
        rejectDisposal = reject;
        try {
          worker.postMessage({
            protocolVersion: WORKER_TRANSLATOR_PROTOCOL_VERSION,
            type: 'dispose',
            requestId: disposalRequestId!,
            reason: disposalReason,
          } satisfies WorkerDisposeMessage);
        } catch (error) {
          reject(error);
        }
      }).finally(() => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        worker.terminate();
        if (endpoint === worker) endpoint = null;
        resolveDisposal = null;
        rejectDisposal = null;
      });
      return disposal;
    },
  };
}

export function attachWorkerTranslatorHost<Input, Config, Progress, Result>(options: {
  endpoint: WorkerHostEndpoint;
  execute: TranslationExecutor<Input, Config, Progress, Result>;
  serializeError?: (error: unknown) => unknown;
  transferResult?: (result: Result) => Transferable[];
  maxConcurrent?: number;
  dispose?: (reason: unknown) => void | Promise<void>;
}): () => void {
  const {
    endpoint,
    execute,
    serializeError = serializeWorkerError,
    transferResult,
    maxConcurrent = 1,
    dispose,
  } = options;
  const active = new Map<string, AbortController>();
  const executions = new Set<Promise<void>>();
  let closed = false;
  let disposal: Promise<void> | null = null;

  const post = (message: WorkerHostMessage<Progress, Result>, transfer?: Transferable[]): void => {
    endpoint.postMessage(message, transfer);
  };

  const onMessage: MessageListener = (event) => {
    if (!isClientMessage(event.data)) return;
    const message = event.data;
    if (message.type === 'dispose') {
      if (disposal) return;
      closed = true;
      for (const controller of active.values()) {
        controller.abort(cancellationError(message.reason));
      }
      disposal = (async () => {
        await Promise.allSettled([...executions]);
        let disposalError: unknown;
        try {
          await dispose?.(message.reason);
        } catch (error) {
          disposalError = serializeError(error);
        }
        endpoint.postMessage({
          protocolVersion: WORKER_TRANSLATOR_PROTOCOL_VERSION,
          type: 'disposed',
          requestId: message.requestId,
          ...(disposalError === undefined ? {} : { error: disposalError }),
        } satisfies WorkerDisposedMessage);
      })();
      return;
    }
    if (message.type === 'cancel') {
      active.get(message.jobId)?.abort(cancellationError(message.reason));
      return;
    }

    if (closed || active.size >= maxConcurrent) {
      post({
        protocolVersion: WORKER_TRANSLATOR_PROTOCOL_VERSION,
        type: 'failure',
        jobId: message.jobId,
        error: serializeError({
          name: closed ? 'WorkerClosedError' : 'WorkerBusyError',
          code: closed ? 'WORKER_CLOSED' : 'WORKER_BUSY',
          message: closed
            ? '翻译 Worker 已释放'
            : '翻译 Worker 正在处理另一张图片',
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

    const execution = execute(
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
    executions.add(execution);
    void execution.then(
      () => executions.delete(execution),
      () => executions.delete(execution),
    );
  };

  endpoint.addEventListener('message', onMessage);
  return () => {
    endpoint.removeEventListener('message', onMessage);
    for (const controller of active.values()) {
      controller.abort(new DOMException('翻译 Worker 已释放', 'AbortError'));
    }
  };
}
