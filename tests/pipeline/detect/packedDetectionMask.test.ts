import { describe, expect, it } from 'vitest';

import {
  inspectPackedDetectionMaskEdges,
  packDetectionMask,
  unpackDetectionMask,
} from '../../../packages/image-pipeline/src/pipeline/detect/packedDetectionMask';

describe('packed detection mask', () => {
  it('round-trips a binary mask using one bit per source pixel', () => {
    const binary = Uint8Array.from([
      0, 1, 0, 1, 1,
      1, 0, 0, 0, 1,
      0, 0, 1, 0, 0,
    ]);

    const packed = packDetectionMask(binary, 5, 3);

    expect(packed).toEqual(Uint8Array.from([0b0011_1010, 0b0001_0010]));
    expect(unpackDetectionMask(packed, 5, 3)).toEqual(binary);
  });

  it('reports distance-weighted contact strength across the first and last 16 rows', () => {
    const binary = new Uint8Array(6 * 40);
    binary[15 * 6 + 4] = 1;
    binary[24 * 6 + 2] = 1;

    expect(inspectPackedDetectionMaskEdges(
      packDetectionMask(binary, 6, 40),
      6,
      40,
    )).toEqual({
      topTouches: true,
      bottomTouches: true,
      topStrength: 1,
      bottomStrength: 1,
    });
  });

  it('does not treat mask beyond the 16-row edge bands as a contact', () => {
    const binary = new Uint8Array(4 * 40);
    binary[16 * 4 + 1] = 1;
    binary[23 * 4 + 2] = 1;

    expect(inspectPackedDetectionMaskEdges(
      packDetectionMask(binary, 4, 40),
      4,
      40,
    )).toEqual({
      topTouches: false,
      bottomTouches: false,
      topStrength: 0,
      bottomStrength: 0,
    });
  });

  it('rejects malformed dimensions and packed lengths', () => {
    expect(() => packDetectionMask(new Uint8Array(3), 2, 2)).toThrow('尺寸');
    expect(() => unpackDetectionMask(new Uint8Array(0), 2, 2)).toThrow('长度');
  });
});
