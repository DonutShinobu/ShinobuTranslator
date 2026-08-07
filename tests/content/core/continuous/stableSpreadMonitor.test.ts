import { afterEach, describe, expect, it, vi } from 'vitest';
import { StableSpreadMonitor } from '../../../../apps/extension/src/content/core/continuous/stableSpreadMonitor';
import type {
  ReaderEngineSession,
  ReaderSessionSignal,
  ReaderVisibleSpread,
} from '../../../../apps/extension/src/content/core/continuous/contracts';

function spread(left = 0): ReaderVisibleSpread {
  const canvas = {
    isConnected: true,
    width: 848,
    height: 1200,
  } as HTMLCanvasElement;
  return {
    pages: [{
      identity: { engineId: 'fake', contextKey: 'chapter', pageIndex: 1 },
      slot: { isConnected: true } as HTMLElement,
      source: { kind: 'canvas', element: canvas },
      viewportRect: { left, top: 0, width: 100, height: 100 },
      projectionAnchor: {} as HTMLElement,
    }],
  };
}

describe('StableSpreadMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('preserves the Window receiver for animation frame APIs', async () => {
    vi.useFakeTimers();
    const current = spread();
    const session: ReaderEngineSession = {
      engineId: 'fake',
      contextKey: 'chapter',
      readVisibleSpread: () => current,
      observe: () => () => undefined,
      dispose: () => undefined,
    };
    const emitted: ReaderVisibleSpread[] = [];
    vi.stubGlobal('requestAnimationFrame', function requestFrame(
      this: typeof globalThis,
      callback: FrameRequestCallback,
    ) {
      if (this !== globalThis) {
        throw new TypeError(
          'Illegal invocation: Function must be called on an object of type Window',
        );
      }
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', function cancelFrame(this: typeof globalThis) {
      if (this !== globalThis) {
        throw new TypeError(
          'Illegal invocation: Function must be called on an object of type Window',
        );
      }
    });
    const monitor = new StableSpreadMonitor(session, (value) => emitted.push(value));

    monitor.start();
    await vi.advanceTimersByTimeAsync(400);

    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    monitor.dispose();
  });

  it('waits for 400ms without signals and two animation frames before emitting', async () => {
    vi.useFakeTimers();
    let current = spread();
    let signal: ((value: ReaderSessionSignal) => void) | undefined;
    const session: ReaderEngineSession = {
      engineId: 'fake',
      contextKey: 'chapter',
      readVisibleSpread: () => current,
      observe: (listener) => {
        signal = listener;
        return () => undefined;
      },
      dispose: () => undefined,
    };
    const emitted: ReaderVisibleSpread[] = [];
    const monitor = new StableSpreadMonitor(session, (value) => emitted.push(value), {
      requestAnimationFrame: (callback) => {
        callback(0);
        return 1;
      },
      cancelAnimationFrame: () => undefined,
    });

    monitor.start();
    await vi.advanceTimersByTimeAsync(300);
    signal?.({ kind: 'geometry-changed' });
    await vi.advanceTimersByTimeAsync(399);
    expect(emitted).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(emitted).toEqual([current]);

    current = spread(20);
    signal?.({ kind: 'geometry-changed' });
    monitor.dispose();
    await vi.advanceTimersByTimeAsync(400);
    expect(emitted).toHaveLength(1);
  });
});
