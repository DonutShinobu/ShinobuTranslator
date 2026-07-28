import { describe, expect, it } from 'vitest';
import { hasBubbleMaskPixel } from '../../src/pipeline/bubbleMask';
import { decodeBubbleMasks, matchRegionsToBubbles } from '../../src/pipeline/bubbleDetect';
import type { BubbleMask, TextRegion } from '../../src/types';

function createLocalMask(): BubbleMask {
  return {
    x: 100,
    y: 200,
    width: 3,
    height: 2,
    data: new Uint8Array([
      0, 1, 0,
      1, 1, 0,
    ]),
  };
}

describe('local bubble masks', () => {
  it('preserves effective proto-mask pixels outside a fractional detection box', () => {
    const [mask] = decodeBubbleMasks(
      [{
        box: { x: 1.1, y: 1.1, width: 0.2, height: 0.2 },
        score: 1,
        maskCoeffs: new Float32Array([1]),
      }],
      new Float32Array([
        10, -10,
        -10, -10,
      ]),
      [1, 1, 2, 2],
      {
        input: new Float32Array(),
        size: 4,
        ratio: 1,
        padX: 0,
        padY: 0,
      },
      4,
      4,
    );

    expect(mask).toEqual({
      x: 0,
      y: 0,
      width: 2,
      height: 2,
      data: new Uint8Array([
        1, 1,
        1, 1,
      ]),
    });
  });

  it('queries single-channel pixels in source-image coordinates', () => {
    const mask = createLocalMask();

    expect(hasBubbleMaskPixel(mask, 101, 200)).toBe(true);
    expect(hasBubbleMaskPixel(mask, 100, 201)).toBe(true);
    expect(hasBubbleMaskPixel(mask, 99, 200)).toBe(false);
    expect(hasBubbleMaskPixel(mask, 103, 201)).toBe(false);
  });

  it('matches a region using a cropped mask origin', () => {
    const mask = createLocalMask();
    const region: TextRegion = {
      id: 'inside-local-mask',
      box: { x: 100, y: 199, width: 2, height: 2 },
      sourceText: '原文',
      translatedText: '译文',
    };

    const result = matchRegionsToBubbles([region], [{
      box: { x: 100, y: 200, width: 3, height: 2 },
      score: 0.9,
      mask,
    }]);

    expect(result).toEqual({ unmatchedCount: 0, unmatchedRegionIds: [] });
    expect(region.bubbleMask).toBe(mask);
  });
});
