import { describe, expect, it } from 'vitest';
import {
  CONTENT_FINGERPRINT_MAX_DISTANCE,
  contentFingerprintFromGrayscale,
  contentFingerprintsMatch,
} from '../../../../apps/extension/src/content/core/continuous/contentFingerprint';

describe('content fingerprint', () => {
  it('uses a 64-bit dHash with the confirmed revision tolerance', () => {
    const gradient = Uint8ClampedArray.from({ length: 9 * 8 }, (_, index) => index % 9);
    const slightlyChanged = gradient.slice();
    slightlyChanged[0] = 20;
    const different = Uint8ClampedArray.from({ length: 9 * 8 }, (_, index) => 9 - (index % 9));

    const original = contentFingerprintFromGrayscale(gradient);
    const nearby = contentFingerprintFromGrayscale(slightlyChanged);
    const other = contentFingerprintFromGrayscale(different);

    expect(original).toMatch(/^[0-9a-f]{16}$/u);
    expect(CONTENT_FINGERPRINT_MAX_DISTANCE).toBe(4);
    expect(contentFingerprintsMatch(original, nearby)).toBe(true);
    expect(contentFingerprintsMatch(original, other)).toBe(false);
  });

  it('matches downscale and compression fixtures but separates another page', () => {
    const originalFixture = Uint8ClampedArray.from({ length: 9 * 8 }, (_, index) => {
      const x = index % 9;
      const y = Math.floor(index / 9);
      return (x * 37 + y * 19 + x * y * 7) % 256;
    });
    const downscaledFixture = Uint8ClampedArray.from(originalFixture, (value, index) => {
      const x = index % 9;
      const neighbor = originalFixture[index + (x < 8 ? 1 : -1)];
      return Math.round(value * 0.8 + neighbor * 0.2);
    });
    const compressedFixture = Uint8ClampedArray.from(
      originalFixture,
      (value) => Math.round(value / 24) * 24,
    );
    const differentPageFixture = Uint8ClampedArray.from(originalFixture, (_value, index) => {
      const x = index % 9;
      const y = Math.floor(index / 9);
      return originalFixture[y * 9 + (8 - x)];
    });
    const original = contentFingerprintFromGrayscale(originalFixture);

    expect(contentFingerprintsMatch(
      original,
      contentFingerprintFromGrayscale(downscaledFixture),
    )).toBe(true);
    expect(contentFingerprintsMatch(
      original,
      contentFingerprintFromGrayscale(compressedFixture),
    )).toBe(true);
    expect(contentFingerprintsMatch(
      original,
      contentFingerprintFromGrayscale(differentPageFixture),
    )).toBe(false);
  });
});
