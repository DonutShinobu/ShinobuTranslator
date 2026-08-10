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
              listener({ phase: 'preparing', operation: 'prepare-execution' });
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
): ImageTranslationExecutionActivity {
  return arbiter.begin();
}

describe('image translation execution arbiter', () => {
  it('keeps concurrent activities active together', () => {
    const arbiter = createImageTranslationExecutionArbiter(
      neverSettlingExecutionModule(),
    );
    const first = beginActive(arbiter);
    const second = beginActive(arbiter);

    expect(first.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);
  });

  it('ending one activity cancels only that activity tasks', async () => {
    const arbiter = createImageTranslationExecutionArbiter(
      neverSettlingExecutionModule(),
    );
    const inline = beginActive(arbiter);
    const screenshot = beginActive(arbiter);
    const inlineTask = inline.start(request);
    const screenshotTask = screenshot.start(request);

    inline.end('单图活动已结束');

    await expect(inlineTask.result).rejects.toMatchObject({
      name: 'TranslationCancelledError',
    });
    expect(screenshot.signal.aborted).toBe(false);
    screenshot.end();
    await expect(screenshotTask.result).rejects.toMatchObject({
      name: 'TranslationCancelledError',
    });
  });

  it('does not deliver progress after an activity ends', async () => {
    const execution = controllableExecutionModule();
    const arbiter = createImageTranslationExecutionArbiter(execution.module);
    const activity = beginActive(arbiter);
    const task = activity.start(request);
    const progress: ImageTranslationExecutionProgress[] = [];
    task.progress((event) => progress.push(event));
    await Promise.resolve();

    activity.end();
    execution.report({ phase: 'preparing', operation: 'prepare-execution' });
    execution.resolve({} as ImageTranslationExecutionResult);
    await expect(task.result).rejects.toMatchObject({
      name: 'TranslationCancelledError',
    });

    expect(progress).toEqual([]);
  });

  it('stops task delivery before broadcasting the activity abort', async () => {
    const execution = controllableExecutionModule();
    const arbiter = createImageTranslationExecutionArbiter(execution.module);
    const activity = beginActive(arbiter);
    const task = activity.start(request);
    await Promise.resolve();
    execution.report({ phase: 'preparing', operation: 'prepare-execution' });
    const replayedAfterAbort: ImageTranslationExecutionProgress[] = [];
    activity.signal.addEventListener('abort', () => {
      task.progress((event) => replayedAfterAbort.push(event));
    });

    activity.end();
    await expect(task.result).rejects.toMatchObject({
      name: 'TranslationCancelledError',
    });

    expect(replayedAfterAbort).toEqual([]);
  });

  it('blocks every activity before cancelling any underlying execution on dispose', async () => {
    const execution = crossReportingCancellationExecutionModule();
    const arbiter = createImageTranslationExecutionArbiter(execution.module);
    const firstActivity = beginActive(arbiter);
    const secondActivity = beginActive(arbiter);
    const firstTask = firstActivity.start(request);
    const secondTask = secondActivity.start(request);
    const secondProgress: ImageTranslationExecutionProgress[] = [];
    secondTask.progress((event) => secondProgress.push(event));
    await Promise.resolve();
    expect(execution.started()).toBe(2);

    arbiter.dispose();
    await expect(firstTask.result).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    await expect(secondTask.result).rejects.toMatchObject({ code: 'TASK_CANCELLED' });

    expect(secondProgress).toEqual([]);
  });

  it('rejects begin calls that synchronously reenter disposal', () => {
    const arbiter = createImageTranslationExecutionArbiter(
      neverSettlingExecutionModule(),
    );
    const active = beginActive(arbiter);
    let reentrantError: unknown;
    active.signal.addEventListener('abort', () => {
      try {
        arbiter.begin();
      } catch (error) {
        reentrantError = error;
      }
    });

    arbiter.dispose();

    expect(reentrantError).toMatchObject({
      message: '图片翻译执行仲裁器已停止',
    });
    expect(() => arbiter.begin()).toThrow('图片翻译执行仲裁器已停止');
  });
});
