import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const generatorPath = resolve(
  root,
  'apps/extension/scripts/generate-browser-ort-entries.mjs',
);

describe('browser ONNX Runtime entries', () => {
  it(
    'match the pinned upstream sources byte for byte',
    () => {
      expect(() => {
        execFileSync(
          process.execPath,
          [generatorPath, '--check'],
          {
            cwd: root,
            stdio: 'pipe',
          },
        );
      }).not.toThrow();
    },
    15_000,
  );
});
