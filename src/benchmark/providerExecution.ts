import type {
  ProviderExecutionCapability,
  ProviderExecutionModel,
  ProviderExecutionPolicy,
  ProviderModelSessionPort,
} from '@shinobu/image-pipeline';
import { createProductionProviderExecutionCapability } from '../runtime/productionProviderExecution';
import { getModel, getModelSession } from '../runtime/modelRegistry';
import type { OnnxSessionOptions } from '../runtime/onnxSessionOptions';

export type BenchmarkProviderExecutionInput = {
  policy: ProviderExecutionPolicy;
  modelSession?: ProviderModelSessionPort;
  sessionOptionsByModel?: Partial<
    Record<ProviderExecutionModel, OnnxSessionOptions>
  >;
};

export function resolveBenchmarkProviderExecutionCapability(
  input?: BenchmarkProviderExecutionInput,
): ProviderExecutionCapability {
  if (input?.modelSession) {
    return {
      policy: input.policy,
      modelSession: input.modelSession,
    };
  }
  if (input?.sessionOptionsByModel) {
    return {
      policy: input.policy,
      modelSession: {
        loadModel: (model) => getModel(model),
        loadSession: (model, providers) => getModelSession(
          model,
          [...providers],
          input.sessionOptionsByModel?.[model],
        ),
      },
    };
  }
  return createProductionProviderExecutionCapability(input?.policy);
}
