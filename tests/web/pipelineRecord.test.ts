import { describe, expect, it } from 'vitest';
import {
  createWebPipelineRecord,
  isWebPipelineRecord,
} from '../../apps/web/src/domain/pipelineRecord';
import type { TextRegion } from '../../src/types';

function region(overrides: Partial<TextRegion> = {}): TextRegion {
  return {
    id: 'region-1',
    box: { x: 10, y: 20, width: 100, height: 80 },
    direction: 'v',
    prob: 0.98,
    sourceText: 'こんにちは',
    translatedText: '你好',
    translatedColumns: ['你', '好'],
    bubbleMask: {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      data: new Uint8Array([255]),
    },
    ...overrides,
  };
}

describe('web pipeline record', () => {
  it('extracts OCR and translations without pixel masks or diagnostic logs', () => {
    const record = createWebPipelineRecord({
      original: { naturalWidth: 1200, naturalHeight: 1800 } as never,
      stageRegions: {
        detected: [],
        ocr: [region()],
        merged: [],
        ordered: [region()],
      },
    });

    expect(record).toMatchObject({
      schemaVersion: 1,
      image: { width: 1200, height: 1800 },
      ocr: [{ order: 0, text: 'こんにちは', confidence: 0.98 }],
      translations: [{
        order: 0,
        sourceText: 'こんにちは',
        translatedText: '你好',
        translatedColumns: ['你', '好'],
      }],
    });
    expect(JSON.stringify(record)).not.toContain('bubbleMask');
    expect(isWebPipelineRecord(record)).toBe(true);
  });

  it('rejects non-contiguous order and oversized text records', () => {
    const invalidOrder = {
      schemaVersion: 1,
      image: { width: 10, height: 10 },
      ocr: [{
        id: 'region-1',
        order: 1,
        box: { x: 0, y: 0, width: 1, height: 1 },
        text: 'x',
      }],
      translations: [],
    };
    expect(isWebPipelineRecord(invalidOrder)).toBe(false);
    invalidOrder.ocr[0].order = 0;
    invalidOrder.ocr[0].text = 'x'.repeat(100_001);
    expect(isWebPipelineRecord(invalidOrder)).toBe(false);
  });
});
