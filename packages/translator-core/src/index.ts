export type TranslationProgress<Stage extends string = string> = {
  stage: Stage;
  detail: string;
};

export type TranslationFailure = {
  code: string;
  stage?: string;
  scope: 'image' | 'runtime';
  retryable: boolean;
  messageKey: string;
  diagnostics?: Readonly<Record<string, unknown>>;
};

export type TranslationCancellationReason = {
  code: string;
  messageKey: string;
  diagnosticSummary?: string;
};

export class TranslationCancelledError extends Error {
  readonly code = 'TASK_CANCELLED';

  constructor(readonly reason: TranslationCancellationReason) {
    super(reason.messageKey);
    this.name = 'TranslationCancelledError';
  }
}

export class TranslationExecutionError extends Error {
  constructor(
    readonly failure: TranslationFailure,
    cause?: unknown,
  ) {
    super(
      failure.messageKey,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'TranslationExecutionError';
  }

  get code(): string {
    return this.failure.code;
  }

  get stage(): string | undefined {
    return this.failure.stage;
  }
}

export type TranslationRequest<Input, Config> = {
  input: Input;
  config: Config;
};

export type TranslationExecutionContext<Progress> = {
  signal: AbortSignal;
  reportProgress: (progress: Progress) => void;
};

export type TranslationExecutor<Input, Config, Progress, Result> = (
  request: TranslationRequest<Input, Config>,
  context: TranslationExecutionContext<Progress>,
) => Promise<Result>;

export type TranslationProgressListener<Progress> = (progress: Progress) => void;

export interface TranslationTask<Progress, Result> {
  readonly result: Promise<Result>;
  readonly signal: AbortSignal;
  cancel(reason?: unknown): void;
  progress(listener: TranslationProgressListener<Progress>): () => void;
}

export interface TranslatorCore<Input, Config, Progress, Result> {
  run(request: TranslationRequest<Input, Config>): TranslationTask<Progress, Result>;
}

function reportListenerError(error: unknown): void {
  const runtime = globalThis as typeof globalThis & {
    reportError?: (reason: unknown) => void;
  };
  if (runtime.reportError) {
    runtime.reportError(error);
    return;
  }
  console.error('Translation progress listener failed', error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cancellationError(reason: unknown): unknown {
  if (reason instanceof Error) return reason;
  if (
    isRecord(reason)
    && typeof reason.code === 'string'
    && typeof reason.messageKey === 'string'
  ) {
    return new TranslationCancelledError({
      code: reason.code,
      messageKey: reason.messageKey,
      diagnosticSummary: typeof reason.diagnosticSummary === 'string'
        ? reason.diagnosticSummary
        : undefined,
    });
  }
  return new TranslationCancelledError({
    code: 'cancelled',
    messageKey: 'translation.cancelled',
    diagnosticSummary: typeof reason === 'string' && reason
      ? reason
      : undefined,
  });
}

export function createTranslatorCore<Input, Config, Progress, Result>(
  execute: TranslationExecutor<Input, Config, Progress, Result>,
): TranslatorCore<Input, Config, Progress, Result> {
  return {
    run(request) {
      const abortController = new AbortController();
      const listeners = new Set<TranslationProgressListener<Progress>>();
      let latestProgress: Progress | undefined;
      let settled = false;

      const reportProgress = (progress: Progress): void => {
        if (settled) return;
        latestProgress = progress;
        for (const listener of listeners) {
          try {
            listener(progress);
          } catch (error) {
            reportListenerError(error);
          }
        }
      };

      const execution = Promise.resolve()
        .then(() => execute(request, {
          signal: abortController.signal,
          reportProgress,
        }));
      let rejectCancellation!: (reason: unknown) => void;
      const cancellation = new Promise<never>((_resolve, reject) => {
        rejectCancellation = reject;
      });
      const result = Promise.race([execution, cancellation])
        .finally(() => {
          settled = true;
          listeners.clear();
        });

      return {
        result,
        signal: abortController.signal,
        cancel(reason) {
          if (!settled && !abortController.signal.aborted) {
            const error = cancellationError(reason);
            settled = true;
            listeners.clear();
            abortController.abort(error);
            rejectCancellation(error);
          }
        },
        progress(listener) {
          if (settled) return () => undefined;
          listeners.add(listener);
          if (latestProgress !== undefined) {
            try {
              listener(latestProgress);
            } catch (error) {
              reportListenerError(error);
            }
          }
          return () => {
            listeners.delete(listener);
          };
        },
      };
    },
  };
}
