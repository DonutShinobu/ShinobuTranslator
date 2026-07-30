import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ProviderExecutionCapability,
  ProviderExecutionPolicy,
} from '@shinobu/image-pipeline';
import { resolveBenchmarkProviderExecutionCapability } from '../../src/benchmark/providerExecution';
import * as modelRegistry from '../../src/runtime/modelRegistry';

const policy: ProviderExecutionPolicy = {
  schemaVersion: 1,
  contract: {
    id: 'test.benchmark-provider-policy',
    version: 1,
  },
  rules: [{
    model: 'paddleocr_v6_medium_rec',
    stage: 'ocr',
    providers: ['wasm'],
  }],
};

describe('benchmark provider execution capability', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves a complete injected capability', () => {
    const capability: ProviderExecutionCapability = {
      policy,
      modelSession: {
        loadModel: async () => ({ runtime: ['wasm'] }),
        loadSession: async () => ({
          sessionId: 'injected:wasm',
          provider: 'wasm',
          inputNames: ['images'],
          outputNames: ['output'],
        }),
      },
    };

    const resolved = resolveBenchmarkProviderExecutionCapability(capability);

    expect(resolved.policy).toBe(capability.policy);
    expect(resolved.modelSession).toBe(capability.modelSession);
  });

  it('completes a serializable policy-only benchmark input', () => {
    const resolved = resolveBenchmarkProviderExecutionCapability({ policy });

    expect(resolved.policy).toBe(policy);
    expect(resolved.modelSession.loadModel).toBeTypeOf('function');
    expect(resolved.modelSession.loadSession).toBeTypeOf('function');
  });

  it('passes serializable graph-capture options through session creation', async () => {
    const loadSession = vi.spyOn(
      modelRegistry,
      'getModelSession',
    ).mockResolvedValue({
      sessionId: 'benchmark:wasm',
      provider: 'wasm',
      inputNames: ['images'],
      outputNames: ['output'],
    });
    const sessionOptions = {
      enableGraphCapture: true,
      preferredOutputLocation: 'gpu-buffer' as const,
      freeDimensionOverrides: {
        'DynamicDimension.0': 1,
        'DynamicDimension.1': 320,
      },
    };
    const resolved = resolveBenchmarkProviderExecutionCapability({
      policy,
      sessionOptionsByModel: {
        paddleocr_v6_medium_rec: sessionOptions,
      },
    });

    await resolved.modelSession.loadSession(
      'paddleocr_v6_medium_rec',
      'wasm',
    );

    expect(loadSession).toHaveBeenCalledWith(
      'paddleocr_v6_medium_rec',
      'wasm',
      sessionOptions,
    );
  });
});
