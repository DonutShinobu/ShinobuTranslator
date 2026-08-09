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

  it('treats any mask pixel in the first or last two rows as an edge contact', () => {
    const binary = new Uint8Array(6 * 6);
    binary[1 * 6 + 4] = 1;
    binary[3 * 6 + 2] = 1;
    binary[5 * 6] = 1;

    expect(inspectPackedDetectionMaskEdges(
      packDetectionMask(binary, 6, 6),
      6,
      6,
    )).toEqual({ topTouches: true, bottomTouches: true });
  });

  it('does not treat mask outside the two-pixel bands as a contact', () => {
    const binary = new Uint8Array(4 * 5);
    binary[2 * 4 + 1] = 1;

    expect(inspectPackedDetectionMaskEdges(
      packDetectionMask(binary, 4, 5),
      4,
      5,
    )).toEqual({ topTouches: false, bottomTouches: false });
  });

  it('rejects malformed dimensions and packed lengths', () => {
    expect(() => packDetectionMask(new Uint8Array(3), 2, 2)).toThrow('尺寸');
    expect(() => unpackDetectionMask(new Uint8Array(0), 2, 2)).toThrow('长度');
  });
});
