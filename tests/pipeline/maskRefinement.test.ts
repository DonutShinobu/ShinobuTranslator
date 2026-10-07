import { describe, expect, it } from 'vitest';
import { dilate } from '../../packages/image-pipeline/src/pipeline/maskRefinement/algorithms';

function loopOracle(mask: Uint8Array, width: number, height: number, kernelSize: number): Uint8Array {
  if (kernelSize <= 1) return mask.slice();
  const radius = Math.floor(kernelSize / 2);
  const offsets: Array<[number, number]> = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx * dx + dy * dy <= radius * radius + 0.25) offsets.push([dx, dy]);
    }
  }
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 0) continue;
      for (const [dx, dy] of offsets) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height) out[ny * width + nx] = 1;
      }
    }
  }
  return out;
}

describe('mask dilation', () => {
  it('matches the pixel loop at boundaries and for large, odd, even, and fractional kernels', () => {
    for (const [width, height] of [[0, 0], [1, 1], [1, 17], [19, 1], [13, 11]]) {
      const corners = new Uint8Array(width * height);
      if (corners.length > 0) {
        for (const pixel of [0, width - 1, (height - 1) * width, width * height - 1]) corners[pixel] = 2;
      }
      for (const mask of [corners, new Uint8Array(corners.length), new Uint8Array(corners.length).fill(255)]) {
        const before = mask.slice();
        for (const kernelSize of [-2, 0, 1, 1.1, 2, 3, 4, 7, 31, 101, 201]) {
          const actual = dilate(mask, width, height, kernelSize);
          expect(actual).toEqual(loopOracle(mask, width, height, kernelSize));
          expect(actual).not.toBe(mask);
          expect(mask).toEqual(before);
        }
      }
    }
  });

  it('matches the pixel loop for fragmented and random masks without changing inputs', () => {
    let state = 0x53bf6d79;
    const random = () => {
      state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
      return state >>> 0;
    };
    for (let trial = 0; trial < 80; trial++) {
      const width = 1 + random() % 29, height = 1 + random() % 23, kernelSize = 1 + random() % 65;
      const mask = Uint8Array.from({ length: width * height }, (_, pixel) => trial % 2 === 0
        ? (pixel % width + Math.floor(pixel / width)) % 2
        : random() % 3 === 0 ? [1, 2, 255][random() % 3] : 0);
      const before = mask.slice();
      expect(dilate(mask, width, height, kernelSize)).toEqual(loopOracle(mask, width, height, kernelSize));
      expect(mask).toEqual(before);
    }
  });
});
