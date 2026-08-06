import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeUndeclaredDistModelAssets } from '../../apps/extension/vite.config';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('extension release model assets', () => {
  it('removes stale ignored model files and checksum metadata', () => {
    const extensionDist = mkdtempSync(join(tmpdir(), 'shinobu-extension-dist-'));
    temporaryDirectories.push(extensionDist);
    const modelsDir = join(extensionDist, 'models');
    mkdirSync(modelsDir);
    writeFileSync(join(modelsDir, 'models.json'), JSON.stringify({
      models: {
        detector: { url: '/models/detector.onnx' },
        ocr: {
          url: '/models/ocr.onnx',
          dictUrl: '/models/ocr-dict.txt',
        },
      },
    }));
    for (const filename of [
      'detector.onnx',
      'ocr.onnx',
      'ocr-dict.txt',
      'detector.ort',
      'models.sha256',
    ]) {
      writeFileSync(join(modelsDir, filename), filename);
    }

    removeUndeclaredDistModelAssets(extensionDist);

    expect(existsSync(join(modelsDir, 'models.json'))).toBe(true);
    expect(existsSync(join(modelsDir, 'detector.onnx'))).toBe(true);
    expect(existsSync(join(modelsDir, 'ocr.onnx'))).toBe(true);
    expect(existsSync(join(modelsDir, 'ocr-dict.txt'))).toBe(true);
    expect(existsSync(join(modelsDir, 'detector.ort'))).toBe(false);
    expect(existsSync(join(modelsDir, 'models.sha256'))).toBe(false);
  });
});
