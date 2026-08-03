import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run build-for-amo through npm so npm_execpath is available');
const modelRelease = JSON.parse(
  readFileSync(resolve(root, 'apps/extension/model-release.json'), 'utf8'),
);
const modelManifest = JSON.parse(
  readFileSync(resolve(root, 'public/models/models.json'), 'utf8'),
);
if (modelRelease.manifestVersion !== modelManifest.version) {
  throw new Error('Pinned model release metadata does not match public/models/models.json');
}

function npm(...args) {
  execFileSync(process.execPath, [npmCli, ...args], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, MODEL_RELEASE_TAG: modelRelease.tag },
  });
}

npm('run', 'check:amo-metadata');
npm('run', 'models:download', '--', modelRelease.tag, '--use-verified-existing');
npm('run', 'build:extension:firefox');
npm('run', 'lint:firefox', '--workspace=@shinobu/extension');
execFileSync(
  process.execPath,
  [
    resolve(root, 'scripts/package-extensions.mjs'),
    '--firefox',
    resolve(root, 'apps/extension/dist-firefox'),
    '--artifacts',
    resolve(root, 'artifacts'),
  ],
  { cwd: root, stdio: 'inherit' },
);
