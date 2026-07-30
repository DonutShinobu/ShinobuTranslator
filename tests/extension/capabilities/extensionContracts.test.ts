import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  ExtensionMessageSource,
} from '../../../apps/extension/src/capabilities/contracts';
import {
  ExtensionContractError,
  ExtensionOperationError,
} from '../../../apps/extension/src/capabilities/errors';
import {
  requireTabDocumentSource,
} from '../../../apps/extension/src/capabilities/guards';

describe('extension capability contracts', () => {
  it('keeps native browser mechanics out of the public contract surface', () => {
    const source = [
      'authentication.ts',
      'contracts.ts',
      'errors.ts',
      'guards.ts',
      'index.ts',
    ].map((file) => readFileSync(
      resolve(process.cwd(), 'apps/extension/src/capabilities', file),
      'utf8',
    )).join('\n');

    for (const forbidden of [
      /\bChrome/u,
      /\bFirefox/u,
      /\bcallback\b/u,
      /\bsendResponse\b/u,
      /\blastError\b/u,
    ]) {
      expect(source).not.toMatch(forbidden);
    }
  });

  it('requires a documentId before treating a message as a web document', () => {
    const source: ExtensionMessageSource = {
      kind: 'tab-document',
      documentId: 'document-12',
      tabId: 12,
      frameId: 0,
      url: 'https://example.test/chapter',
    };

    expect(requireTabDocumentSource(source, {
      capability: 'tab-message',
      operation: 'translate-document',
    })).toEqual(source);
    expect(() => requireTabDocumentSource({ kind: 'unknown' }, {
      capability: 'tab-message',
      operation: 'translate-document',
    })).toThrow(expect.objectContaining({
      name: 'ExtensionOperationError',
      code: 'invalid-message-source',
      retryable: false,
      diagnostic: {
        sourceKind: 'unknown',
      },
    }));
  });

  it('keeps startup and one-time failures as distinct stable error types', () => {
    const details = {
      capability: 'runtime-channel',
      operation: 'initialize',
      code: 'context-unavailable' as const,
      retryable: false,
      diagnostic: {
        missing: 'runtime.onConnect',
      },
    } as const;

    const startup = new ExtensionContractError(details);
    const operation = new ExtensionOperationError({
      ...details,
      operation: 'open',
    });

    expect(startup).toMatchObject({
      name: 'ExtensionContractError',
      code: 'context-unavailable',
      retryable: false,
      diagnostic: {
        missing: 'runtime.onConnect',
      },
    });
    expect(operation).toMatchObject({
      name: 'ExtensionOperationError',
      operation: 'open',
    });
  });
});
