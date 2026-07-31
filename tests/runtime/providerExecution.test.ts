import { describe, expect, it, vi } from 'vitest';
import type {
  ProviderExecutionModel,
  ProviderExecutionPolicy,
  ProviderRuntime,
} from '@shinobu/image-pipeline';
import {
  createProviderSessionResolver,
  ProviderExecutionError,
  ProviderSessionLostError,
  type ProviderExecutionRequest,
} from '../../src/runtime/providerExecution';
import type { WorkerSessionHandle } from '../../src/runtime/onnxWorkerTypes';

function handle(provider: WorkerSessionHandle['provider']): WorkerSessionHandle {
  return {
    sessionId: `${provider}-detector`,
    provider,
    inputNames: ['images'],
    outputNames: ['output'],
  };
}

describe('provider session resolver contract', () => {
  it('requires an explicit model/session port instead of using runtime globals', () => {
    expect(() => createProviderSessionResolver({
      policy: {
        schemaVersion: 1,
        contract: {
          id: 'test.explicit-port',
          version: 1,
        },
        rules: [],
      },
    } as unknown as Parameters<typeof createProviderSessionResolver>[0]))
      .toThrow('Provider model/session capability is required');
  });

  it('rejects a non-canonical model/stage target before using the port', async () => {
    const loadModel = vi.fn(async () => ({ runtime: ['wasm'] as const }));
    const loadSession = vi.fn(async () => handle('wasm'));
    const resolver = createProviderSessionResolver({
      loadModel,
      loadSession,
    });

    await expect(resolver.execute({
      model: 'detector',
      stage: 'ocr',
      run: async () => 'unreachable',
    } as unknown as ProviderExecutionRequest<string>))
      .rejects.toThrow('Provider execution target is invalid');
    expect(loadModel).not.toHaveBeenCalled();
    expect(loadSession).not.toHaveBeenCalled();
  });

  it('uses manifest production order and reports a successful fallback', async () => {
    const loadModel = vi.fn(async () => ({
      runtime: ['webgpu', 'webnn', 'wasm'] as const,
    }));
    const loadSession = vi.fn(async (
      _model: ProviderExecutionModel,
      provider: ProviderRuntime,
    ) => {
      if (provider === 'webgpu') throw new Error('adapter unavailable');
      return handle(provider);
    });
    const resolver = createProviderSessionResolver({
      loadModel,
      loadSession,
    });

    const execution = await resolver.execute({
      model: 'detector',
      stage: 'detect',
      run: async (session) => session.provider,
    });

    expect(execution.value).toBe('webnn');
    expect(loadModel).toHaveBeenCalledWith('detector');
    expect(loadSession.mock.calls.map(([, provider]) => provider)).toEqual([
      'webgpu',
      'webnn',
    ]);
    expect(execution.report).toEqual({
      schemaVersion: 1,
      contract: {
        id: 'shinobu.production-provider-policy',
        version: 1,
      },
      model: 'detector',
      stage: 'detect',
      requiredProviders: ['webgpu', 'webnn', 'wasm'],
      attempts: [
        {
          attempt: 1,
          provider: 'webgpu',
          outcome: 'unavailable',
          reason: 'session-unavailable',
        },
        {
          attempt: 2,
          provider: 'webnn',
          outcome: 'succeeded',
          reason: 'completed',
        },
      ],
      finalProvider: 'webnn',
      fallbackTrace: [
        {
          from: 'webgpu',
          to: 'webnn',
          reason: 'session-unavailable',
        },
      ],
      satisfied: true,
    });
  });

  it('preloads through the explicit port and carries session fallback into execution', async () => {
    const loadModel = vi.fn(async () => ({
      runtime: ['webgpu', 'webnn', 'wasm'] as const,
    }));
    const loadSession = vi.fn(async (
      _model: ProviderExecutionModel,
      provider: ProviderRuntime,
    ) => {
      if (provider === 'webgpu') throw new Error('adapter unavailable');
      return handle(provider);
    });
    const resolver = createProviderSessionResolver({
      loadModel,
      loadSession,
    });

    await expect(resolver.preload({
      model: 'detector',
      stage: 'detect',
    })).resolves.toMatchObject({
      provider: 'webnn',
    });
    const execution = await resolver.execute({
      model: 'detector',
      stage: 'detect',
      run: async (session) => session.provider,
    });

    expect(loadModel).toHaveBeenCalledOnce();
    expect(loadSession.mock.calls.map(([, provider]) => provider)).toEqual([
      'webgpu',
      'webnn',
    ]);
    expect(execution.value).toBe('webnn');
    expect(execution.report).toMatchObject({
      attempts: [
        {
          attempt: 1,
          provider: 'webgpu',
          outcome: 'unavailable',
          reason: 'session-unavailable',
        },
        {
          attempt: 2,
          provider: 'webnn',
          outcome: 'succeeded',
          reason: 'completed',
        },
      ],
      finalProvider: 'webnn',
      satisfied: true,
    });
  });

  it('uses an explicitly injected versioned policy without consulting manifest defaults', async () => {
    const policy: ProviderExecutionPolicy = {
      schemaVersion: 1,
      contract: {
        id: 'test.detector-wasm-only',
        version: 7,
      },
      rules: [
        {
          model: 'detector',
          stage: 'detect',
          providers: ['wasm'],
        },
      ],
    };
    const loadModel = vi.fn();
    const loadSession = vi.fn(async () => handle('wasm'));
    const resolver = createProviderSessionResolver({
      policy,
      loadModel,
      loadSession,
    });

    const execution = await resolver.execute({
      model: 'detector',
      stage: 'detect',
      run: async (session) => session.provider,
    });

    expect(execution.value).toBe('wasm');
    expect(loadModel).not.toHaveBeenCalled();
    expect(loadSession).toHaveBeenCalledWith('detector', 'wasm');
    expect(execution.report).toMatchObject({
      contract: policy.contract,
      finalProvider: 'wasm',
      satisfied: true,
    });
  });

  it('fails detector execution immediately without trying another provider', async () => {
    const loadSession = vi.fn(async (_model, provider) => handle(provider));
    const resolver = createProviderSessionResolver({
      loadModel: async () => ({
        runtime: ['webgpu', 'webnn', 'wasm'] as const,
      }),
      loadSession,
    });

    const error = await resolver.execute({
      model: 'detector',
      stage: 'detect',
      run: async () => {
        throw new Error('GPUDevice secret driver detail');
      },
    }).then(() => null, (reason: unknown) => reason);

    expect(loadSession.mock.calls).toEqual([['detector', 'webgpu']]);
    expect(error).toBeInstanceOf(ProviderExecutionError);
    expect(error).toMatchObject({
      failure: {
        code: 'PIPELINE_PROVIDER_EXECUTION_FAILED',
        stage: 'detect',
        scope: 'runtime',
        retryable: false,
        messageKey: 'pipeline.failure.providerExecution',
      },
      report: {
        attempts: [{
          attempt: 1,
          provider: 'webgpu',
          outcome: 'failed',
          reason: 'execution-failed',
        }],
        fallbackTrace: [],
        finalProvider: undefined,
        satisfied: false,
      },
    });
    expect(JSON.stringify((error as ProviderExecutionError).failure))
      .not.toContain('secret driver detail');
  });

  it('rebuilds a lost WebGPU session within the retry budget without recording fallback', async () => {
    let generation = 0;
    const loadSession = vi.fn(async () => ({
      ...handle('webgpu'),
      sessionId: `webgpu-detector-${generation += 1}`,
    }));
    const resetRuntime = vi.fn(async () => undefined);
    const resolver = createProviderSessionResolver({
      policy: {
        schemaVersion: 1,
        contract: {
          id: 'test.webgpu-only',
          version: 1,
        },
        rules: [{
          model: 'detector',
          stage: 'detect',
          providers: ['webgpu'],
        }],
      },
      loadModel: vi.fn(),
      loadSession,
      resetRuntime,
    });
    let runs = 0;

    const execution = await resolver.execute({
      model: 'detector',
      stage: 'detect',
      run: async (session) => {
        runs += 1;
        if (runs < 3) {
          throw new ProviderSessionLostError('redacted device loss detail');
        }
        return session.sessionId;
      },
    });

    expect(execution.value).toBe('webgpu-detector-3');
    expect(loadSession).toHaveBeenCalledTimes(3);
    expect(resetRuntime).toHaveBeenCalledTimes(2);
    expect(execution.report).toMatchObject({
      finalProvider: 'webgpu',
      fallbackTrace: [],
      satisfied: true,
      attempts: [
        {
          attempt: 1,
          provider: 'webgpu',
          outcome: 'failed',
          reason: 'session-lost',
        },
        {
          attempt: 2,
          provider: 'webgpu',
          outcome: 'failed',
          reason: 'session-lost',
        },
        {
          attempt: 3,
          provider: 'webgpu',
          outcome: 'succeeded',
          reason: 'completed',
        },
      ],
    });
  });

  it('fails WebGPU execution after the session-loss retry budget is exhausted', async () => {
    const resetRuntime = vi.fn(async () => undefined);
    const resolver = createProviderSessionResolver({
      policy: {
        schemaVersion: 1,
        contract: {
          id: 'test.webgpu-only',
          version: 1,
        },
        rules: [{
          model: 'detector',
          stage: 'detect',
          providers: ['webgpu'],
        }],
      },
      loadModel: vi.fn(),
      loadSession: async () => handle('webgpu'),
      resetRuntime,
    });

    const error = await resolver.execute({
      model: 'detector',
      stage: 'detect',
      run: async () => {
        throw new ProviderSessionLostError('redacted device loss detail');
      },
    }).then(() => null, (reason: unknown) => reason);

    expect(resetRuntime).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({
      failure: {
        code: 'PIPELINE_PROVIDER_EXECUTION_FAILED',
      },
      report: {
        fallbackTrace: [],
        satisfied: false,
        attempts: [
          {
            attempt: 1,
            provider: 'webgpu',
            outcome: 'failed',
            reason: 'session-lost',
          },
          {
            attempt: 2,
            provider: 'webgpu',
            outcome: 'failed',
            reason: 'session-lost',
          },
          {
            attempt: 3,
            provider: 'webgpu',
            outcome: 'failed',
            reason: 'session-lost',
          },
        ],
      },
    });
    expect(JSON.stringify((error as ProviderExecutionError).failure))
      .not.toContain('redacted device loss detail');
  });

  it('caps WebGPU session recovery at the shared 30 second wait budget', async () => {
    vi.useFakeTimers();
    try {
      const resetRuntime = vi.fn(() => new Promise<void>(() => undefined));
      const resolver = createProviderSessionResolver({
        policy: {
          schemaVersion: 1,
          contract: {
            id: 'test.webgpu-only',
            version: 1,
          },
          rules: [{
            model: 'detector',
            stage: 'detect',
            providers: ['webgpu'],
          }],
        },
        loadModel: vi.fn(),
        loadSession: async () => handle('webgpu'),
        resetRuntime,
      });

      const execution = resolver.execute({
        model: 'detector',
        stage: 'detect',
        run: async () => {
          throw new ProviderSessionLostError();
        },
      }).then(() => null, (reason: unknown) => reason);

      await vi.advanceTimersByTimeAsync(30_001);
      const error = await execution;

      expect(resetRuntime).toHaveBeenCalledOnce();
      expect(error).toMatchObject({
        failure: {
          code: 'PIPELINE_PROVIDER_EXECUTION_FAILED',
        },
        report: {
          requiredProviders: ['webgpu'],
          attempts: [{
            attempt: 1,
            provider: 'webgpu',
            outcome: 'failed',
            reason: 'session-lost',
          }],
          satisfied: false,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed with an unsatisfied report when every provider is unavailable', async () => {
    const resolver = createProviderSessionResolver({
      loadModel: async () => ({
        runtime: ['webgpu', 'wasm'] as const,
      }),
      loadSession: async () => {
        throw new Error('session unavailable');
      },
    });

    const error = await resolver.execute({
      model: 'detector',
      stage: 'detect',
      run: async () => 'unreachable',
    }).then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProviderExecutionError);
    expect(error).toMatchObject({
      failure: {
        code: 'PIPELINE_PROVIDER_UNAVAILABLE',
        stage: 'detect',
        scope: 'runtime',
        retryable: false,
      },
      report: {
        finalProvider: undefined,
        satisfied: false,
      },
    });
  });

  it('reports manifest metadata failures as a contract violation without leaking details', async () => {
    const resolver = createProviderSessionResolver({
      loadModel: async () => {
        throw new Error('private manifest storage detail');
      },
      loadSession: vi.fn(),
    });

    const error = await resolver.execute({
      model: 'detector',
      stage: 'detect',
      run: async () => 'unreachable',
    }).then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProviderExecutionError);
    expect(error).toMatchObject({
      failure: {
        code: 'PIPELINE_PROVIDER_CONTRACT_VIOLATED',
      },
      report: {
        attempts: [],
        satisfied: false,
      },
    });
    expect(JSON.stringify((error as ProviderExecutionError).failure))
      .not.toContain('private manifest storage detail');
  });

  it('rejects malformed runtime policy rules instead of silently using manifest defaults', () => {
    expect(() => createProviderSessionResolver({
      policy: {
        schemaVersion: 1,
        contract: {
          id: 'test.misspelled-policy',
          version: 1,
        },
        rules: [
          {
            model: 'detctor',
            stage: 'detect',
            providers: ['wasm'],
          },
        ],
      } as unknown as ProviderExecutionPolicy,
      loadModel: vi.fn(),
      loadSession: vi.fn(),
    })).toThrowError(TypeError);
  });

  it('rejects a session that silently violates the requested provider contract', async () => {
    const policy: ProviderExecutionPolicy = {
      schemaVersion: 1,
      contract: {
        id: 'test.detector-webgpu-only',
        version: 1,
      },
      rules: [
        {
          model: 'detector',
          stage: 'detect',
          providers: ['webgpu'],
        },
      ],
    };
    const resolver = createProviderSessionResolver({
      policy,
      loadModel: vi.fn(),
      loadSession: async () => handle('wasm'),
    });

    const error = await resolver.execute({
      model: 'detector',
      stage: 'detect',
      run: async () => 'unreachable',
    }).then(() => null, (reason: unknown) => reason);

    expect(error).toBeInstanceOf(ProviderExecutionError);
    expect(error).toMatchObject({
      failure: {
        code: 'PIPELINE_PROVIDER_CONTRACT_VIOLATED',
      },
      report: {
        attempts: [
          {
            attempt: 1,
            provider: 'webgpu',
            outcome: 'failed',
            reason: 'contract-violated',
          },
        ],
        satisfied: false,
      },
    });
  });
});
