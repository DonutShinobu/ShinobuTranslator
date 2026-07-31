import { startBackground } from '../../../src/background/index';
import {
  createTargetExtensionAdapter,
  createTargetPipelineHostLifecycle,
} from './capabilities/targetAdapter';

const adapter = createTargetExtensionAdapter();
startBackground(
  adapter.background(),
  createTargetPipelineHostLifecycle(),
);
