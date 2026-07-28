import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WEB_MODEL_PACKAGE } from '../../apps/web/src/runtime/modelPackage';

async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

describe('embedded Web model package manifest', () => {
  it('matches every bundled runtime model byte-for-byte', async () => {
    await Promise.all(WEB_MODEL_PACKAGE.assets.map(async (asset) => {
      const filePath = path.resolve('public/models', asset.path);
      const metadata = await stat(filePath);
      expect(metadata.size, asset.path).toBe(asset.size);
      await expect(sha256File(filePath), asset.path).resolves.toBe(asset.sha256);
    }));
  });
});
