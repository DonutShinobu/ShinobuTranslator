import { describe, expect, it, vi } from 'vitest';
import {
  createImageImporter,
  detectImageSignature,
  type ImageDecoder,
  type ImageImportLimits,
} from '../../apps/web/src/features/import/imageImporter';

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function makeFile(
  bytes: readonly number[],
  name = 'page.png',
  options: FilePropertyBag = {},
): File {
  return new File([new Uint8Array(bytes)], name, {
    type: options.type ?? '',
    lastModified: options.lastModified ?? 1,
  });
}

function createDecoder(width: number, height: number): ImageDecoder {
  return vi.fn(async () => ({
    width,
    height,
    createThumbnail: vi.fn(async () => `blob:thumb-${width}-${height}`),
    dispose: vi.fn(),
  }));
}

describe('image signature detection', () => {
  it('identifies supported formats from bytes instead of the MIME type', () => {
    expect(detectImageSignature(new Uint8Array(pngSignature))).toEqual({
      format: 'png',
      animated: false,
    });
    expect(detectImageSignature(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({
      format: 'jpeg',
      animated: false,
    });
    expect(detectImageSignature(new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0,
      0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
    ]))).toEqual({
      format: 'webp',
      animated: false,
    });
    expect(detectImageSignature(new Uint8Array([
      0, 0, 0, 24,
      0x66, 0x74, 0x79, 0x70,
      0x61, 0x76, 0x69, 0x66,
      0, 0, 0, 0,
      0x6d, 0x69, 0x66, 0x31,
      0x61, 0x76, 0x69, 0x66,
    ]))).toEqual({
      format: 'avif',
      animated: false,
    });
  });
});

describe('image importer', () => {
  it('accepts a static image with a misleading MIME type and plans a working copy', async () => {
    const decodeImage = createDecoder(4_000, 3_000);
    const importer = createImageImporter({
      decodeImage,
      createId: () => 'image-1',
    });
    const file = makeFile(pngSignature, 'page.data', { type: 'text/plain' });

    const result = await importer.importFiles([file]);

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({
      id: 'image-1',
      format: 'png',
      width: 4_000,
      height: 3_000,
      duplicate: false,
      workingCopy: {
        required: true,
      },
    });
    expect(result.accepted[0].workingCopy.width).toBeLessThan(4_000);
    expect(decodeImage).toHaveBeenCalledWith(file);
  });

  it('rejects animated PNG before browser decoding', async () => {
    const decodeImage = createDecoder(100, 100);
    const bytes = [...pngSignature, 0x61, 0x63, 0x54, 0x4c];
    const importer = createImageImporter({ decodeImage });

    const result = await importer.importFiles([makeFile(bytes)]);

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].code).toBe('animated-image');
    expect(decodeImage).not.toHaveBeenCalled();
  });

  it('preserves order and marks repeated files without removing them', async () => {
    let nextId = 0;
    const importer = createImageImporter({
      decodeImage: createDecoder(1_000, 1_500),
      createId: () => `image-${nextId += 1}`,
    });
    const first = makeFile(pngSignature, 'same.png', { lastModified: 42 });
    const second = makeFile(pngSignature, 'same.png', { lastModified: 42 });

    const result = await importer.importFiles([first, second]);

    expect(result.accepted.map((image) => image.id)).toEqual(['image-1', 'image-2']);
    expect(result.accepted.map((image) => image.duplicate)).toEqual([false, true]);
  });

  it('rejects dimensions outside the fixed safety gate', async () => {
    const importer = createImageImporter({
      decodeImage: createDecoder(8_193, 100),
    });

    const result = await importer.importFiles([makeFile(pngSignature)]);

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0].code).toBe('dimensions-too-large');
  });

  it('applies batch count and total size limits in queue order', async () => {
    const limits: ImageImportLimits = {
      maxFileBytes: 20,
      maxTotalBytes: 20,
      maxBatchCount: 1,
      maxOriginalPixels: 1_000_000,
      maxLongEdge: 2_000,
      workPixelBudget: 1_000_000,
      thumbnailMaxEdge: 512,
    };
    const importer = createImageImporter({
      decodeImage: createDecoder(100, 100),
      limits,
    });
    const files = [
      makeFile(pngSignature, 'first.png'),
      makeFile(pngSignature, 'second.png'),
    ];

    const result = await importer.importFiles(files);

    expect(result.accepted.map((image) => image.file.name)).toEqual(['first.png']);
    expect(result.rejected).toMatchObject([
      { file: files[1], code: 'batch-count-limit' },
    ]);
  });
});
