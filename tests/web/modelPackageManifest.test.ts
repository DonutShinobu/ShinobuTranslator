import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WEB_MODEL_PACKAGE } from '../../apps/web/src/runtime/modelPackage';

function modelFilePath(assetPath: string): string {
  return path.resolve('public/models', assetPath);
}

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

const hasCompleteLocalModelPackage = WEB_MODEL_PACKAGE.assets.every((asset) =>
  existsSync(modelFilePath(asset.path)));

describe('Web model package manifest', () => {
  it('exposes the complete installable asset set without reading local model files', () => {
    expect(WEB_MODEL_PACKAGE).toMatchObject({
      schemaVersion: 1,
      version: expect.stringMatching(/^\d{4}-\d{2}-\d{2}-runtime-v\d+$/u),
      assets: [
        { id: 'detector', path: 'detector.onnx' },
        { id: 'inpaint', path: 'aot_inpaint_512.onnx' },
        { id: 'bubble', path: 'bubble.onnx' },
        { id: 'paddleocr-v6-medium', path: 'PP-OCRv6_medium_rec.onnx' },
        { id: 'paddleocr-v6-dictionary', path: 'paddleocr_v6_dict.txt' },
      ],
    });
  });

  it('provides verifiable metadata for every installable asset', () => {
    expect(WEB_MODEL_PACKAGE.assets.every((asset) =>
      Number.isSafeInteger(asset.size)
      && asset.size > 0
      && /^[a-f0-9]{64}$/u.test(asset.sha256)
      && asset.url.endsWith(asset.path))).toBe(true);
  });

  it.runIf(hasCompleteLocalModelPackage)(
    'matches the complete local runtime model package byte-for-byte',
    async () => {
      await Promise.all(WEB_MODEL_PACKAGE.assets.map(async (asset) => {
        const filePath = modelFilePath(asset.path);
        const metadata = await stat(filePath);
        expect(metadata.size, asset.path).toBe(asset.size);
        await expect(sha256File(filePath), asset.path).resolves.toBe(asset.sha256);
      }));
    },
  );
});
