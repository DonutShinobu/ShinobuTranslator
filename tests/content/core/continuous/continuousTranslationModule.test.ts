import { describe, expect, it, vi } from 'vitest';
import {
  createContinuousTranslationModule,
  type ContinuousTranslationDependencies,
} from '../../../../apps/extension/src/content/core/continuous/continuousTranslationController';
import { ReaderEngineRegistry } from '../../../../apps/extension/src/content/core/continuous/readerEngineRegistry';
import type {
  ReaderEngineAdapter,
  ReaderEngineSession,
  ReaderPageSurface,
  ReaderVisibleSpread,
} from '../../../../apps/extension/src/content/core/continuous/contracts';
import type { PageArtifactPort } from '../../../../apps/extension/src/content/core/continuous/pageArtifactPort';
import type { ImageTranslationExecutionResult } from '../../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import { ImageTranslationExecutionError } from '../../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import type { ContinuousTranslationViewState } from '../../../../apps/extension/src/content/core/continuous/continuousTranslationController';
import type { ContinuousTranslationBarHandlers } from '../../../../apps/extension/src/content/core/continuous/continuousTranslationController';
import { PageArtifactQuotaError } from '../../../../apps/extension/src/shared/pageArtifacts';

function page(pageIndex: number): ReaderPageSurface {
  return {
    identity: { engineId: 'fake', contextKey: 'chapter', pageIndex },
    slot: { isConnected: true } as HTMLElement,
    source: { kind: 'viewport-region' },
    viewportRect: { left: pageIndex * 100, top: 0, width: 100, height: 100 },
    projectionAnchor: {} as HTMLElement,
  };
}

function memoryArtifacts(): PageArtifactPort {
  let nextId = 0;
  const files = new Map<string, File>();
  return {
    probe: async () => ({ available: true }),
    put: async ({ kind, file }) => {
      const id = `artifact-${nextId++}`;
      files.set(id, file);
      return {
        id,
        tabId: 1,
        contentSessionId: 'session-1',
        kind,
        name: file.name,
        type: file.type,
        size: file.size,
      };
    },
    read: async (ref) => {
      const file = files.get(ref.id);
      if (!file) throw new Error('missing');
      return file;
    },
    delete: async (ref) => {
      files.delete(ref.id);
    },
    clear: async () => files.clear(),
  };
}

function dependencies(
  spread: ReaderVisibleSpread,
  run?: (pageIndex: number) => Promise<ImageTranslationExecutionResult>,
) {
  const session: ReaderEngineSession = {
    engineId: 'fake',
    contextKey: 'chapter',
    readVisibleSpread: () => spread,
    observe: () => () => undefined,
    dispose: vi.fn(),
  };
  const adapter: ReaderEngineAdapter = {
    engineId: 'fake',
    detect: () => ({ confidence: 'strong', root: {} as HTMLElement, evidence: ['fake'] }),
    createSession: () => session,
  };
  const executionOrder: number[] = [];
  const activity = {
    signal: new AbortController().signal,
    end: vi.fn(),
    start: vi.fn((request) => {
      const result = (async () => {
        const file = request.source.kind === 'prepared-file' ? request.source.file : null;
        if (!file) throw new Error('expected prepared file');
        const pageIndex = Number(await file.text());
        executionOrder.push(pageIndex);
        if (run) return run(pageIndex);
        return {
          kind: 'local-pipeline',
          status: 'completed',
          image: new Blob([`translated-${pageIndex}`], { type: 'image/png' }),
        } as ImageTranslationExecutionResult;
      })();
      return {
        result,
        signal: new AbortController().signal,
        cancel: vi.fn(),
        progress: () => () => undefined,
      };
    }),
  };
  const barUpdates: ContinuousTranslationViewState[] = [];
  const barHandlers: { current?: ContinuousTranslationBarHandlers } = {};
  const deps: ContinuousTranslationDependencies = {
    registry: new ReaderEngineRegistry([adapter]),
    artifacts: memoryArtifacts(),
    tabState: { read: async () => true, write: vi.fn(async () => undefined) },
    sourceResolver: {
      resolve: async (pages) => pages.map((surface) => ({
        surface,
        file: new File([String(surface.identity.pageIndex)], 'page.png', { type: 'image/png' }),
      })),
    },
    executionArbiter: {
      begin: vi.fn(() => ({ status: 'active' as const, activity })),
      dispose: vi.fn(),
    },
    fingerprint: async (file) => file.text(),
    fingerprintsMatch: (left, right) => left === right,
    createMonitor: (_session, onStable) => ({
      start: () => onStable(spread),
      dispose: vi.fn(),
    }),
    bar: {
      mount: vi.fn(),
      update: vi.fn((state) => barUpdates.push(state)),
      dispose: vi.fn(),
      setHandlers: vi.fn((handlers) => {
        barHandlers.current = handlers;
      }),
    },
    projection: {
      sync: vi.fn(),
      setDisplayMode: vi.fn(),
      clear: vi.fn(),
      dispose: vi.fn(),
    },
  };
  return { deps, executionOrder, activity, barUpdates, barHandlers };
}

