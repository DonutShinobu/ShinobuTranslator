import { getExtensionRuntime } from '../shared/extensionRuntime';
import { configureModelAssetSource } from '../runtime/modelRegistry';
import { createExtensionModelAssetSource } from '../runtime/modelSource';
import { browserPlatform } from '../runtime/browserPlatform';
import { registerTypesetFonts } from '../pipeline/typeset/fontRuntime';
import { PipelineHost } from './pipelineHost';

const runtime = getExtensionRuntime();
const getAssetUrl = runtime ? runtime.getURL.bind(runtime) : undefined;
if (getAssetUrl) {
  configureModelAssetSource(createExtensionModelAssetSource(getAssetUrl));
  registerTypesetFonts(browserPlatform, getAssetUrl);
}

const host = new PipelineHost();
host.connect();
