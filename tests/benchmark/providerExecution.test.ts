import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ProviderExecutionCapability,
  ProviderExecutionPolicy,
  ProviderExecutionReport,
} from '@shinobu/image-pipeline';
import {
  assertWebGpuBenchmarkExecution,
  evaluateWebGpuBenchmarkExecution,
  resolveBenchmarkProviderExecutionCapability,
  WEBGPU_BENCHMARK_PROVIDER_EXECUTION_POLICY,
  WebGpuBenchmarkContractError,
} from '../../src/benchmark/providerExecution';
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

  it('defines a WebGPU-only rule for every pipeline model stage', () => {
    expect(WEBGPU_BENCHMARK_PROVIDER_EXECUTION_POLICY).toEqual({
      schemaVersion: 1,
      contract: {
        id: 'shinobu.webgpu-benchmark-provider-policy',
        version: 1,
      },
      rules: [
        { model: 'detector', stage: 'detect', providers: ['webgpu'] },
        { model: 'bubble', stage: 'bubble', providers: ['webgpu'] },
        {
          model: 'paddleocr_v6_medium_rec',
          stage: 'ocr',
          providers: ['webgpu'],
        },
        { model: 'inpaint', stage: 'inpaint', providers: ['webgpu'] },
      ],
    });
  });

  it('accepts reports for reached stages only when every attempt stays on WebGPU', () => {
    const reports: ProviderExecutionReport[] = [{
      schemaVersion: 1,
      contract: WEBGPU_BENCHMARK_PROVIDER_EXECUTION_POLICY.contract,
      model: 'detector',
      stage: 'detect',
      requiredProviders: ['webgpu'],
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
          outcome: 'succeeded',
          reason: 'completed',
        },
      ],
      finalProvider: 'webgpu',
      fallbackTrace: [],
      satisfied: true,
    }];

    expect(evaluateWebGpuBenchmarkExecution(reports)).toEqual({
      status: 'satisfied',
      violations: [],
    });
    expect(() => assertWebGpuBenchmarkExecution(reports)).not.toThrow();
  });

  it('returns unsatisfied and blocks comparison when a report contains fallback', () => {
    const reports: ProviderExecutionReport[] = [{
      schemaVersion: 1,
      contract: WEBGPU_BENCHMARK_PROVIDER_EXECUTION_POLICY.contract,
      model: 'detector',
      stage: 'detect',
      requiredProviders: ['webgpu', 'wasm'],
      attempts: [
        {
          attempt: 1,
          provider: 'webgpu',
          outcome: 'unavailable',
          reason: 'session-unavailable',
        },
        {
          attempt: 2,
          provider: 'wasm',
          outcome: 'succeeded',
          reason: 'completed',
        },
      ],
      finalProvider: 'wasm',
      fallbackTrace: [{
        from: 'webgpu',
        to: 'wasm',
        reason: 'session-unavailable',
      }],
      satisfied: true,
    }];

    expect(evaluateWebGpuBenchmarkExecution(reports)).toMatchObject({
      status: 'unsatisfied',
      violations: expect.arrayContaining([
        expect.objectContaining({
          model: 'detector',
          stage: 'detect',
          reason: 'non-webgpu-attempt',
        }),
        expect.objectContaining({
          model: 'detector',
          stage: 'detect',
          reason: 'fallback-attempted',
        }),
      ]),
    });
    expect(() => assertWebGpuBenchmarkExecution(reports))
      .toThrow(WebGpuBenchmarkContractError);
  });

  it('rejects a same-provider retry that was not caused by session loss', () => {
    const reports: ProviderExecutionReport[] = [{
      schemaVersion: 1,
      contract: WEBGPU_BENCHMARK_PROVIDER_EXECUTION_POLICY.contract,
      model: 'detector',
      stage: 'detect',
      requiredProviders: ['webgpu'],
      attempts: [
        {
          attempt: 1,
          provider: 'webgpu',
          outcome: 'failed',
          reason: 'execution-failed',
        },
        {
          attempt: 2,
          provider: 'webgpu',
          outcome: 'succeeded',
          reason: 'completed',
        },
      ],
      finalProvider: 'webgpu',
      fallbackTrace: [],
      satisfied: true,
    }];

    expect(evaluateWebGpuBenchmarkExecution(reports)).toMatchObject({
      status: 'unsatisfied',
      violations: [{
        model: 'detector',
        stage: 'detect',
        reason: 'non-recoverable-retry',
      }],
    });
  });
});
