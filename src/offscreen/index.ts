import type {
  PipelineHostExtensionCapabilities,
} from '../../apps/extension/src/capabilities/contracts';
import type {
  PipelineHostConnection,
} from '../../apps/extension/src/pipelineHost/contracts';
import { createRuntimeMessageSender } from '../shared/messages';
import { configureModelAssetSource } from '../runtime/modelRegistry';
import { createExtensionModelAssetSource } from '../runtime/modelSource';
import { browserPlatform } from '../runtime/browserPlatform';
import { configureOrtAssetPath } from '../runtime/onnx';
import { configureOnnxWorkerBootstrap } from '../runtime/onnxWorkerBridge';
import { registerTypesetFonts } from '../pipeline/typeset/fontRuntime';
import {
  createProductionProviderExecutionCapability,
} from '../runtime/productionProviderExecution';
import {
  createExtensionTextTranslationTransport,
} from '../translators/transport';
import type {
  PipelineHostRuntimeComposition,
} from '../../apps/extension/src/pipelineHost/contracts';
import { OffscreenPipelineHost } from './pipelineHost';

export type {
  PipelineHostRuntimeComposition,
} from '../../apps/extension/src/pipelineHost/contracts';

export function startOffscreenPipelineHost(
  capabilities: PipelineHostExtensionCapabilities,
  lifecycle: PipelineHostConnection,
  composition: PipelineHostRuntimeComposition = {},
): OffscreenPipelineHost {
  const resourceUrl = capabilities.environment.resourceUrl;
  configureModelAssetSource(createExtensionModelAssetSource(resourceUrl));
  registerTypesetFonts(browserPlatform, resourceUrl);
  configureOrtAssetPath(resourceUrl('ort/'));
  configureOnnxWorkerBootstrap({
    scriptUrl: resourceUrl('onnxWorker.js'),
    ortPath: resourceUrl('ort/'),
    allowBlobFallback: false,
  });
  const sendMessage = createRuntimeMessageSender(capabilities.runtimeRequests);

  const productionProviderExecution =
    createProductionProviderExecutionCapability(composition.providerPolicy);
  const host = new OffscreenPipelineHost(
    {
      providerExecution: composition.providerExecutionTransform?.(
        productionProviderExecution,
      ) ?? productionProviderExecution,
    },
    {
      lifecycle,
      platform: browserPlatform,
      translationTransport: composition.translationTransport
        ?? createExtensionTextTranslationTransport(sendMessage),
      diagnosticMessageSender: sendMessage,
    },
  );
  host.connect();
  return host;
}
