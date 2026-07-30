import { describe, expect, it, vi } from 'vitest';
import {
  ImagePipelineAdmissionError,
  ImagePipelineCancelledError,
  ImagePipelineExecutionError,
  ImagePipelineRuntime,
  isProviderExecutionPolicy,
  isProviderExecutionReport,
  type ImagePipelineRequest,
  type ImagePipelineResult,
  type PipelineConfig,
  type PipelineProgress,
  type ProviderExecutionPolicy,
} from '@shinobu/image-pipeline';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function config(): PipelineConfig {
  return {
    sourceLang: 'ja',
    targetLang: 'zh-CN',
    translator: 'llm',
    llmProvider: 'deepseek',
    llmAuthMode: 'api_key',
    llmBaseUrl: 'https://api.example.test',
    llmModel: 'example-model',
    typesetDebug: false,
    eraseDebug: false,
    collectDebugLog: false,
    ocrEngine: 'paddleocr_v6_medium',
    processMode: 'translate',
  };
}

function request(): ImagePipelineRequest {
  return {
    source: new Blob(['source'], { type: 'image/png' }),
    config: config(),
    workingCopy: {
      strategy: 'normalized',
      sourceSize: { width: 1600, height: 1200 },
      size: { width: 800, height: 600 },
      imageOrientation: 'from-image',
      background: '#ffffff',
    },
  };
}

function result(): ImagePipelineResult {
  return {
    status: 'completed',
    image: new Blob(['result'], { type: 'image/png' }),
    providerReports: [],
    record: {
      schemaVersion: 2,
      workingCopy: {
        width: 800,
        height: 600,
        spec: request().workingCopy,
        sourceToWorkingCopy: {
          kind: 'scale',
          scaleX: 0.5,
          scaleY: 0.5,
        },
      },
      ocr: [],
      translations: [],
    },
  };
}

