import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const builder = resolve(import.meta.dirname, 'build.mjs');
const targets = [
  'conformance-detector-chrome',
  'conformance-detector-firefox',
  'conformance-translation-chrome',
  'conformance-translation-firefox',
  'conformance-lifecycle-chrome',
  'conformance-lifecycle-firefox',
];

for (const target of targets) {
  execFileSync(process.execPath, [builder, '--target', target], {
    cwd: root,
    stdio: 'inherit',
  });
}
