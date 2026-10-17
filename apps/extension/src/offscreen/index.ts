import { getExtensionRuntime } from '../shared/extensionRuntime';
import { browserPipelinePlatform } from '../shared/browserPipelinePlatform';
import { createExtensionModelRuntime } from '../shared/extensionModelRuntime';
import { PipelineHost } from './pipelineHost';

const runtime = getExtensionRuntime();
const getAssetUrl = runtime ? runtime.getURL.bind(runtime) : undefined;
const host = new PipelineHost(undefined, {
  modelRuntime: createExtensionModelRuntime(),
  platform: browserPipelinePlatform,
  fontSource: getAssetUrl,
});
host.connect();
