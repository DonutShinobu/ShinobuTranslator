import { initializeBackground } from '../../../src/background/index';
import { FirefoxPipelineHostLifecycle } from '../../../src/background/localPipeline/firefoxPipelineHostLifecycle';
import { createInProcessPipelineHostDependencies } from '../../../src/background/localPipeline/inProcessPipelineHostDependencies';

initializeBackground(new FirefoxPipelineHostLifecycle(
  createInProcessPipelineHostDependencies(),
));
