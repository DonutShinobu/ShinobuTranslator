import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderExecutionPolicy } from '@shinobu/image-pipeline';

const mocks = vi.hoisted(() => ({
  createSession: vi.fn(),
  disposeAll: vi.fn(async () => undefined),
  disposeSession: vi.fn(async () => undefined),
}));

vi.mock('../../src/runtime/onnxBridge', () => ({
  createSession: mocks.createSession,
  disposeAll: mocks.disposeAll,
  disposeSession: mocks.disposeSession,
}));

const policy: ProviderExecutionPolicy = {
  schemaVersion: 1,
  contract: {
    id: 'test.production-provider-contract',
    version: 1,
  },
  rules: [
    {
      model: 'detector',
      stage: 'detect',
      providers: ['webgpu', 'wasm'],
    },
  ],
};

describe('production provider contract composition', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.createSession.mockReset();
    mocks.disposeAll.mockClear();
    mocks.disposeSession.mockReset();
    mocks.disposeSession.mockResolvedValue(undefined);
  });

  it('resets the shared ONNX runtime before rebuilding a lost WebGPU session', async () => {
    const {
      createProductionProviderExecutionCapability,
    } = await import('../../src/runtime/productionProviderExecution');
    const capability = createProductionProviderExecutionCapability(policy);

    await capability.modelSession.resetRuntime?.();

    expect(mocks.disposeAll).toHaveBeenCalledOnce();
  });

  it('fails closed when the bridge substitutes a different provider', async () => {
    mocks.createSession.mockResolvedValue({
      sessionId: 'wrong-provider-session',
      provider: 'wasm',
      inputNames: ['images'],
      outputNames: ['output'],
    });
    const {
      createProductionProviderSessionResolver,
    } = await import('../../src/runtime/productionProviderExecution');

    const error = await createProductionProviderSessionResolver(policy)
      .execute({
        model: 'detector',
        stage: 'detect',
        run: async () => 'unreachable',
      })
      .then(() => null, (reason: unknown) => reason);

    expect(error).toMatchObject({
      name: 'ProviderExecutionError',
      message: 'pipeline.failure.providerContract',
      failure: {
        code: 'PIPELINE_PROVIDER_CONTRACT_VIOLATED',
        stage: 'detect',
        scope: 'runtime',
        retryable: false,
        messageKey: 'pipeline.failure.providerContract',
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
        fallbackTrace: [],
        finalProvider: undefined,
        satisfied: false,
      },
    });
    expect(mocks.disposeSession).toHaveBeenCalledWith(
      'wrong-provider-session',
    );
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledWith(
      'detector',
      expect.any(String),
      'webgpu',
      undefined,
    );
  });

  it('fails closed with a redacted cause when mismatched-session cleanup rejects', async () => {
    mocks.createSession.mockResolvedValue({
      sessionId: 'mismatched-provider-session',
      provider: 'wasm',
      inputNames: ['images'],
      outputNames: ['output'],
    });
    mocks.disposeSession.mockRejectedValueOnce(
      new Error('private GPU worker cleanup detail'),
    );
    const {
      createProductionProviderSessionResolver,
    } = await import('../../src/runtime/productionProviderExecution');

    const error = await createProductionProviderSessionResolver(policy)
      .execute({
        model: 'detector',
        stage: 'detect',
        run: async () => 'unreachable',
      })
      .then(() => null, (reason: unknown) => reason) as Error & {
        cause?: Error & {
          cause?: unknown;
          code?: string;
          reason?: string;
        };
        failure?: unknown;
        report?: unknown;
      };

    expect(error).toMatchObject({
      name: 'ProviderExecutionError',
      message: 'pipeline.failure.providerContract',
      failure: {
        code: 'PIPELINE_PROVIDER_CONTRACT_VIOLATED',
        stage: 'detect',
        scope: 'runtime',
        retryable: false,
        messageKey: 'pipeline.failure.providerContract',
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
        fallbackTrace: [],
        finalProvider: undefined,
        satisfied: false,
      },
      cause: {
        name: 'ProviderSessionContractError',
        message: 'pipeline.failure.providerContract',
        code: 'PIPELINE_PROVIDER_CONTRACT_VIOLATED',
        reason: 'contract-violated',
        cause: {
          requestedProvider: 'webgpu',
          actualProvider: 'wasm',
          cleanup: 'failed',
          recovery: 'runtime-reset',
        },
      },
    });
    expect(mocks.disposeSession).toHaveBeenCalledWith(
      'mismatched-provider-session',
    );
    expect(mocks.disposeAll).toHaveBeenCalledTimes(1);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.failure)).not.toContain(
      'private GPU worker cleanup detail',
    );
    expect(String(error.cause)).not.toContain(
      'private GPU worker cleanup detail',
    );
  });
});
