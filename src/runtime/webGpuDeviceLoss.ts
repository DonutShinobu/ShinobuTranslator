export type WebGpuDeviceLoss = {
  lost: boolean;
  signal: Promise<void>;
};

export class WebGpuSessionLostSignal extends Error {
  constructor() {
    super('pipeline.failure.providerSessionLost');
    this.name = 'WebGpuSessionLostSignal';
  }
}

export function observeWebGpuDeviceLoss(
  device: { lost: Promise<unknown> } | undefined,
): WebGpuDeviceLoss | undefined {
  if (!device) return undefined;
  const state: WebGpuDeviceLoss = {
    lost: false,
    signal: Promise.resolve(),
  };
  state.signal = device.lost.then(() => {
    state.lost = true;
  });
  return state;
}

export async function withWebGpuDeviceLoss<T>(
  deviceLoss: WebGpuDeviceLoss | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!deviceLoss) return operation();
  if (deviceLoss.lost) throw new WebGpuSessionLostSignal();
  return Promise.race([
    operation(),
    deviceLoss.signal.then(() => {
      throw new WebGpuSessionLostSignal();
    }),
  ]);
}

export function classifyWebGpuInferenceFailure(
  deviceLoss: WebGpuDeviceLoss | undefined,
  error: unknown,
): 'session-lost' | 'execution-failed' {
  return error instanceof WebGpuSessionLostSignal || deviceLoss?.lost
    ? 'session-lost'
    : 'execution-failed';
}
