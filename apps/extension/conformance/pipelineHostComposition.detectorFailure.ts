import type {
  ProviderExecutionCapability,
} from '@shinobu/image-pipeline';
import type {
  PipelineHostRuntimeComposition,
} from '../src/pipelineHost/contracts';
import {
  createConformancePipelineHostComposition,
} from './pipelineHostComposition';

export type ConformanceBarrierSink = (barrier: string) => void;

export type BarrierAwareProviderExecution = ProviderExecutionCapability & {
  setConformanceBarrierSink(sink: ConformanceBarrierSink): void;
};

export function createDetectorFailureProviderExecution(
  base: ProviderExecutionCapability,
  onBarrier: ConformanceBarrierSink = () => undefined,
): BarrierAwareProviderExecution {
  let barrierSink = onBarrier;
  return {
    policy: base.policy,
    setConformanceBarrierSink(sink) {
      barrierSink = sink;
    },
    modelSession: {
      loadModel: (model) => base.modelSession.loadModel(model),
      async loadSession(model, provider) {
        const session = await base.modelSession.loadSession(model, provider);
        if (model !== 'detector' || provider !== 'webgpu') return session;
        barrierSink('detector-webgpu-inference-failed');
        await base.modelSession.resetRuntime?.();
        return {
          ...session,
          sessionId: 'conformance-lost-detector-session',
        };
      },
      ...(base.modelSession.resetRuntime
        ? { resetRuntime: () => base.modelSession.resetRuntime!() }
        : {}),
    },
  };
}

export function createTargetPipelineHostComposition():
PipelineHostRuntimeComposition {
  const common = createConformancePipelineHostComposition();
  return {
    ...common,
    providerExecutionTransform: createDetectorFailureProviderExecution,
  };
}
