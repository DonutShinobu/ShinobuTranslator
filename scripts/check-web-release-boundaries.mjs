import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'apps/web/dist');
const manifest = JSON.parse(
  await readFile(resolve(root, 'packages/model-manifest/manifest.json'), 'utf8'),
);

async function exists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return nested.flat();
}

for (const asset of manifest.assets) {
  const bundledPath = resolve(dist, 'models', asset.path);
  if (await exists(bundledPath)) {
    throw new Error(`Web release must not publish private model asset: ${asset.path}`);
  }
}

for (const required of [
  '_headers',
  'index.html',
  'manifest.webmanifest',
  'models/models.json',
  'onnxWorker.js',
  'PRIVACY_POLICY.md',
  'sw.js',
  'THIRD_PARTY_DEPENDENCIES.json',
  'THIRD_PARTY_NOTICES.md',
  'WEB_PUBLIC_BETA_RELEASE_NOTES.md',
  'WEB_TROUBLESHOOTING.md',
]) {
  if (!await exists(resolve(dist, required))) {
    throw new Error(`Web release is missing required file: ${required}`);
  }
}

const forbiddenRuntimePatterns = [
  ['Node ONNX runtime', /onnxruntime-node/u],
  ['Vite browser external shim', /__vite-browser-external/u],
  ['Node model registry adapter', /modelRegistryNode/u],
  ['Node ONNX bridge adapter', /onnxNodeBridge/u],
  ['Node OCR dictionary adapter', /ocrSharedNode/u],
];
for (const path of await listFiles(dist)) {
  if (!/\.(?:html|js|mjs)$/u.test(path)) continue;
  const source = await readFile(path, 'utf8');
  for (const [label, pattern] of forbiddenRuntimePatterns) {
    if (pattern.test(source) || pattern.test(path)) {
      throw new Error(
        `Web release contains unreachable ${label}: ${path.slice(dist.length + 1)}`,
      );
    }
  }
}

console.log(
  'Web release boundaries verified: private models and Node-only runtime adapters excluded; shell assets present.',
);
