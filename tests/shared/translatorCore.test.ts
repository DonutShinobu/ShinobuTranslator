import { describe, expect, it, vi } from 'vitest';
import {
  TranslationCancelledError,
  createTranslatorCore,
} from '@shinobu/translator-core';

describe('translator core task contract', () => {
  it('publishes progress and resolves the execution result', async () => {
    const core = createTranslatorCore<string, number, string, string>(
      async ({ input, config }, { reportProgress }) => {
        reportProgress('started');
        await Promise.resolve();
        reportProgress('finished');
        return `${input}:${config}`;
      },
    );
    const task = core.run({ input: 'page', config: 2 });
    const progress: string[] = [];
    task.progress((value) => progress.push(value));

    await expect(task.result).resolves.toBe('page:2');
    expect(progress).toEqual(['started', 'finished']);
  });

  it('exposes an already-aborted signal when cancelled before execution', async () => {
    const execute = vi.fn(async (
      _request: { input: string; config: null },
      { signal }: { signal: AbortSignal },
    ) => {
      if (signal.aborted) throw signal.reason;
      return 'unexpected';
    });
    const core = createTranslatorCore(execute);
    const task = core.run({ input: 'page', config: null });
    const reason = new Error('cancelled');

    task.cancel(reason);

    await expect(task.result).rejects.toBe(reason);
    expect(task.signal.aborted).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('forwards cancellation to a running executor', async () => {
    const core = createTranslatorCore<null, null, never, never>(
      async (_request, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    );
    const task = core.run({ input: null, config: null });
    await Promise.resolve();
    const reason = new Error('stop');

    task.cancel(reason);

    await expect(task.result).rejects.toBe(reason);
  });

  it('settles structured cancellation once and suppresses an executor late result', async () => {
    let finish: ((value: string) => void) | undefined;
    let publish: ((value: string) => void) | undefined;
    const core = createTranslatorCore<null, null, string, string>(
      async (_request, { reportProgress }) => new Promise<string>((resolve) => {
        publish = reportProgress;
        finish = resolve;
      }),
    );
    const task = core.run({ input: null, config: null });
    const progress = vi.fn();
    task.progress(progress);
    await Promise.resolve();
    publish?.('running');

    task.cancel({
      code: 'owner-ended',
      messageKey: 'translation.cancelled.ownerEnded',
      diagnosticSummary: 'content context closed',
    });
    publish?.('late-progress');

    await expect(task.result).rejects.toEqual(
      expect.objectContaining({
        name: 'TranslationCancelledError',
        code: 'TASK_CANCELLED',
        reason: {
          code: 'owner-ended',
          messageKey: 'translation.cancelled.ownerEnded',
          diagnosticSummary: 'content context closed',
        },
      }),
    );
    expect(task.signal.aborted).toBe(true);
    expect(progress).toHaveBeenCalledTimes(1);

    finish?.('late-success');
    await Promise.resolve();
    expect(task.signal.reason).toBeInstanceOf(TranslationCancelledError);
  });

  it('replays the latest progress and supports unsubscribe', async () => {
    let publish: ((value: number) => void) | undefined;
    let finish: (() => void) | undefined;
    const core = createTranslatorCore<null, null, number, void>(
      async (_request, { reportProgress }) => new Promise<void>((resolve) => {
        publish = reportProgress;
        finish = resolve;
      }),
    );
    const task = core.run({ input: null, config: null });
    await Promise.resolve();
    publish?.(1);
    const listener = vi.fn();
    const unsubscribe = task.progress(listener);

    publish?.(2);
    unsubscribe();
    publish?.(3);
    finish?.();
    await task.result;

    expect(listener.mock.calls).toEqual([[1], [2]]);
  });
});
