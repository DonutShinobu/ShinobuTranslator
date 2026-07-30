import {
  PRODUCTION_PROVIDER_EXECUTION_POLICY,
  type ProviderExecutionCapability,
  type ProviderExecutionPolicy,
  type ProviderModelSessionPort,
} from '@shinobu/image-pipeline';
import {
  getModel,
  getModelSession,
} from './modelRegistry';
import {
  createProviderSessionResolver,
  type ProviderSessionResolver,
} from './providerExecution';

const productionModelSessionPort: ProviderModelSessionPort = Object.freeze({
  loadModel: (model) => getModel(model),
  loadSession: (model, providers) => getModelSession(model, [...providers]),
});

export function createProductionProviderExecutionCapability(
  policy: ProviderExecutionPolicy = PRODUCTION_PROVIDER_EXECUTION_POLICY,
): ProviderExecutionCapability {
  return {
    policy,
    modelSession: productionModelSessionPort,
  };
}

export function createProductionProviderSessionResolver(
  policy: ProviderExecutionPolicy = PRODUCTION_PROVIDER_EXECUTION_POLICY,
): ProviderSessionResolver {
  const capability = createProductionProviderExecutionCapability(policy);
  return createProviderSessionResolver({
    policy: capability.policy,
    loadModel: capability.modelSession.loadModel,
    loadSession: capability.modelSession.loadSession,
  });
}
