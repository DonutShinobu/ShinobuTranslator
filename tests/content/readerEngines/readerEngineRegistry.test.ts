import { describe, expect, it } from 'vitest';
import {
  ReaderEngineRegistry,
} from '../../../apps/extension/src/content/core/reading/readerEngineRegistry';
import type {
  ReaderEngineAdapter,
  ReaderEngineDetection,
} from '../../../apps/extension/src/content/core/reading/readerEngineContracts';

function adapter(
  engineId: string,
  detection: ReaderEngineDetection | null,
): ReaderEngineAdapter {
  return {
    engineId,
    detect: () => detection,
    createReadingModeSession: () => {
      throw new Error('not needed by registry selection');
    },
  };
}

describe('ReaderEngineRegistry', () => {
  it('selects the first strong reader-engine match and keeps its evidence', () => {
    const root = {} as HTMLElement;
    const registry = new ReaderEngineRegistry([
      adapter('missing', null),
      adapter('preferred', {
        confidence: 'strong',
        root,
        evidence: ['root', 'pages', 'page-slot'],
      }),
      adapter('later', {
        confidence: 'strong',
        root: {} as HTMLElement,
        evidence: ['later'],
      }),
    ]);

    expect(registry.detect()).toEqual({
      adapter: expect.objectContaining({ engineId: 'preferred' }),
      detection: {
        confidence: 'strong',
        root,
        evidence: ['root', 'pages', 'page-slot'],
      },
    });
  });
});
