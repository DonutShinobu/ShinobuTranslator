import { startContent } from '../../../src/content/index';
import {
  createTargetExtensionAdapter,
} from './capabilities/targetAdapter';

startContent(createTargetExtensionAdapter().content());
