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
// Manifest loading — Node uses fs (dynamic import), Browser uses fetch
// ---------------------------------------------------------------------------

let manifestCache: ManifestData | null = null;

async function loadManifestNode(): Promise<ManifestData> {
  const { loadManifestNode: load } = await import('./modelRegistryNode');
  return load();
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
    // In Node, model URLs are resolved to local file paths later
    // by resolveModelFilePath in modelRegistryNode.ts
    if (url.startsWith('/') && !isAbsoluteUrl(url)) {
      return url;
    }
    if (isAbsoluteUrl(url)) {
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
  const { resolveModelFilePath: resolve } = await import('./modelRegistryNode');
  return resolve(modelUrl);
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