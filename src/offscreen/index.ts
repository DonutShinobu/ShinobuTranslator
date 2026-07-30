import { getChromeApi } from '../shared/chrome';
import { configureModelAssetSource } from '../runtime/modelRegistry';
import { createExtensionModelAssetSource } from '../runtime/modelSource';
import { browserPlatform } from '../runtime/browserPlatform';
import { registerTypesetFonts } from '../pipeline/typeset/fontRuntime';
import {
  createProductionProviderExecutionCapability,
} from '../runtime/productionProviderExecution';
import { OffscreenPipelineHost } from './pipelineHost';

const getAssetUrl = getChromeApi()?.runtime?.getURL;
if (getAssetUrl) {
  configureModelAssetSource(createExtensionModelAssetSource(getAssetUrl));
  registerTypesetFonts(browserPlatform, getAssetUrl);
}

const host = new OffscreenPipelineHost({
  providerExecution: createProductionProviderExecutionCapability(),
});
host.connect();
