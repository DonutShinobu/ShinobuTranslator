import { describe, expect, it, vi } from 'vitest';
import { PRODUCTION_PROVIDER_EXECUTION_POLICY } from '@shinobu/image-pipeline';

const mocks = vi.hoisted(() => ({
  getModel: vi.fn(async () => ({
    runtime: ['webgpu', 'webnn', 'wasm'] as const,
  })),
  getModelSession: vi.fn(async (
    _model: string,
    providers: readonly string[],
  ) => ({
    sessionId: `detector:${providers[0]}`,
    provider: providers[0],
    inputNames: ['images'],
    outputNames: ['output'],
  })),
}));

vi.mock('../../src/runtime/modelRegistry', () => ({
  getModel: mocks.getModel,
  getModelSession: mocks.getModelSession,
}));

import {
  createProductionProviderExecutionCapability,
} from '../../src/runtime/productionProviderExecution';

describe('production provider execution composition', () => {
  it('injects model metadata and provider sessions through an explicit capability port', async () => {
    const capability = createProductionProviderExecutionCapability();

    await expect(capability.modelSession.loadModel('detector')).resolves.toEqual({
      runtime: ['webgpu', 'webnn', 'wasm'],
    });
    await expect(capability.modelSession.loadSession(
      'detector',
      ['webnn'],
    )).resolves.toMatchObject({
      sessionId: 'detector:webnn',
      provider: 'webnn',
    });

    expect(capability.policy).toBe(PRODUCTION_PROVIDER_EXECUTION_POLICY);
    expect(mocks.getModel).toHaveBeenCalledWith('detector');
    expect(mocks.getModelSession).toHaveBeenCalledWith('detector', ['webnn']);
  });
});
