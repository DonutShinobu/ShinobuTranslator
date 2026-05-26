import type { RuntimeProvider } from './onnxTypes';
import type { WorkerSessionHandle } from './onnxWorkerTypes';
import { createSession } from './onnxBridge';
import { resolveAssetUrl } from '../shared/assetUrl';

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

// ---------------------------------------------------------------------------
// Environment detection — Node vs Browser
// ---------------------------------------------------------------------------

const isNode = typeof process !== 'undefined' && !!process.versions?.node;

// ---------------------------------------------------------------------------
// Manifest loading — Node uses fs, Browser uses fetch
// ---------------------------------------------------------------------------

let manifestCache: ManifestData | null = null;

// ---------------------------------------------------------------------------
// Project root resolution — works in CJS (__dirname), ESM (import.meta.url),
// and Vite-bundled environments
// ---------------------------------------------------------------------------

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
  if (typeof import.meta !== 'undefined' && typeof import.meta.url === 'string') {
    const { fileURLToPath } = await import('url');
    const thisFile = fileURLToPath(import.meta.url);
    _projectRoot = path.resolve(path.dirname(thisFile), '..', '..');
    return _projectRoot;
  }

  // Strategy 3: walk up from process.cwd() looking for public/models/models.json
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'public', 'models', 'models.json'))) {
      _projectRoot = dir;
      return dir;
    }
    const parent = path.resolve(dir, '..');
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  throw new Error('无法定位项目根目录 (models.json)');
}

async function loadManifestNode(): Promise<ManifestData> {
  const fs = await import('fs');
  const path = await import('path');
  const root = await getProjectRoot();
  const manifestPath = path.resolve(root, 'public', 'models', 'models.json');
  const raw = fs.readFileSync(manifestPath, 'utf-8');
  return JSON.parse(raw) as ManifestData;
}

async function loadManifestBrowser(): Promise<ManifestData> {
  const manifestUrl = resolveAssetUrl('models/models.json');
  const response = await fetch(manifestUrl, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`模型清单读取失败: ${response.status}`);
  }
  return (await response.json()) as ManifestData;
}

export async function loadManifest(): Promise<ManifestData> {
  if (manifestCache) {
    return manifestCache;
  }
  const data = isNode ? await loadManifestNode() : await loadManifestBrowser();
  manifestCache = data;
  return data;
}

// ---------------------------------------------------------------------------
// Model URL resolution — Node uses file path, Browser uses URL
// ---------------------------------------------------------------------------

function normalizeRuntime(value: unknown): RuntimeProvider[] {
  if (!Array.isArray(value)) {
    if (isNode) {
      return ['cuda'];
    }
    return ['webnn', 'wasm'];
  }
  const out: RuntimeProvider[] = [];
  for (const item of value) {
    if (item === 'webnn' || item === 'webgpu' || item === 'wasm' || item === 'cuda' || item === 'cpu') {
      if (!out.includes(item)) {
        out.push(item);
      }
    }
  }
  if (out.length === 0) {
    if (isNode) {
      out.push('cuda');
    } else {
      out.push('webnn', 'wasm');
    }
  }
  return out;
}

function isAbsoluteUrl(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(url);
}

function resolveModelAssetUrl(url: string): string {
  if (isNode) {
    // In Node, resolve model URLs to local file paths
    // Absolute paths (e.g. /home/user/models/xxx.onnx) are kept as-is
    // Relative paths are resolved relative to public/models/
    if (url.startsWith('/') && !isAbsoluteUrl(url)) {
      // This is a relative URL like /models/xxx.onnx — resolve to file path
      // We'll resolve it in getModel() using path.join
      return url;
    }
    if (isAbsoluteUrl(url)) {
      // Could be file:// or http:// — keep as-is for now
      return url;
    }
    return url;
  }
  // Browser: resolve as URL
  if (isAbsoluteUrl(url)) {
    return url;
  }
  if (url.startsWith('//')) {
    return `${window.location.protocol}${url}`;
  }
  if (url.startsWith('/')) {
    return resolveAssetUrl(url);
  }
  const manifestUrl = resolveAssetUrl('models/models.json');
  return new URL(url, manifestUrl).toString();
}

async function resolveModelFilePath(modelUrl: string): Promise<string> {
  if (isAbsoluteUrl(modelUrl) && modelUrl.startsWith('file://')) {
    return modelUrl.slice('file://'.length);
  }
  // If it's a URL-style path like /models/xxx.onnx, resolve to local file path
  if (modelUrl.startsWith('/') && !isAbsoluteUrl(modelUrl)) {
    const path = await import('path');
    const root = await getProjectRoot();
    // Strip leading / so path.resolve treats it as relative, not absolute
    const relativePath = modelUrl.slice(1);
    return path.resolve(root, 'public', relativePath);
  }
  // If it's already an absolute local file path, return as-is
  return modelUrl;
}

export async function getModel(name: 'detector' | 'ocr' | 'inpaint' | 'bubble' | 'paddleocr_rec'): Promise<ManifestModel> {
  const manifest = await loadManifest();
  const model = manifest.models?.[name];
  if (!model) {
    throw new Error(`manifest 缺少模型定义: ${name}`);
  }
  const resolvedUrl = resolveModelAssetUrl(model.url);
  const finalUrl = isNode ? await resolveModelFilePath(resolvedUrl) : resolvedUrl;
  return {
    ...model,
    url: finalUrl,
    dictUrl: model.dictUrl ? (isNode ? await resolveModelFilePath(resolveModelAssetUrl(model.dictUrl)) : resolveModelAssetUrl(model.dictUrl)) : undefined,
    runtime: normalizeRuntime(model.runtime),
  };
}

// ---------------------------------------------------------------------------
// Session cache
// ---------------------------------------------------------------------------

const sessionCache = new Map<string, WorkerSessionHandle>();

export async function getModelSession(
  name: 'detector' | 'ocr' | 'inpaint' | 'bubble' | 'paddleocr_rec',
  preferred?: RuntimeProvider[]
): Promise<WorkerSessionHandle> {
  const model = await getModel(name);
  const runtime = preferred && preferred.length > 0 ? preferred : model.runtime ?? (isNode ? ['cuda'] : ['wasm']);
  const cacheKey = `${name}:${runtime.join(',')}`;
  const cached = sessionCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const handle = await createSession(name, model.url, runtime);
  sessionCache.set(cacheKey, handle);
  return handle;
}