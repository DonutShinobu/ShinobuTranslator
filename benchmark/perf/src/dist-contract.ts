import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

type ModelManifest = {
  models?: Record<string, {
    url?: unknown;
    dictUrl?: unknown;
  }>;
};

function requireFile(distDir: string, relativePath: string): void {
  const fullPath = join(distDir, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Missing dist asset: ${fullPath}. Run the corresponding build command first.`);
  }
}

function toDistRelativeAsset(distDir: string, asset: string): string {
  if (/^[a-z][a-z\d+.-]*:/iu.test(asset) || asset.startsWith('//')) {
    throw new Error(`Extension model manifest contains a remote asset: ${asset}`);
  }
  const relativeAsset = asset.replace(/^\/+/, '');
  const fullPath = resolve(distDir, relativeAsset);
  const root = resolve(distDir);
  if (fullPath !== root && !fullPath.startsWith(`${root}${sep}`)) {
    throw new Error(`Extension model asset escapes dist: ${asset}`);
  }
  return relative(root, fullPath);
}

function requireManifestModelAssets(distDir: string): void {
  const manifestPath = join(distDir, 'models', 'models.json');
  requireFile(distDir, 'models/models.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ModelManifest;
  for (const model of Object.values(manifest.models ?? {})) {
    for (const candidate of [model.url, model.dictUrl]) {
      if (typeof candidate === 'string') {
        requireFile(distDir, toDistRelativeAsset(distDir, candidate));
      }
    }
  }
}

export function ensureExtensionDistReady(
  distDir: string,
  options: { benchmark?: boolean } = {},
): void {
  const required = [
    'manifest.json',
    'background-chromium.js',
    'content.js',
    'offscreen.html',
    'offscreen.js',
    'onnxWorker.js',
    'ort/ort-wasm-simd-threaded.jsep.mjs',
    'ort/ort-wasm-simd-threaded.jsep.wasm',
  ];
  if (options.benchmark) required.push('benchmark.html', 'benchmark.js');
  required.forEach((asset) => requireFile(distDir, asset));
  requireManifestModelAssets(distDir);
}
