import type { ExtensionMessageSource } from './contracts';
import {
  ExtensionOperationError,
  type ExtensionCapability,
  type ExtensionOperation,
} from './errors';

export type TabDocumentSource = Extract<
  ExtensionMessageSource,
  { kind: 'tab-document' }
>;

export function requireTabDocumentSource(
  source: ExtensionMessageSource,
  context: Readonly<{
    capability: ExtensionCapability;
    operation: ExtensionOperation;
  }>,
): TabDocumentSource {
  if (source.kind === 'tab-document') return source;
  throw new ExtensionOperationError({
    capability: context.capability,
    operation: context.operation,
    code: 'invalid-message-source',
    retryable: false,
    diagnostic: {
      sourceKind: source.kind,
    },
  });
}
