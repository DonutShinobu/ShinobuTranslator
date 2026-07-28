export type TranslationProgress<Stage extends string = string> = {
  stage: Stage;
  detail: string;
};

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

      const result = Promise.resolve()
        .then(() => execute(request, {
          signal: abortController.signal,
          reportProgress,
        }))
        .finally(() => {
          settled = true;
          listeners.clear();
        });

      return {
        result,
        signal: abortController.signal,
        cancel(reason) {
          if (!settled && !abortController.signal.aborted) {
            abortController.abort(reason);
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
