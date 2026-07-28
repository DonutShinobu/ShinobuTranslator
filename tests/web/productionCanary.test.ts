import { describe, expect, it, vi } from 'vitest';
import type { WebTranslatorCore } from '../../apps/web/src/runtime/webPipeline';
import { runSyntheticProductionCanary } from '../../apps/web/src/runtime/productionCanary';

function successfulCore(): {
  core: WebTranslatorCore;
  dispose: ReturnType<typeof vi.fn>;
  run: ReturnType<typeof vi.fn>;
} {
  const dispose = vi.fn();
  const run = vi.fn(() => {
    const controller = new AbortController();
    return {
      result: Promise.resolve({
        image: new Blob(['png'], { type: 'image/png' }),
        summary: {
          originalSize: { width: 512, height: 512 },
          stages: [],
        },
        record: {
          schemaVersion: 1 as const,
          image: { width: 512, height: 512 },
          ocr: [],
          translations: [],
        },
      }),
      signal: controller.signal,
      cancel: (reason?: unknown) => controller.abort(reason),
      progress: () => () => undefined,
    };
  });
  return {
    core: { run, dispose } as unknown as WebTranslatorCore,
    dispose,
    run,
  };
}

describe('synthetic production pipeline canary', () => {
  it('runs the real pipeline contract in erase mode and disposes its worker', async () => {
    const harness = successfulCore();
    await runSyntheticProductionCanary({
      dependencies: {
        createCore: () => harness.core,
        createInput: async () => ({
          file: {} as File,
          workingCopy: { width: 512, height: 512 },
        }),
      },
    });

    expect(harness.run).toHaveBeenCalledOnce();
    expect(harness.run.mock.calls[0][0].config.processMode).toBe('erase');
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it('fails closed on an invalid output and still disposes its worker', async () => {
    const harness = successfulCore();
    const controller = new AbortController();
    harness.run.mockImplementationOnce(() => ({
      result: Promise.resolve({
        image: new Blob([], { type: 'image/png' }),
        summary: { originalSize: { width: 512, height: 512 }, stages: [] },
        record: {
          schemaVersion: 1 as const,
          image: { width: 512, height: 512 },
          ocr: [],
          translations: [],
        },
      }),
      signal: controller.signal,
      cancel: (reason?: unknown) => controller.abort(reason),
      progress: () => () => undefined,
    }));

    await expect(runSyntheticProductionCanary({
      dependencies: {
        createCore: () => harness.core,
        createInput: async () => ({
          file: {} as File,
          workingCopy: { width: 512, height: 512 },
        }),
      },
    })).rejects.toThrow(/没有生成有效/u);
    expect(harness.dispose).toHaveBeenCalledOnce();
  });
});
