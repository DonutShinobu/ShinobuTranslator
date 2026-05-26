/**
 * Node-only model loading utilities.
 *
 * Separated from modelRegistry.ts so that Vite can externalize this file
 * for the browser build. The browser build never imports this module —
 * it's only loaded dynamically under the isNode guard in modelRegistry.ts.
 */

import type { RuntimeProvider } from './onnxTypes';

type ManifestModel = {
  name: string;
  task: string;
  url: string;
  input: number[];
  runtime?: RuntimeProvider[];
  dictUrl?: string;
  normalize?: 'zero_to_one' | 'minus_one_to_one';
  outputNormalize?: 'zero_to_one' | 'minus_one_to_one' | 'zero_to_255';
  maskInputName?: string;
};

type ManifestData = {
  source?: string;
  note?: string;
  models: Record<string, ManifestModel>;
};

let _projectRoot: string | null = null;

async function getProjectRoot(): Promise<string> {
  if (_projectRoot) return _projectRoot;
  const path = await import('path');
  const fs = await import('fs');

  // Strategy 1: __dirname (CJS or tsx with CJS shim)
  if (typeof __dirname !== 'undefined') {
    _projectRoot = path.resolve(__dirname, '..', '..');
    return _projectRoot;
  }

  // Strategy 2: import.meta.url (ESM)
  try {
    const { fileURLToPath } = await import('url');
    const thisFile = fileURLToPath(import.meta.url);
    _projectRoot = path.resolve(path.dirname(thisFile), '..', '..');
    return _projectRoot;
  } catch {
    // import.meta.url not available
  }

  // Strategy 3: walk up from process.cwd()
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'public', 'models', 'models.json'))) {
      _projectRoot = dir;
      return dir;
    }
    const parent = path.resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('无法定位项目根目录 (models.json)');
}

export async function loadManifestNode(): Promise<ManifestData> {
  const fs = await import('fs');
  const path = await import('path');
  const root = await getProjectRoot();
  const manifestPath = path.resolve(root, 'public', 'models', 'models.json');
  const raw = fs.readFileSync(manifestPath, 'utf-8');
  return JSON.parse(raw) as ManifestData;
}

function isAbsoluteUrl(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(url);
}

export async function resolveModelFilePath(modelUrl: string): Promise<string> {
  if (isAbsoluteUrl(modelUrl) && modelUrl.startsWith('file://')) {
    return modelUrl.slice('file://'.length);
  }
  if (modelUrl.startsWith('/') && !isAbsoluteUrl(modelUrl)) {
    const path = await import('path');
    const root = await getProjectRoot();
    const relativePath = modelUrl.slice(1);
    return path.resolve(root, 'public', relativePath);
  }
  return modelUrl;
}