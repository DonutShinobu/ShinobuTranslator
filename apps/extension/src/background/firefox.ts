import { initializeBackground } from './index';
import { FirefoxPipelineHostLifecycle } from './localPipeline/firefoxPipelineHostLifecycle';
import { createInProcessPipelineHostDependencies } from './localPipeline/inProcessPipelineHostDependencies';

initializeBackground(new FirefoxPipelineHostLifecycle(
  createInProcessPipelineHostDependencies(),
));
