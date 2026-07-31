import {
  createTargetExtensionAdapter,
} from './capabilities/targetAdapter';
import { mountPopup } from '../../../src/popup/main';

const capabilities = createTargetExtensionAdapter().popup();

mountPopup({
  runtimeRequests: capabilities.runtimeRequests,
  extensionVersion: capabilities.environment.metadata.version,
  commands: capabilities.commands,
  permissions: capabilities.permissions,
});