describe('image pipeline runtime contract', () => {
  it('prepares once, publishes structured progress, finalizes, and releases artifacts', async () => {
    const prepare = vi.fn(async () => undefined);
    const release = vi.fn();
    const runtime = new ImagePipelineRuntime({
      prepare,
      async execute(_request, context) {
        context.reportProgress({
          stage: 'detect',
          operation: 'detect-text',
          completed: 1,
          total: 1,
        });
        return { status: 'completed' as const, artifacts: { id: 'live' } };
      },
      finalize: vi.fn(async () => result()),
      release,
    });
    const progress: unknown[] = [];

    const first = runtime.run(request());
    first.progress((event) => progress.push(event));

    await expect(first.result).resolves.toEqual(result());
    expect(progress).toEqual([
      {
        stage: 'runtime-prepare',
        operation: 'prepare-runtime',
      },
      {
        stage: 'detect',
        operation: 'detect-text',
        completed: 1,
        total: 1,
      },
      {
        stage: 'finalize',
        operation: 'freeze-result',
      },
    ]);
    expect(release).toHaveBeenCalledOnce();

    await runtime.run(request()).result;
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('injects a versioned provider policy as an immutable runtime capability', async () => {
    const policy: ProviderExecutionPolicy = {
      schemaVersion: 1,
      contract: {
        id: 'test.detector-wasm-only',
        version: 3,
      },
      rules: [
        {
          model: 'detector',
          stage: 'detect',
          providers: ['wasm'],
        },
      ],
    };
    const loadModel = vi.fn(async () => ({ runtime: ['wasm'] as const }));
    const loadSession = vi.fn(async () => ({
      sessionId: 'test-detector',
      provider: 'wasm' as const,
      inputNames: ['images'],
      outputNames: ['output'],
    }));
    const observedCapabilities: unknown[] = [];
    const runtime = new ImagePipelineRuntime({
      capabilities: {
        providerExecution: {
          policy,
          modelSession: { loadModel, loadSession },
        },
      },
      async prepare(context) {
        observedCapabilities.push(context.capabilities);
      },
      async execute(_request, context) {
        observedCapabilities.push(context.capabilities);
        await context.capabilities.providerExecution?.modelSession.loadModel('detector');
        return { status: 'completed' as const, artifacts: { id: 'live' } };
      },
      finalize: async () => result(),
      release: vi.fn(),
    });
    policy.contract.version = 99;

    await runtime.run(request()).result;

    expect(observedCapabilities).toHaveLength(2);
    expect(observedCapabilities[0]).toEqual({
      providerExecution: {
        policy: expect.objectContaining({
          contract: {
            id: 'test.detector-wasm-only',
            version: 3,
          },
        }),
        modelSession: {
          loadModel: expect.any(Function),
          loadSession: expect.any(Function),
        },
      },
    });
    expect(observedCapabilities[1]).toBe(observedCapabilities[0]);
    expect(Object.isFrozen(observedCapabilities[0])).toBe(true);
    expect(loadModel).toHaveBeenCalledWith('detector');
  });

  it('rejects internally contradictory provider execution reports', () => {
    const baseReport = {
      schemaVersion: 1,
      contract: {
        id: 'test.detector-policy',
        version: 1,
      },
      model: 'detector',
      stage: 'detect',
      attempts: [
        {
          attempt: 1,
          provider: 'wasm',
          outcome: 'succeeded',
          reason: 'completed',
        },
      ],
      finalProvider: 'wasm',
      fallbackTrace: [],
      satisfied: true,
    } as const;

    expect(isProviderExecutionReport(baseReport)).toBe(true);
    expect(isProviderExecutionReport({
      ...baseReport,
      attempts: [{
        ...baseReport.attempts[0],
        outcome: 'unavailable',
        reason: 'completed',
      }],
      finalProvider: undefined,
      satisfied: false,
    })).toBe(false);
    expect(isProviderExecutionReport({
      ...baseReport,
      finalProvider: undefined,
      satisfied: false,
    })).toBe(false);
  });

  it('uses the canonical provider target definition for policies and reports', () => {
    expect(isProviderExecutionPolicy({
      schemaVersion: 1,
      contract: {
        id: 'test.detector-policy',
        version: 1,
      },
      rules: [{
        model: 'detector',
        stage: 'detect',
        providers: ['wasm'],
      }],
    })).toBe(true);
    expect(isProviderExecutionPolicy({
      schemaVersion: 1,
      contract: {
        id: 'test.invalid-target',
        version: 1,
      },
      rules: [{
        model: 'detector',
        stage: 'ocr',
        providers: ['wasm'],
      }],
    })).toBe(false);
    expect(isProviderExecutionReport({
      schemaVersion: 1,
      contract: {
        id: 'test.invalid-target',
        version: 1,
      },
      model: 'detector',
      stage: 'ocr',
      attempts: [],
      fallbackTrace: [],
      satisfied: false,
    })).toBe(false);
  });

  it('throws admission errors synchronously without creating a task', async () => {
    const execution = deferred<{
      status: 'completed';
      artifacts: { id: string };
    }>();
    const runtime = new ImagePipelineRuntime({
      execute: () => execution.promise,
      finalize: async () => result(),
      release: vi.fn(),
    });
    expect(() => runtime.run({
      ...request(),
      source: new Blob(),
    })).toThrowError(ImagePipelineAdmissionError);
    expect(() => runtime.run({
      ...request(),
      config: {
        ...config(),
        llmApiKey: 'must-not-cross-runtime-boundary',
      },
    } as ImagePipelineRequest)).toThrowError(
      expect.objectContaining({
        code: 'INVALID_REQUEST',
      }),
    );
    expect(() => runtime.run({
      ...request(),
      config: {
        ...config(),
        llmThinkingLevel: {} as never,
      },
    })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => runtime.run({
      ...request(),
      config: {
        ...config(),
        translationContext: {
          source: 'x_tweet',
          currentTweetText: 42,
        } as never,
      },
    })).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => runtime.run({
      ...request(),
      config: {
        ...config(),
        runtimeCapability: { apiKey: 'must-not-cross-runtime-boundary' },
      },
    } as ImagePipelineRequest)).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
    expect(() => runtime.run({
      ...request(),
      config: {
        ...config(),
        ocrCompactActiveBatch: false,
      },
    } as ImagePipelineRequest)).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
    expect(() => runtime.run({
      ...request(),
      workingCopy: {
        ...request().workingCopy,
        apiKey: 'must-not-persist',
      },
    } as unknown as ImagePipelineRequest)).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST' }),
    );
    const active = runtime.run(request());

    expect(() => runtime.run(request())).toThrowError(
      expect.objectContaining({
        name: 'ImagePipelineAdmissionError',
        code: 'RUNTIME_BUSY',
      }),
    );

    active.cancel({
      code: 'owner-ended',
      messageKey: 'pipeline.cancelled.ownerEnded',
      diagnosticSummary: 'test ended',
    });
    await expect(active.result).rejects.toBeInstanceOf(ImagePipelineCancelledError);
    execution.resolve({ status: 'completed', artifacts: { id: 'late' } });
    await runtime.dispose({ code: 'runtime-disposed' });

    expect(() => runtime.run(request())).toThrowError(
      expect.objectContaining({
        code: 'RUNTIME_CLOSED',
      }),
    );
  });

  it('settles cancellation once, suppresses late finalization, and still releases late artifacts', async () => {
    const execution = deferred<{
      status: 'completed';
      artifacts: { id: string };
    }>();
    const started = deferred<void>();
    const finalize = vi.fn(async () => result());
    const release = vi.fn();
    const runtime = new ImagePipelineRuntime({
      execute: () => {
        started.resolve();
        return execution.promise;
      },
      finalize,
      release,
    });
    const task = runtime.run(request());
    await started.promise;

    task.cancel({
      code: 'owner-ended',
      messageKey: 'pipeline.cancelled.ownerEnded',
      diagnosticSummary: 'content context closed',
    });

    await expect(task.result).rejects.toMatchObject({
      code: 'TASK_CANCELLED',
      reason: {
        code: 'owner-ended',
        messageKey: 'pipeline.cancelled.ownerEnded',
        diagnosticSummary: 'content context closed',
      },
    });
    execution.resolve({ status: 'completed', artifacts: { id: 'late' } });
    await runtime.dispose({ code: 'runtime-disposed' });

    expect(finalize).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith({
      status: 'completed',
      artifacts: { id: 'late' },
    });
  });

  it('releases a finalized result when cancellation wins during artifact cleanup', async () => {
    const releaseStarted = deferred<void>();
    const releaseFinished = deferred<void>();
    const releaseResult = vi.fn();
    const runtime = new ImagePipelineRuntime({
      async execute() {
        return {
          status: 'completed' as const,
          artifacts: { id: 'live' },
        };
      },
      finalize: async () => result(),
      async release() {
        releaseStarted.resolve();
        await releaseFinished.promise;
      },
      releaseResult,
    });
    const task = runtime.run(request());
    await releaseStarted.promise;

    task.cancel({
      code: 'owner-ended',
      messageKey: 'pipeline.cancelled.ownerEnded',
    });

    await expect(task.result).rejects.toBeInstanceOf(ImagePipelineCancelledError);
    releaseFinished.resolve();
    await runtime.whenIdle();
    expect(releaseResult).toHaveBeenCalledOnce();
    expect(releaseResult).toHaveBeenCalledWith(result());
  });

  it('does not prepare or execute when the owner cancels in the admission turn', async () => {
    const prepare = vi.fn(async () => undefined);
    const execute = vi.fn(async () => ({
      status: 'completed' as const,
      artifacts: { id: 'unused' },
    }));
    const runtime = new ImagePipelineRuntime({
      prepare,
      execute,
      finalize: async () => result(),
      release: vi.fn(),
    });
    const task = runtime.run(request());

    task.cancel({
      code: 'owner-ended',
      messageKey: 'pipeline.cancelled.ownerEnded',
    });

    await expect(task.result).rejects.toBeInstanceOf(
      ImagePipelineCancelledError,
    );
    await runtime.whenIdle();
    expect(prepare).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('releases partial failure artifacts produced while cancellation unwinds', async () => {
    const releaseFailure = vi.fn();
    const started = deferred<void>();
    const runtime = new ImagePipelineRuntime({
      execute: (_request, context) => new Promise<never>((_resolve, reject) => {
        started.resolve();
        context.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('stage unwound after abort'), {
            artifacts: { id: 'partial' },
          }));
        }, { once: true });
      }),
      finalize: async () => result(),
      release: vi.fn(),
      releaseFailure,
    });
    const task = runtime.run(request());
    await started.promise;

    task.cancel({
      code: 'owner-ended',
      messageKey: 'pipeline.cancelled.ownerEnded',
    });

    await expect(task.result).rejects.toBeInstanceOf(
      ImagePipelineCancelledError,
    );
    await runtime.whenIdle();
    expect(releaseFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        artifacts: { id: 'partial' },
      }),
    );
  });

  it('preserves a producer failure envelope without delegating classification to the host', async () => {
    const runtime = new ImagePipelineRuntime({
      async execute() {
        throw Object.assign(new Error('provider unavailable'), {
          failure: {
            code: 'TEXT_TRANSLATION_UNAVAILABLE',
            stage: 'translate',
            scope: 'runtime',
            retryable: true,
            messageKey: 'pipeline.failure.translationUnavailable',
            diagnostics: { message: 'provider unavailable' },
          },
        });
      },
      finalize: async () => result(),
      release: vi.fn(),
    });

    await expect(runtime.run(request()).result).rejects.toEqual(
      expect.objectContaining({
        name: 'ImagePipelineExecutionError',
        failure: {
          code: 'TEXT_TRANSLATION_UNAVAILABLE',
          stage: 'translate',
          scope: 'runtime',
          retryable: true,
          messageKey: 'pipeline.failure.translationUnavailable',
          diagnostics: { message: 'provider unavailable' },
        },
      }),
    );
    await expect(runtime.run(request()).result).rejects.toBeInstanceOf(
      ImagePipelineExecutionError,
    );
  });

  it('retries only a retryable operation twice and reports structured backoff progress', async () => {
    vi.useFakeTimers();
    try {
      const action = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('busy'), {
          status: 503,
          retryAfterMs: 750,
        }))
        .mockRejectedValueOnce(Object.assign(new Error('rate limited'), {
          status: 429,
          retryAfterMs: 1_500,
        }))
        .mockResolvedValue('translated');
      const runtime = new ImagePipelineRuntime({
        async execute(_request, context) {
          await context.runOperation(
            { stage: 'translate', operation: 'request-chat-completion' },
            action,
          );
          return {
            status: 'completed' as const,
            artifacts: { id: 'live' },
          };
        },
        finalize: async () => result(),
        release: vi.fn(),
      });
      const task = runtime.run(request());
      const progress: unknown[] = [];
      task.progress((event) => progress.push(event));

      await vi.runAllTimersAsync();
      await expect(task.result).resolves.toEqual(result());

      expect(action).toHaveBeenCalledTimes(3);
      expect(progress).toContainEqual({
        stage: 'translate',
        operation: 'request-chat-completion',
        retry: {
          attempt: 2,
          maxAttempts: 3,
          delayMs: 750,
        },
      });
      expect(progress).toContainEqual({
        stage: 'translate',
        operation: 'request-chat-completion',
        retry: {
          attempt: 3,
          maxAttempts: 3,
          delayMs: 1_500,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles exhausted operation retries as a non-retryable runtime failure', async () => {
    vi.useFakeTimers();
    try {
      const action = vi.fn(async () => {
        throw Object.assign(new Error('provider unavailable'), { status: 503 });
      });
      const runtime = new ImagePipelineRuntime({
        async execute(_request, context) {
          await context.runOperation(
            { stage: 'translate', operation: 'request-chat-completion' },
            action,
          );
          return {
            status: 'completed' as const,
            artifacts: { id: 'unused' },
          };
        },
        finalize: async () => result(),
        release: vi.fn(),
      });
      const task = runtime.run(request());
      const rejection = expect(task.result).rejects.toMatchObject({
        failure: {
          code: 'PIPELINE_OPERATION_RETRIES_EXHAUSTED',
          stage: 'translate',
          scope: 'runtime',
          retryable: false,
          messageKey: 'pipeline.failure.translationUnavailable',
          diagnostics: {
            operation: 'request-chat-completion',
            attempts: 3,
          },
        },
      });

      await vi.runAllTimersAsync();
      await rejection;
      expect(action).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a transport-classified network failure exactly twice', async () => {
    vi.useFakeTimers();
    try {
      const action = vi.fn()
        .mockRejectedValueOnce(Object.assign(new TypeError('Failed to fetch'), {
          retryable: true,
        }))
        .mockRejectedValueOnce(Object.assign(new TypeError('Failed to fetch'), {
          retryable: true,
        }))
        .mockResolvedValue('translated');
      const runtime = new ImagePipelineRuntime({
        async execute(_request, context) {
          await context.runOperation(
            { stage: 'translate', operation: 'request-chat-completion' },
            action,
          );
          return {
            status: 'completed' as const,
            artifacts: { id: 'network-recovered' },
          };
        },
        finalize: async () => result(),
        release: vi.fn(),
      });
      const task = runtime.run(request());

      await vi.runAllTimersAsync();
      await expect(task.result).resolves.toEqual(result());
      expect(action).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shares one 30 second automatic-wait budget across all operations', async () => {
    vi.useFakeTimers();
    try {
      const first = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('busy'), {
          retryable: true,
          retryAfterMs: 10_000,
        }))
        .mockRejectedValueOnce(Object.assign(new Error('busy'), {
          retryable: true,
          retryAfterMs: 10_000,
        }))
        .mockResolvedValue('first');
      const second = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error('busy'), {
          retryable: true,
          retryAfterMs: 10_000,
        }))
        .mockResolvedValue('second');
      const third = vi.fn().mockRejectedValue(Object.assign(new Error('busy'), {
        retryable: true,
        retryAfterMs: 10_000,
      }));
      const runtime = new ImagePipelineRuntime({
        async execute(_request, context) {
          await context.runOperation(
            { stage: 'translate', operation: 'first' },
            first,
          );
          await context.runOperation(
            { stage: 'translate', operation: 'second' },
            second,
          );
          await context.runOperation(
            { stage: 'translate', operation: 'third' },
            third,
          );
          return {
            status: 'completed' as const,
            artifacts: { id: 'unreachable' },
          };
        },
        finalize: async () => result(),
        release: vi.fn(),
      });
      const progress: PipelineProgress[] = [];
      const task = runtime.run(request());
      task.progress((event) => progress.push(event));
      const rejection = expect(task.result).rejects.toMatchObject({
        failure: {
          code: 'PIPELINE_OPERATION_RETRIES_EXHAUSTED',
          diagnostics: {
            operation: 'third',
            attempts: 1,
          },
        },
      });

      await vi.runAllTimersAsync();
      await rejection;
      expect(first).toHaveBeenCalledTimes(3);
      expect(second).toHaveBeenCalledTimes(2);
      expect(third).toHaveBeenCalledOnce();
      expect(progress.reduce(
        (total, event) => total + (event.retry?.delayMs ?? 0),
        0,
      )).toBe(30_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed to runtime scope without copying raw error text into diagnostics', async () => {
    const runtime = new ImagePipelineRuntime({
      async execute() {
        throw new Error('Authorization: Bearer must-not-leak');
      },
      finalize: async () => result(),
      release: vi.fn(),
    });

    const failure = await runtime.run(request()).result.catch((error) => error);
    expect(failure).toMatchObject({
      failure: {
        code: 'PIPELINE_EXECUTION_FAILED',
        scope: 'runtime',
        retryable: false,
        messageKey: 'pipeline.failure.execution',
        diagnostics: {
          name: 'Error',
        },
      },
    });
    expect(failure.failure.diagnostics).not.toHaveProperty('message');
    expect(failure.cause).toBeUndefined();
    expect(JSON.stringify(failure)).not.toContain('must-not-leak');
    await expect(runtime.whenIdle()).resolves.toBeUndefined();
  });

  it('preserves a producer-owned structured failure without adapter reclassification', async () => {
    const runtime = new ImagePipelineRuntime({
      async execute() {
        throw Object.assign(new Error('detector failed'), {
          failure: {
            code: 'PIPELINE_STAGE_FAILED',
            stage: 'detect',
            scope: 'runtime',
            retryable: false,
            messageKey: 'pipeline.failure.stage',
            diagnostics: { name: 'PipelineStageError' },
          },
        });
      },
      finalize: async () => result(),
      release: vi.fn(),
    });

    await expect(runtime.run(request()).result).rejects.toMatchObject({
      failure: {
        code: 'PIPELINE_STAGE_FAILED',
        stage: 'detect',
        scope: 'runtime',
        retryable: false,
        messageKey: 'pipeline.failure.stage',
        diagnostics: { name: 'PipelineStageError' },
      },
    });
  });

  it('reports output release failures as structured runtime failures', async () => {
    const releaseResult = vi.fn();
    const runtime = new ImagePipelineRuntime({
      async execute() {
        return {
          status: 'completed' as const,
          artifacts: { id: 'live' },
        };
      },
      finalize: async () => result(),
      release() {
        throw new Error('release implementation failed');
      },
      releaseResult,
    });

    await expect(runtime.run(request()).result).rejects.toMatchObject({
      failure: {
        code: 'PIPELINE_RESOURCE_RELEASE_FAILED',
        scope: 'runtime',
        retryable: false,
        messageKey: 'pipeline.failure.resourceRelease',
        diagnostics: {
          name: 'Error',
        },
      },
    });
    expect(releaseResult).toHaveBeenCalledOnce();
    expect(releaseResult).toHaveBeenCalledWith(result());
  });

  it('dispose closes admission, cancels active work, waits for cleanup, and releases runtime resources', async () => {
    const execution = deferred<{
      status: 'completed';
      artifacts: { id: string };
    }>();
    const started = deferred<void>();
    const releaseRuntime = vi.fn(async () => undefined);
    const release = vi.fn();
    const runtime = new ImagePipelineRuntime({
      execute: () => {
        started.resolve();
        return execution.promise;
      },
      finalize: async () => result(),
      release,
      dispose: releaseRuntime,
    });
    const task = runtime.run(request());
    await started.promise;
    const disposal = runtime.dispose({
      code: 'runtime-disposed',
      messageKey: 'pipeline.cancelled.runtimeDisposed',
      diagnosticSummary: 'page hidden',
    });

    await expect(task.result).rejects.toMatchObject({
      reason: {
        code: 'runtime-disposed',
        messageKey: 'pipeline.cancelled.runtimeDisposed',
        diagnosticSummary: 'page hidden',
      },
    });
    expect(releaseRuntime).not.toHaveBeenCalled();

    execution.resolve({ status: 'completed', artifacts: { id: 'late' } });
    await disposal;

    expect(release).toHaveBeenCalledOnce();
    expect(releaseRuntime).toHaveBeenCalledOnce();
  });
});
