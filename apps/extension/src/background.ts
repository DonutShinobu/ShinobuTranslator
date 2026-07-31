import {
  startBackground,
  startBackgroundPipelineHost,
} from '../../../src/background/index';
import {
  createTargetExtensionAdapter,
  createTargetPipelineHostLifecycle,
} from './capabilities/targetAdapter';

const adapter = createTargetExtensionAdapter();
const pipelineHostCapabilities = adapter.pipelineHost();
const pipelineHostLifecycle = createTargetPipelineHostLifecycle(
  (connection) => startBackgroundPipelineHost(
    pipelineHostCapabilities,
    connection,
  ),
);
startBackground(
  adapter.background(),
  pipelineHostLifecycle,
);
