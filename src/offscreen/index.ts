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
import { OffscreenPipelineHost } from './pipelineHost';

export function startOffscreenPipelineHost(
  capabilities: PipelineHostExtensionCapabilities,
  lifecycle: PipelineHostConnection,
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

  const host = new OffscreenPipelineHost(
    {
      providerExecution: createProductionProviderExecutionCapability(),
    },
    {
      lifecycle,
      translationTransport: createExtensionTextTranslationTransport(
        sendMessage,
      ),
      diagnosticMessageSender: sendMessage,
    },
  );
  host.connect();
  return host;
}