describe('ContinuousTranslationModule', () => {
  it('freezes stable pages and executes the artifact-backed FIFO in page order', async () => {
    const spread = { pages: [page(0), page(1), page(2)] };
    const { deps, executionOrder, activity } = dependencies(spread);
    const module = createContinuousTranslationModule(deps);

    module.start();

    await vi.waitFor(() => expect(executionOrder).toEqual([0, 1, 2]));
    expect(activity.start).toHaveBeenCalledTimes(3);
    for (const [request] of activity.start.mock.calls) {
      expect(request).toEqual(expect.objectContaining({
        source: expect.objectContaining({ kind: 'prepared-file' }),
        allowedKinds: ['local-pipeline'],
      }));
    }
  });

  it('deduplicates the same logical page revision across repeated stable signals', async () => {
    const spread = { pages: [page(0), page(1)] };
    const { deps, executionOrder } = dependencies(spread);
    deps.createMonitor = (_session, onStable) => ({
      start: () => {
        onStable(spread);
        onStable(spread);
      },
      dispose: vi.fn(),
    });

    createContinuousTranslationModule(deps).start();

    await vi.waitFor(() => expect(executionOrder).toEqual([0, 1]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(executionOrder).toEqual([0, 1]);
  });

  it('continues after an image-local failure but pauses after a runtime failure', async () => {
    const spread = { pages: [page(0), page(1), page(2)] };
    const completed = async (pageIndex: number): Promise<ImageTranslationExecutionResult> => ({
      kind: 'local-pipeline',
      status: 'completed',
      image: new Blob([`translated-${pageIndex}`], { type: 'image/png' }),
    } as ImageTranslationExecutionResult);
    const local = dependencies(spread, async (pageIndex) => {
      if (pageIndex === 1) throw new Error('bad image');
      return completed(pageIndex);
    });
    createContinuousTranslationModule(local.deps).start();
    await vi.waitFor(() => expect(local.executionOrder).toEqual([0, 1, 2]));
    expect(local.barUpdates.at(-1)).toEqual(expect.objectContaining({ failed: 1 }));

    const runtime = dependencies(spread, async (pageIndex) => {
      if (pageIndex === 1) {
        throw new ImageTranslationExecutionError({
          code: 'PIPELINE_HOST_UNAVAILABLE',
          scope: 'runtime',
          retryable: true,
          messageKey: 'runtime unavailable',
        });
      }
      return completed(pageIndex);
    });
    createContinuousTranslationModule(runtime.deps).start();
    await vi.waitFor(() => expect(runtime.executionOrder).toEqual([0, 1]));
    expect(runtime.barUpdates.at(-1)).toEqual(expect.objectContaining({
      phase: 'paused',
      queued: 2,
    }));
  });

  it('keeps a strict FIFO without a business page limit', async () => {
    const spread = { pages: Array.from({ length: 1_000 }, (_, index) => page(index)) };
    const { deps, executionOrder } = dependencies(spread);

    createContinuousTranslationModule(deps).start();

    await vi.waitFor(() => expect(executionOrder).toHaveLength(1_000), { timeout: 10_000 });
    expect(executionOrder[0]).toBe(0);
    expect(executionOrder.at(-1)).toBe(999);
  });

  it('retries capture with exponential backoff at most three times', async () => {
    const spread = { pages: [page(0)] };
    const { deps, executionOrder } = dependencies(spread);
    const originalResolve = deps.sourceResolver.resolve;
    deps.sourceResolver.resolve = vi.fn()
      .mockRejectedValueOnce(new Error('capture one'))
      .mockRejectedValueOnce(new Error('capture two'))
      .mockImplementation(originalResolve);
    deps.waitBeforeCaptureRetry = vi.fn(async () => undefined);

    createContinuousTranslationModule(deps).start();

    await vi.waitFor(() => expect(executionOrder).toEqual([0]));
    expect(deps.sourceResolver.resolve).toHaveBeenCalledTimes(3);
    expect(deps.waitBeforeCaptureRetry).toHaveBeenNthCalledWith(1, 250);
    expect(deps.waitBeforeCaptureRetry).toHaveBeenNthCalledWith(2, 500);
  });

  it('abandons capture retries when the visible logical spread changes', async () => {
    const initialSpread = { pages: [page(0)] };
    let currentSpread: ReaderVisibleSpread = initialSpread;
    const { deps, executionOrder } = dependencies(initialSpread);
    deps.createMonitor = (_session, onStable) => ({
      start: () => onStable({ pages: [...initialSpread.pages] }),
      dispose: vi.fn(),
    });
    const adapter = deps.registry.detect()!.adapter;
    deps.registry = new ReaderEngineRegistry([{
      ...adapter,
      createSession: () => ({
        engineId: 'fake',
        contextKey: 'chapter',
        readVisibleSpread: () => currentSpread,
        observe: () => () => undefined,
        dispose: vi.fn(),
      }),
    }]);
    deps.sourceResolver.resolve = vi.fn().mockRejectedValue(new Error('temporary capture'));
    deps.waitBeforeCaptureRetry = vi.fn(async () => {
      currentSpread = {
        pages: [{
          ...page(0),
          viewportRect: { left: 8, top: 0, width: 100, height: 100 },
        }],
      };
    });

    createContinuousTranslationModule(deps).start();

    await vi.waitFor(() => expect(deps.waitBeforeCaptureRetry).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deps.sourceResolver.resolve).toHaveBeenCalledOnce();
    expect(executionOrder).toEqual([]);
  });

  it('does not persist an in-flight capture after the document becomes hidden', async () => {
    const spread = { pages: [page(0)] };
    const { deps, executionOrder } = dependencies(spread);
    let visible = true;
    let finishCapture!: () => void;
    const captureGate = new Promise<void>((resolve) => {
      finishCapture = resolve;
    });
    deps.isDocumentVisible = () => visible;
    deps.sourceResolver.resolve = vi.fn(async (pages: readonly ReaderPageSurface[]) => {
      await captureGate;
      return pages.map((surface) => ({
        surface,
        file: new File(['0'], 'page.png'),
      }));
    });
    const put = vi.spyOn(deps.artifacts, 'put');

    createContinuousTranslationModule(deps).start();
    await vi.waitFor(() => expect(deps.sourceResolver.resolve).toHaveBeenCalledOnce());
    visible = false;
    finishCapture();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(put).not.toHaveBeenCalled();
    expect(executionOrder).toEqual([]);
  });

  it('does not project a result that completes while the document is hidden', async () => {
    let finish!: (result: ImageTranslationExecutionResult) => void;
    const result = new Promise<ImageTranslationExecutionResult>((resolve) => {
      finish = resolve;
    });
    const spread = { pages: [page(0)] };
    const { deps, barUpdates } = dependencies(spread, () => result);
    let visible = true;
    deps.isDocumentVisible = () => visible;

    createContinuousTranslationModule(deps).start();
    await vi.waitFor(() => expect(barUpdates.at(-1)?.processingPage).toBe(1));
    const syncCallsBeforeCompletion = vi.mocked(deps.projection.sync).mock.calls.length;
    visible = false;
    finish({
      kind: 'local-pipeline',
      status: 'completed',
      image: new Blob(['translated'], { type: 'image/png' }),
    } as ImageTranslationExecutionResult);

    await vi.waitFor(() => expect(barUpdates.at(-1)?.processingPage).toBeUndefined());
    expect(vi.mocked(deps.projection.sync)).toHaveBeenCalledTimes(syncCallsBeforeCompletion);
    expect(deps.projection.clear).toHaveBeenCalled();
  });

  it('deletes the consumed source and retries a result write once after quota failure', async () => {
    const spread = { pages: [page(0)] };
    const { deps, executionOrder } = dependencies(spread);
    const artifacts = memoryArtifacts();
    const originalPut = artifacts.put.bind(artifacts);
    const put = vi.fn(async (input: Parameters<PageArtifactPort['put']>[0]) => {
      if (input.kind === 'translated-result' && put.mock.calls.length === 2) {
        throw new PageArtifactQuotaError();
      }
      return originalPut(input);
    });
    const remove = vi.spyOn(artifacts, 'delete');
    deps.artifacts = { ...artifacts, put };

    createContinuousTranslationModule(deps).start();

    await vi.waitFor(() => expect(executionOrder).toEqual([0]));
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(3));
    expect(put.mock.calls.map(([input]) => input.kind)).toEqual([
      'source-snapshot',
      'translated-result',
      'translated-result',
    ]);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('pauses new capture on source quota failure and exposes a retry', async () => {
    const spread = { pages: [page(0)] };
    const { deps, barHandlers, barUpdates, executionOrder } = dependencies(spread);
    const artifacts = memoryArtifacts();
    const originalPut = artifacts.put.bind(artifacts);
    const put = vi.fn(async (input: Parameters<PageArtifactPort['put']>[0]) => {
      if (put.mock.calls.length === 1) throw new PageArtifactQuotaError();
      return originalPut(input);
    });
    deps.artifacts = { ...artifacts, put };

    createContinuousTranslationModule(deps).start();
    await vi.waitFor(() => expect(barUpdates.at(-1)).toEqual(expect.objectContaining({
      canRetry: true,
      message: '页面产物存储空间不足',
    })));
    expect(executionOrder).toEqual([]);

    barHandlers.current?.retryFailures();
    await vi.waitFor(() => expect(executionOrder).toEqual([0]));
  });

  it('does not restore deleted work after disabling during an in-flight result', async () => {
    let finish!: (result: ImageTranslationExecutionResult) => void;
    const result = new Promise<ImageTranslationExecutionResult>((resolve) => {
      finish = resolve;
    });
    const spread = { pages: [page(0)] };
    const { deps, activity, barHandlers, barUpdates } = dependencies(spread, () => result);
    createContinuousTranslationModule(deps).start();
    await vi.waitFor(() => expect(barHandlers.current).toBeDefined());
    await vi.waitFor(() => expect(barUpdates.at(-1)?.processingPage).toBe(1));

    barHandlers.current?.setEnabled(false);
    await vi.waitFor(() => expect(barUpdates.at(-1)?.phase).toBe('off'));
    finish({
      kind: 'local-pipeline',
      status: 'completed',
      image: new Blob(['translated'], { type: 'image/png' }),
    } as ImageTranslationExecutionResult);

    await vi.waitFor(() => expect(barUpdates.at(-1)?.processingPage).toBeUndefined());
    expect(barUpdates.at(-1)).toEqual(expect.objectContaining({ phase: 'off', queued: 0 }));

    barHandlers.current?.setEnabled(true);
    await vi.waitFor(() => expect(activity.start).toHaveBeenCalledTimes(2));
  });

  it('hands an interrupted drain to the replacement activity without stalling the FIFO', async () => {
    let finishFirst!: (result: ImageTranslationExecutionResult) => void;
    const firstResult = new Promise<ImageTranslationExecutionResult>((resolve) => {
      finishFirst = resolve;
    });
    const spread = { pages: [page(0)] };
    const { deps } = dependencies(spread);
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    const firstStart = vi.fn(() => ({
      result: firstResult,
      signal: firstAbort.signal,
      cancel: vi.fn(),
      progress: () => () => undefined,
    }));
    const secondStart = vi.fn(() => ({
      result: Promise.resolve({
        kind: 'local-pipeline',
        status: 'completed',
        image: new Blob(['translated'], { type: 'image/png' }),
      } as ImageTranslationExecutionResult),
      signal: secondAbort.signal,
      cancel: vi.fn(),
      progress: () => () => undefined,
    }));
    const activities = [{
      signal: firstAbort.signal,
      end: vi.fn(),
      start: firstStart,
    }, {
      signal: secondAbort.signal,
      end: vi.fn(),
      start: secondStart,
    }];
    deps.executionArbiter.begin = vi.fn(() => ({
      status: 'active' as const,
      activity: activities.shift()!,
    }));
    let retryAdmission: (() => void) | undefined;
    deps.setRetryTimer = (callback) => {
      retryAdmission = callback;
      return 1;
    };

    createContinuousTranslationModule(deps).start();
    await vi.waitFor(() => expect(firstStart).toHaveBeenCalledTimes(1));
    firstAbort.abort();
    await vi.waitFor(() => expect(retryAdmission).toBeDefined());
    retryAdmission?.();
    finishFirst({
      kind: 'local-pipeline',
      status: 'completed',
      image: new Blob(['obsolete'], { type: 'image/png' }),
    } as ImageTranslationExecutionResult);

    await vi.waitFor(() => expect(secondStart).toHaveBeenCalledTimes(1));
  });

  it('probes artifact storage after enabling while the reader is suspended', async () => {
    let root = { isConnected: true } as HTMLElement;
    let detected = true;
    const spread = { pages: [page(0)] };
    const base = dependencies(spread);
    base.deps.tabState.read = async () => false;
    const artifacts = memoryArtifacts();
    let registered = false;
    const probe = vi.fn(async () => {
      registered = true;
      return { available: true as const };
    });
    const sessionDispose = vi.fn();
    base.deps.artifacts = {
      ...artifacts,
      probe,
      put: async (input) => {
        if (!registered) throw new Error('artifact session is not registered');
        return artifacts.put(input);
      },
    };
    const adapter: ReaderEngineAdapter = {
      engineId: 'fake',
      detect: () => detected
        ? { confidence: 'strong', root, evidence: ['fake'] }
        : null,
      createSession: () => ({
        engineId: 'fake',
        contextKey: 'chapter',
        readVisibleSpread: () => spread,
        observe: () => () => undefined,
        dispose: sessionDispose,
      }),
    };
    base.deps.registry = new ReaderEngineRegistry([adapter]);
    let signalDetection: (() => void) | undefined;
    base.deps.observeDetection = (onChange) => {
      signalDetection = onChange;
      return () => undefined;
    };

    createContinuousTranslationModule(base.deps).start();
    await vi.waitFor(() => expect(base.barHandlers.current).toBeDefined());
    (root as { isConnected: boolean }).isConnected = false;
    detected = false;
    signalDetection?.();
    await vi.waitFor(() => expect(sessionDispose).toHaveBeenCalledOnce());

    base.barHandlers.current?.setEnabled(true);
    await vi.waitFor(() => expect(base.barUpdates.at(-1)).toEqual(expect.objectContaining({
      phase: 'paused',
      message: '等待阅读器恢复',
    })));
    expect(probe).not.toHaveBeenCalled();

    root = { isConnected: true } as HTMLElement;
    detected = true;
    signalDetection?.();

    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(base.executionOrder).toEqual([0]));
  });

  it('retries projection reconciliation without requeueing a completed translation', async () => {
    const spread = { pages: [page(0)] };
    const { deps, executionOrder, activity, barHandlers, barUpdates } = dependencies(spread);
    const projectionSync = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('projection read failed'))
      .mockResolvedValue(undefined);
    deps.projection.sync = projectionSync;

    createContinuousTranslationModule(deps).start();

    await vi.waitFor(() => expect(executionOrder).toEqual([0]));
    await vi.waitFor(() => expect(barUpdates.at(-1)).toEqual(expect.objectContaining({
      failed: 0,
      canRetry: true,
      message: '译文显示失败：projection read failed',
    })));
    expect(activity.start).toHaveBeenCalledOnce();

    barHandlers.current?.retryFailures();

    await vi.waitFor(() => expect(projectionSync).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(barUpdates.at(-1)).toEqual(expect.objectContaining({
      failed: 0,
      canRetry: false,
    })));
    expect(activity.start).toHaveBeenCalledOnce();
  });

  it('suspends for a missing reader, resumes the same context, and resets a new context', async () => {
    let root = { isConnected: true } as HTMLElement;
    let sessionAnchor: Element = root;
    let detected = true;
    let contextKey = 'chapter-1';
    let currentSpread: ReaderVisibleSpread = { pages: [page(0)] };
    const base = dependencies(currentSpread);
    const adapter: ReaderEngineAdapter = {
      engineId: 'fake',
      detect: () => detected
        ? { confidence: 'strong', root, sessionAnchor, evidence: ['fake'] }
        : null,
      createSession: () => ({
        engineId: 'fake',
        contextKey,
        readVisibleSpread: () => currentSpread,
        observe: () => () => undefined,
        dispose: vi.fn(),
      }),
    };
    base.deps.registry = new ReaderEngineRegistry([adapter]);
    base.deps.createMonitor = (session, onStable) => ({
      start: () => onStable(session.readVisibleSpread()),
      dispose: vi.fn(),
    });
    let signalDetection: (() => void) | undefined;
    base.deps.observeDetection = (onChange) => {
      signalDetection = onChange;
      return () => undefined;
    };
    const clear = vi.spyOn(base.deps.artifacts, 'clear');

    createContinuousTranslationModule(base.deps).start();
    await vi.waitFor(() => expect(base.executionOrder).toEqual([0]));

    (root as { isConnected: boolean }).isConnected = false;
    detected = false;
    signalDetection?.();
    await vi.waitFor(() => expect(base.barUpdates.at(-1)).toEqual(expect.objectContaining({
      phase: 'paused',
      message: '等待阅读器恢复',
    })));
    base.barHandlers.current?.setEnabled(false);
    await vi.waitFor(() => expect(base.barUpdates.at(-1)?.phase).toBe('off'));

    root = { isConnected: true } as HTMLElement;
    sessionAnchor = root;
    currentSpread = { pages: [page(1)] };
    detected = true;
    signalDetection?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(base.executionOrder).toEqual([0]);
    base.barHandlers.current?.setEnabled(true);
    await vi.waitFor(() => expect(base.executionOrder).toEqual([0, 1]));
    expect(clear).not.toHaveBeenCalled();

    sessionAnchor = { isConnected: true } as Element;
    currentSpread = { pages: [page(2)] };
    signalDetection?.();
    await vi.waitFor(() => expect(base.executionOrder).toEqual([0, 1, 2]));
    expect(clear).not.toHaveBeenCalled();

    contextKey = 'chapter-2';
    currentSpread = { pages: [page(3)] };
    signalDetection?.();
    await vi.waitFor(() => expect(clear).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(base.executionOrder).toEqual([0, 1, 2, 3]));
  });
});
