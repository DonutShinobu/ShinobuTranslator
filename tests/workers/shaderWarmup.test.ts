import { expect, it, vi } from 'vitest';
import { warmDeviceShaders } from '../../packages/model-runtime/src/workers/shaderWarmup';

it('warms at most four pipelines without blocking inference, persists descriptors and tolerates cache failures', async () => {
  vi.useFakeTimers();
  try {
    const shaders = Array.from({ length: 9 }, (_, i) => ({ code: `shader${i}`, entryPoint: 'main' }));
    const gates: (() => void)[] = [];
    let active = 0;
    let maxActive = 0;
    const pipeline = {} as GPUComputePipeline;
    const device = {
      lost: new Promise(() => {}),
      createShaderModule: vi.fn(() => ({})),
      createComputePipeline: vi.fn(() => pipeline),
      createComputePipelineAsync: vi.fn(async () => {
        maxActive = Math.max(maxActive, ++active);
        await new Promise<void>(resolve => gates.push(resolve));
        active--;
        if (gates.length === 5) throw new Error('compile failed');
        return pipeline;
      }),
    } as unknown as GPUDevice;
    const put = vi.fn();
    const cache = { match: async () => new Response(JSON.stringify({ key: 'test', shaders })), put } as unknown as Cache;
    warmDeviceShaders(device, Promise.resolve(cache), 'test');
    const module = device.createShaderModule({ code: 'real shader' });
    const descriptor = { layout: 'auto' as const, compute: { module, entryPoint: 'main' } };
    expect(device.createComputePipeline(descriptor)).toBe(pipeline);
    device.createComputePipeline(descriptor);
    await vi.advanceTimersByTimeAsync(500);
    expect(gates).toHaveLength(4);
    for (let i = 0; i < 9; i++) {
      gates[i]();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(maxActive).toBe(4);
    expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(9);
    expect(await put.mock.calls[0][1].json()).toEqual({ key: 'test', shaders: [{ code: 'real shader', entryPoint: 'main' }] });
    expect(put).toHaveBeenCalledTimes(1);

    for (const record of [{ key: 'old', shaders }, { key: 'test', shaders: [{ code: 42 }] }]) {
      warmDeviceShaders(device, Promise.resolve({ match: async () => new Response(JSON.stringify(record)) } as unknown as Cache), 'test');
      await vi.advanceTimersByTimeAsync(0);
      expect(device.createComputePipelineAsync).toHaveBeenCalledTimes(9);
    }
    warmDeviceShaders(device, Promise.resolve({ match: async () => { throw new Error('denied'); }, put: async () => { throw new Error('quota'); } } as unknown as Cache), 'test');
    const finalModule = device.createShaderModule({ code: 'fallback' });
    expect(device.createComputePipeline({ layout: 'auto', compute: { module: finalModule } })).toBe(pipeline);
    await vi.advanceTimersByTimeAsync(500);
  } finally {
    vi.useRealTimers();
  }
});
