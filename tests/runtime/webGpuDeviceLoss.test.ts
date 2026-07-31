import { describe, expect, it } from 'vitest';
import {
  classifyWebGpuInferenceFailure,
  observeWebGpuDeviceLoss,
  WebGpuSessionLostSignal,
  withWebGpuDeviceLoss,
} from '../../src/runtime/webGpuDeviceLoss';

describe('WebGPU device-loss boundary', () => {
  it('turns GPUDevice.lost into a stable session-loss signal', async () => {
    let loseDevice: (() => void) | undefined;
    const lost = new Promise<void>((resolve) => {
      loseDevice = resolve;
    });
    const monitor = observeWebGpuDeviceLoss({
      lost,
    });
    const operation = withWebGpuDeviceLoss(
      monitor,
      () => new Promise<never>(() => undefined),
    );

    loseDevice?.();

    await expect(operation).rejects.toBeInstanceOf(WebGpuSessionLostSignal);
    expect(classifyWebGpuInferenceFailure(
      monitor,
      new Error('opaque driver text'),
    )).toBe('session-lost');
  });

  it('does not classify raw error text as device loss', () => {
    expect(classifyWebGpuInferenceFailure(
      undefined,
      new Error('GPU device lost'),
    )).toBe('execution-failed');
  });
});
