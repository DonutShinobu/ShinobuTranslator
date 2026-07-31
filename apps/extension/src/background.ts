import {
  startBackground,
  startBackgroundPipelineHost,
} from '../../../src/background/index';
import {
  createTargetExtensionAdapter,
  createTargetPipelineHostLifecycle,
} from './capabilities/targetAdapter';
import {
  createTargetPipelineHostComposition,
} from './pipelineHost/targetComposition';

const adapter = createTargetExtensionAdapter();
const pipelineHostCapabilities = adapter.pipelineHost();
const pipelineHostComposition = createTargetPipelineHostComposition();
const pipelineHostLifecycle = createTargetPipelineHostLifecycle(
  (connection) => startBackgroundPipelineHost(
    pipelineHostCapabilities,
    connection,
    pipelineHostComposition,
  ),
);
startBackground(
  adapter.background(),
  pipelineHostLifecycle,
);
