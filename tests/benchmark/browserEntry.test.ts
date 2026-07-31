import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProviderExecutionReport } from '@shinobu/image-pipeline';
import type {
  ShinobuBenchmarkWindow,
} from '../../src/benchmark/browserEntry';

const mocks = vi.hoisted(() => ({
  runPipeline: vi.fn(),
}));

vi.mock('../../src/pipeline/orchestrator', () => ({
  runPipeline: mocks.runPipeline,
}));

const fallbackReport: ProviderExecutionReport = {
  schemaVersion: 1,
  contract: {
    id: 'shinobu.webgpu-benchmark-provider-policy',
    version: 1,
  },
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
};

describe('browser benchmark provider contract', () => {
  beforeAll(async () => {
    vi.stubGlobal('window', {});
    await import('../../src/benchmark/browserEntry');
  });

  it('blocks the public pipeline result before comparison after strict fallback', async () => {
    mocks.runPipeline.mockResolvedValue({
      providerReports: [fallbackReport],
    });
    const api = (window as ShinobuBenchmarkWindow).__shinobuBenchmark__;

    await expect(api?.runPipeline(
      {} as File,
      {} as Parameters<NonNullable<typeof api>['runPipeline']>[1],
      vi.fn(),
    )).rejects.toMatchObject({
      code: 'PIPELINE_PROVIDER_CONTRACT_VIOLATED',
      verdict: {
        status: 'unsatisfied',
      },
    });
    expect(mocks.runPipeline).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({
        runtimeCapabilities: {
          providerExecution: expect.objectContaining({
            policy: expect.objectContaining({
              contract: {
                id: 'shinobu.webgpu-benchmark-provider-policy',
                version: 1,
              },
            }),
          }),
        },
      }),
    );
  });
});
