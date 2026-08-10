import { describe, expect, it } from 'vitest';
import {
  createPublusV1ImagePath,
  createPublusV1TileMoves,
  decodePublusV1Pack,
  type PublusV1TileMove,
} from '../../../apps/extension/src/content/readerEngines/publusReaderV1';

const keys = [
  Uint8Array.from({ length: 32 }, (_, index) => index),
  Uint8Array.from({ length: 32 }, (_, index) => index + 32),
  Uint8Array.from({ length: 32 }, (_, index) => index + 64),
] as const;

const page = {
  file: 'OEBPS/text/synthetic.xhtml',
  fileName: '0',
  width: 70,
  height: 66,
  blockWidth: 16,
  blockHeight: 16,
  dummyWidth: 0,
  dummyHeight: 0,
  ns: 123456789,
  ps: 987654321,
  rs: 246813579,
};

function copyRect(
  source: Uint32Array,
  target: Uint32Array,
  width: number,
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  rectWidth: number,
  rectHeight: number,
): void {
  for (let y = 0; y < rectHeight; y += 1) {
    for (let x = 0; x < rectWidth; x += 1) {
      target[(targetY + y) * width + targetX + x]
        = source[(sourceY + y) * width + sourceX + x]!;
    }
  }
}

function scramblePixels(
  restored: Uint32Array,
  width: number,
  moves: readonly PublusV1TileMove[],
): Uint32Array {
  const scrambled = new Uint32Array(restored.length);
  for (const move of moves) {
    copyRect(
      restored,
      scrambled,
      width,
      move.destinationX,
      move.destinationY,
      move.sourceX,
      move.sourceY,
      move.width,
      move.height,
    );
  }
  return scrambled;
}

function restorePixels(
  scrambled: Uint32Array,
  width: number,
  moves: readonly PublusV1TileMove[],
): Uint32Array {
  const restored = new Uint32Array(scrambled.length);
  for (const move of moves) {
    copyRect(
      scrambled,
      restored,
      width,
      move.sourceX,
      move.sourceY,
      move.destinationX,
      move.destinationY,
      move.width,
      move.height,
    );
  }
  return restored;
}

describe('PUBLUS Reader 1.x codec', () => {
  it('unpacks a fixed synthetic vector without content or authorization data', () => {
    const decoded = decodePublusV1Pack(JSON.stringify({
      version: '1.0',
      data: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4v'
        + 'MDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fAtc=',
    }));

    expect(decoded.configuration).toBe(4);
    expect(decoded.keys.map((key) => [...key]
      .map((value) => value.toString(16).padStart(2, '0')).join(''))).toEqual([
      'df400dc2504aabf41e4e88e0e758dde9b7a18c9133fa98a791361811c4ceef3c',
      '0930cde52c91cd9e180a79b75393a000e39d20189c3c1ea91b53cd5ad3d3f3ab',
      '2dbe60a969863e6e5d9671aba5bdf36a6c9ff62a76e2869c9dfefd694310002d',
    ]);
  });

  it('derives the version-1 resource filename from de-identified keys', () => {
    expect(createPublusV1ImagePath(page.file, page.fileName, 'jpeg', keys)).toBe(
      'OEBPS/text/synthetic.xhtml/108b185248f6bd3598.jpeg',
    );
  });

  it('restores remainder blocks pixel-for-pixel with the generated move plan', () => {
    const moves = createPublusV1TileMoves(page, keys);
    expect(moves).toHaveLength(25);
    expect(moves.slice(0, 3)).toEqual([
      {
        sourceX: 54,
        sourceY: 32,
        destinationX: 6,
        destinationY: 0,
        width: 16,
        height: 16,
      },
      {
        sourceX: 16,
        sourceY: 0,
        destinationX: 0,
        destinationY: 16,
        width: 16,
        height: 16,
      },
      {
        sourceX: 54,
        sourceY: 0,
        destinationX: 0,
        destinationY: 32,
        width: 16,
        height: 16,
      },
    ]);

    const checkerboard = Uint32Array.from(
      { length: page.width * page.height },
      (_, index) => {
        const x = index % page.width;
        const y = Math.floor(index / page.width);
        return ((x >> 2) + (y >> 2)) % 2 === 0 ? 0xff_00_00_ff : 0xff_ff_ff_ff;
      },
    );
    const scrambled = scramblePixels(checkerboard, page.width, moves);
    expect(restorePixels(scrambled, page.width, moves)).toEqual(checkerboard);
  });
});
