import { describe, expect, it } from 'vitest';
import { createTranslatorCore } from '@shinobu/translator-core';
import type {
  ImageTranslationExecutionModule,
  ImageTranslationExecutionProgress,
  ImageTranslationExecutionRequest,
  ImageTranslationExecutionResult,
} from '../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import {
  createImageTranslationExecutionArbiter,
  type ImageTranslationExecutionActivity,
  type ImageTranslationExecutionActivityRequest,
} from '../../../apps/extension/src/content/core/translation/imageTranslationExecutionArbiter';

const request: ImageTranslationExecutionRequest = {
  source: {
    kind: 'prepared-file',
    file: new File(['source'], 'source.png', { type: 'image/png' }),
  },
};

function neverSettlingExecutionModule(): ImageTranslationExecutionModule {
  const core = createTranslatorCore<
    ImageTranslationExecutionRequest,
    undefined,
    never,
    ImageTranslationExecutionResult
  >(() => new Promise(() => undefined));
  return {
    start(input) {
      return core.run({ input, config: undefined });
    },
  };
}

function controllableExecutionModule(): {
  module: ImageTranslationExecutionModule;
  report(progress: ImageTranslationExecutionProgress): void;
  resolve(result: ImageTranslationExecutionResult): void;
} {
  const listeners = new Set<(progress: ImageTranslationExecutionProgress) => void>();
  let resolve!: (result: ImageTranslationExecutionResult) => void;
  const result = new Promise<ImageTranslationExecutionResult>((settle) => {
    resolve = settle;
  });
  return {
    module: {
      start() {
        return {
          result,
          signal: new AbortController().signal,
          cancel: () => undefined,
          progress(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        };
      },
    },
    report(progress) {
      for (const listener of listeners) listener(progress);
    },
    resolve,
  };
}

function crossReportingCancellationExecutionModule(): {
  module: ImageTranslationExecutionModule;
  started(): number;
} {
  const listeners = [
    new Set<(progress: ImageTranslationExecutionProgress) => void>(),
    new Set<(progress: ImageTranslationExecutionProgress) => void>(),
  ];
  let startCount = 0;
  return {
    module: {
      start() {
        const index = startCount++;
        return {
          result: new Promise<ImageTranslationExecutionResult>(() => undefined),
          signal: new AbortController().signal,
          cancel() {
            if (index !== 0) return;
            for (const listener of listeners[1]) {
              listener({ phase: 'preparing', operation: 'load-settings' });
            }
          },
          progress(listener) {
            listeners[index].add(listener);
            return () => listeners[index].delete(listener);
          },
        };
      },
    },
    started: () => startCount,
  };
}

function beginActive(
  arbiter: ReturnType<typeof createImageTranslationExecutionArbiter>,
  activity: ImageTranslationExecutionActivityRequest,
): ImageTranslationExecutionActivity {
  const result = arbiter.begin(activity);
  expect(result.status).toBe('active');
  if (result.status !== 'active') throw new Error('expected an active activity');
  return result.activity;
}

describe('image translation execution arbiter', () => {
  it('revokes the previous owner before activating a new explicit owner', async () => {
    const arbiter = createImageTranslationExecutionArbiter(
      neverSettlingExecutionModule(),
    );
    const previous = beginActive(arbiter, {
      owner: 'inline-image',
      origin: 'explicit',
    });
    const previousTask = previous.start(request);

    const next = beginActive(arbiter, {
      owner: 'screenshot',
      origin: 'explicit',
    });

    expect(previous.signal.aborted).toBe(true);
    await expect(previousTask.result).rejects.toMatchObject({
      name: 'TranslationCancelledError',
    });
    expect(next.signal.aborted).toBe(false);
  });

  it('keeps activities from the same owner active together', () => {
    const arbiter = createImageTranslationExecutionArbiter(
      neverSettlingExecutionModule(),
    );
    const first = beginActive(arbiter, {
      owner: 'inline-image',
      origin: 'explicit',
    });

    const second = beginActive(arbiter, {
      owner: 'inline-image',
      origin: 'explicit',
    });

    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);
  });

  it('revokes every activity owned by the replaced owner', () => {
    const arbiter = createImageTranslationExecutionArbiter(
      neverSettlingExecutionModule(),
    );
    const first = beginActive(arbiter, {
      owner: 'inline-image',
      origin: 'explicit',
    });
    const second = beginActive(arbiter, {
      owner: 'inline-image',
      origin: 'explicit',
    });

    beginActive(arbiter, { owner: 'screenshot', origin: 'explicit' });

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });

  it('defers an automatic activity owned by someone else', () => {
    const arbiter = createImageTranslationExecutionArbiter(
      neverSettlingExecutionModule(),
    );
    const explicit = beginActive(arbiter, {
      owner: 'screenshot',
      origin: 'explicit',
    });

    const automatic = arbiter.begin({
      owner: 'continuous',
      origin: 'automatic',
    });

    expect(automatic).toEqual({ status: 'deferred' });
    expect(explicit.signal.aborted).toBe(false);
  });

  it('admits an automatic activity after the current owner ends', () => {
    const arbiter = createImageTranslationExecutionArbiter(
      neverSettlingExecutionModule(),
    );
    const explicit = beginActive(arbiter, {
      owner: 'screenshot',
      origin: 'explicit',
    });
    explicit.end();

    const automatic = arbiter.begin({
      owner: 'continuous',
      origin: 'automatic',
    });

    expect(automatic.status).toBe('active');
  });

  it('does not let an obsolete activity release the current owner', () => {
    const arbiter = createImageTranslationExecutionArbiter(
      neverSettlingExecutionModule(),
    );
    const obsolete = beginActive(arbiter, {
      owner: 'inline-image',
      origin: 'explicit',
    });
    const current = beginActive(arbiter, {
      owner: 'screenshot',
      origin: 'explicit',
    });

    obsolete.end();
    const automatic = arbiter.begin({
      owner: 'continuous',
      origin: 'automatic',
    });

    expect(automatic).toEqual({ status: 'deferred' });
    expect(current.signal.aborted).toBe(false);
  });

  it('does not deliver progress after an activity is replaced', async () => {
    const execution = controllableExecutionModule();
    const arbiter = createImageTranslationExecutionArbiter(execution.module);
    const activity = beginActive(arbiter, {
      owner: 'inline-image',
      origin: 'explicit',
    });
    const task = activity.start(request);
    const progress: ImageTranslationExecutionProgress[] = [];
    task.progress((event) => progress.push(event));
    await Promise.resolve();

    beginActive(arbiter, { owner: 'screenshot', origin: 'explicit' });
    execution.report({ phase: 'preparing', operation: 'load-settings' });
    execution.resolve({} as ImageTranslationExecutionResult);
    await expect(task.result).rejects.toMatchObject({
      name: 'TranslationCancelledError',
    });

    expect(progress).toEqual([]);
  });

  it('stops task delivery before broadcasting the activity abort', async () => {
    const execution = controllableExecutionModule();
    const arbiter = createImageTranslationExecutionArbiter(execution.module);
    const activity = beginActive(arbiter, {
      owner: 'inline-image',
      origin: 'explicit',
    });
    const task = activity.start(request);
    await Promise.resolve();
    execution.report({ phase: 'preparing', operation: 'load-settings' });
    const replayedAfterAbort: ImageTranslationExecutionProgress[] = [];
    activity.signal.addEventListener('abort', () => {
      task.progress((event) => replayedAfterAbort.push(event));
    });

    beginActive(arbiter, { owner: 'screenshot', origin: 'explicit' });
    await expect(task.result).rejects.toMatchObject({
      name: 'TranslationCancelledError',
    });

    expect(replayedAfterAbort).toEqual([]);
  });

  it('blocks every old activity before cancelling any underlying execution', async () => {
    const execution = crossReportingCancellationExecutionModule();
    const arbiter = createImageTranslationExecutionArbiter(execution.module);
    const firstActivity = beginActive(arbiter, {
      owner: 'inline-image',
      origin: 'explicit',
    });
    const secondActivity = beginActive(arbiter, {
      owner: 'inline-image',
      origin: 'explicit',
    });
    const firstTask = firstActivity.start(request);
    const secondTask = secondActivity.start(request);
    const secondProgress: ImageTranslationExecutionProgress[] = [];
    secondTask.progress((event) => secondProgress.push(event));
    await Promise.resolve();
    expect(execution.started()).toBe(2);

    beginActive(arbiter, { owner: 'screenshot', origin: 'explicit' });
    await expect(firstTask.result).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    await expect(secondTask.result).rejects.toMatchObject({ code: 'TASK_CANCELLED' });

    expect(secondProgress).toEqual([]);
  });

  it('defers begin calls that synchronously reenter an owner replacement', () => {
    const arbiter = createImageTranslationExecutionArbiter(
      neverSettlingExecutionModule(),
    );
    const previous = beginActive(arbiter, {
      owner: 'inline-image',
      origin: 'explicit',
    });
    let reentrantResult: ReturnType<typeof arbiter.begin> | undefined;
    previous.signal.addEventListener('abort', () => {
      reentrantResult = arbiter.begin({
        owner: 'reading-mode',
        origin: 'explicit',
      });
    });

    const replacement = beginActive(arbiter, {
      owner: 'screenshot',
      origin: 'explicit',
    });
    const automatic = arbiter.begin({
      owner: 'continuous',
      origin: 'automatic',
    });

    expect(reentrantResult).toEqual({ status: 'deferred' });
    expect(automatic).toEqual({ status: 'deferred' });
    expect(replacement.signal.aborted).toBe(false);
  });

  it('does not activate a replacement when disposal reenters revocation', () => {
    const arbiter = createImageTranslationExecutionArbiter(
      neverSettlingExecutionModule(),
    );
    const previous = beginActive(arbiter, {
      owner: 'inline-image',
      origin: 'explicit',
    });
    previous.signal.addEventListener('abort', () => arbiter.dispose());

    const replacement = arbiter.begin({
      owner: 'screenshot',
      origin: 'explicit',
    });

    expect(replacement).toEqual({ status: 'deferred' });
    expect(() => arbiter.begin({
      owner: 'reading-mode',
      origin: 'explicit',
    })).toThrow('图片翻译执行仲裁器已停止');
  });
});
