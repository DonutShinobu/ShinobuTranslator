import { describe, expect, it, vi } from 'vitest';
import type {
  ProviderExecutionModel,
  ProviderExecutionPolicy,
} from '@shinobu/image-pipeline';
import {
  createProviderSessionResolver,
  ProviderExecutionError,
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
  it('uses manifest production order and reports a successful fallback', async () => {
    const loadModel = vi.fn(async () => ({
      runtime: ['webgpu', 'webnn', 'wasm'] as const,
    }));
    const loadSession = vi.fn(async (
      _model: ProviderExecutionModel,
      providers: WorkerSessionHandle['provider'][],
    ) => {
      if (providers[0] === 'webgpu') throw new Error('adapter unavailable');
      return handle(providers[0]);
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
    expect(loadSession.mock.calls.map(([, providers]) => providers)).toEqual([
      ['webgpu'],
      ['webnn'],
    ]);
    expect(execution.report).toEqual({
      schemaVersion: 1,
      contract: {
        id: 'shinobu.production-provider-policy',
        version: 1,
      },
      model: 'detector',
      stage: 'detect',
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
    expect(loadSession).toHaveBeenCalledWith('detector', ['wasm']);
    expect(execution.report).toMatchObject({
      contract: policy.contract,
      finalProvider: 'wasm',
      satisfied: true,
    });
  });

  it('falls back after inference failure and records the stable reason instead of raw error text', async () => {
    const resolver = createProviderSessionResolver({
      loadModel: async () => ({
        runtime: ['webgpu', 'webnn', 'wasm'] as const,
      }),
      loadSession: async (_model, providers) => handle(providers[0]),
    });

    const execution = await resolver.execute({
      model: 'detector',
      stage: 'detect',
      run: async (session) => {
        if (session.provider === 'webgpu') {
          throw new Error('GPUDevice secret driver detail');
        }
        return session.provider;
      },
    });

    expect(execution.report.attempts[0]).toEqual({
      attempt: 1,
      provider: 'webgpu',
      outcome: 'failed',
      reason: 'execution-failed',
    });
    expect(execution.report.fallbackTrace[0]).toEqual({
      from: 'webgpu',
      to: 'webnn',
      reason: 'execution-failed',
    });
    expect(JSON.stringify(execution.report)).not.toContain('secret driver detail');
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
