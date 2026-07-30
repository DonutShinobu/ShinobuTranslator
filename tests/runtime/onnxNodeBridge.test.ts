import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
}));

vi.mock('onnxruntime-node', () => ({
  InferenceSession: {
    create: mocks.create,
  },
  Tensor: class Tensor {},
}));

describe('onnxNodeBridge session ownership', () => {
  beforeEach(() => {
    mocks.create.mockReset();
  });

  it('releases every provider-specific session when disposing a model', async () => {
    const releases = [vi.fn(), vi.fn()];
    mocks.create
      .mockResolvedValueOnce({
        inputNames: ['images'],
        outputNames: ['output'],
        release: releases[0],
      })
      .mockResolvedValueOnce({
        inputNames: ['images'],
        outputNames: ['output'],
        release: releases[1],
      });
    const bridge = await import('../../src/runtime/onnxNodeBridge');

    await bridge.createSession('detector', 'detector.onnx', ['cuda']);
    await bridge.createSession('detector', 'detector.onnx', ['cpu']);
    await bridge.disposeSession('detector');

    expect(releases[0]).toHaveBeenCalledOnce();
    expect(releases[1]).toHaveBeenCalledOnce();
  });
});
