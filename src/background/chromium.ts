import { requireExtensionApi } from '../shared/extensionRuntime';
import { initializeBackground } from './index';
import { ChromiumPipelineHostLifecycle } from './localPipeline/pipelineHostLifecycle';

const api = requireExtensionApi();
initializeBackground(new ChromiumPipelineHostLifecycle(api));
