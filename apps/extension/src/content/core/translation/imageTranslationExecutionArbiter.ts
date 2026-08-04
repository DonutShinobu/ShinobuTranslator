import {
  createTranslatorCore,
  TranslationCancelledError,
  type TranslationTask,
} from '@shinobu/translator-core';
import type {
  ImageTranslationExecutionModule,
  ImageTranslationExecutionProgress,
  ImageTranslationExecutionRequest,
  ImageTranslationExecutionResult,
} from './imageTranslationExecution';

export type ImageTranslationExecutionOwner =
  | 'inline-image'
  | 'reading-mode'
  | 'screenshot'
  | 'continuous';

export type ImageTranslationExecutionActivityOrigin = 'explicit' | 'automatic';

export type ImageTranslationExecutionActivityRequest = {
  owner: ImageTranslationExecutionOwner;
  origin: ImageTranslationExecutionActivityOrigin;
};

export interface ImageTranslationExecutionActivity extends ImageTranslationExecutionModule {
  readonly signal: AbortSignal;
  end(reason?: unknown): void;
}

export type BeginImageTranslationExecutionActivityResult =
  | {
      status: 'active';
      activity: ImageTranslationExecutionActivity;
    }
  | {
      status: 'deferred';
    };

export interface ImageTranslationExecutionArbiter {
  begin(
    request: ImageTranslationExecutionActivityRequest,
  ): BeginImageTranslationExecutionActivityResult;
  dispose(reason?: unknown): void;
}

type ExecutionTask = TranslationTask<
  ImageTranslationExecutionProgress,
  ImageTranslationExecutionResult
>;

const defaultEndReason = '图片翻译执行活动已结束';
const replacedReason = '图片翻译执行活动已被其他拥有者替代';
const disposedReason = '图片翻译执行仲裁器已停止';

function toCancellationError(reason: unknown): unknown {
  if (reason instanceof Error) return reason;
  if (
    reason !== null
    && typeof reason === 'object'
    && !Array.isArray(reason)
    && 'code' in reason
    && typeof reason.code === 'string'
    && 'messageKey' in reason
    && typeof reason.messageKey === 'string'
  ) {
    return new TranslationCancelledError({
      code: reason.code,
      messageKey: reason.messageKey,
      diagnosticSummary: 'diagnosticSummary' in reason
        && typeof reason.diagnosticSummary === 'string'
        ? reason.diagnosticSummary
        : undefined,
    });
  }
  return new TranslationCancelledError({
    code: 'cancelled',
    messageKey: 'translation.cancelled',
    diagnosticSummary: typeof reason === 'string' && reason ? reason : undefined,
  });
}

class ImageTranslationExecutionActivityImplementation
implements ImageTranslationExecutionActivity {
  private readonly abortController = new AbortController();
  private readonly tasks = new Set<ExecutionTask>();
  private ended = false;
  private deliveryBlockedReason: unknown = defaultEndReason;

  constructor(
    private readonly executionModule: ImageTranslationExecutionModule,
    private readonly onEnd: (
      activity: ImageTranslationExecutionActivityImplementation,
      reason?: unknown,
    ) => void,
  ) {}

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  start(request: ImageTranslationExecutionRequest): ExecutionTask {
    const core = createTranslatorCore<
      ImageTranslationExecutionRequest,
      undefined,
      ImageTranslationExecutionProgress,
      ImageTranslationExecutionResult
    >(async ({ input }, { signal, reportProgress }) => {
      if (signal.aborted) throw signal.reason;
      const executionTask = this.executionModule.start(input);
      const stopProgress = executionTask.progress(reportProgress);
      const cancelExecution = (): void => executionTask.cancel(signal.reason);
      signal.addEventListener('abort', cancelExecution, { once: true });
      if (signal.aborted) cancelExecution();
      try {
        return await executionTask.result;
      } finally {
        signal.removeEventListener('abort', cancelExecution);
        stopProgress();
      }
    });
    const coreTask = core.run({ input: request, config: undefined });
    const task: ExecutionTask = {
      result: coreTask.result.then((result) => {
        if (this.ended) throw toCancellationError(this.deliveryBlockedReason);
        return result;
      }),
      signal: coreTask.signal,
      cancel: (reason) => coreTask.cancel(reason),
      progress: (listener) => {
        if (this.ended) return () => undefined;
        return coreTask.progress((progress) => {
          if (!this.ended) listener(progress);
        });
      },
    };
    this.tasks.add(task);
    void task.result
      .catch(() => undefined)
      .finally(() => this.tasks.delete(task));
    if (this.ended) task.cancel(this.deliveryBlockedReason);
    return task;
  }

  end(reason?: unknown): void {
    this.onEnd(this, reason);
  }

  revoke(reason: unknown = defaultEndReason): void {
    this.blockDelivery(reason);
    this.cancelTasks(reason);
    this.broadcastRevocation(reason);
  }

  blockDelivery(reason: unknown = defaultEndReason): void {
    if (this.ended) return;
    this.ended = true;
    this.deliveryBlockedReason = reason;
  }

  cancelTasks(reason: unknown = defaultEndReason): void {
    const tasks = [...this.tasks];
    this.tasks.clear();
    for (const task of tasks) task.cancel(reason);
  }

  broadcastRevocation(reason: unknown = defaultEndReason): void {
    if (this.abortController.signal.aborted) return;
    this.abortController.abort(reason);
  }
}

class ImageTranslationExecutionArbiterImplementation
implements ImageTranslationExecutionArbiter {
  private currentOwner: ImageTranslationExecutionOwner | undefined;
  private readonly activities = new Set<ImageTranslationExecutionActivityImplementation>();
  private disposed = false;
  private replacementInProgress = false;

  constructor(private readonly executionModule: ImageTranslationExecutionModule) {}

  begin(
    request: ImageTranslationExecutionActivityRequest,
  ): BeginImageTranslationExecutionActivityResult {
    if (this.disposed) throw new Error(disposedReason);
    if (this.replacementInProgress) return { status: 'deferred' };
    if (this.currentOwner && this.currentOwner !== request.owner) {
      if (request.origin === 'automatic') return { status: 'deferred' };
      this.replacementInProgress = true;
      try {
        this.revokeAll(replacedReason);
      } finally {
        this.replacementInProgress = false;
      }
      if (this.disposed) return { status: 'deferred' };
    }

    this.currentOwner = request.owner;
    const activity = new ImageTranslationExecutionActivityImplementation(
      this.executionModule,
      (endedActivity, reason) => this.endActivity(endedActivity, reason),
    );
    this.activities.add(activity);
    return { status: 'active', activity };
  }

  dispose(reason: unknown = disposedReason): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revokeAll(reason);
  }

  private endActivity(
    activity: ImageTranslationExecutionActivityImplementation,
    reason?: unknown,
  ): void {
    if (!this.activities.delete(activity)) return;
    activity.revoke(reason);
    if (this.activities.size === 0) this.currentOwner = undefined;
  }

  private revokeAll(reason: unknown): void {
    const activities = [...this.activities];
    this.activities.clear();
    this.currentOwner = undefined;
    for (const activity of activities) activity.blockDelivery(reason);
    for (const activity of activities) activity.cancelTasks(reason);
    for (const activity of activities) activity.broadcastRevocation(reason);
  }
}

export function createImageTranslationExecutionArbiter(
  executionModule: ImageTranslationExecutionModule,
): ImageTranslationExecutionArbiter {
  return new ImageTranslationExecutionArbiterImplementation(executionModule);
}
