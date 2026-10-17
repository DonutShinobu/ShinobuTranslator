import { getExtensionRuntime } from '../shared/extensionRuntime';
import { browserPipelinePlatform } from '../shared/browserPipelinePlatform';
import { createExtensionModelRuntime } from '../shared/extensionModelRuntime';
import { PipelineHost } from './pipelineHost';
import { LOCAL_PIPELINE_MAX_CONCURRENT_JOBS } from '@shinobu/image-pipeline/protocol';

const runtime = getExtensionRuntime();
const getAssetUrl = runtime ? runtime.getURL.bind(runtime) : undefined;
const host = new PipelineHost(undefined, {
  modelRuntime: createExtensionModelRuntime(),
  platform: browserPipelinePlatform,
  fontSource: getAssetUrl,
  maxConcurrentJobs: LOCAL_PIPELINE_MAX_CONCURRENT_JOBS,
});
host.connect();
