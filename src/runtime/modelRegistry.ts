import { resolveAssetUrl } from '../shared/assetUrl';
import { createSession, type RuntimeProvider, type SessionHandle } from './onnx';

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

const manifestUrl = resolveAssetUrl('models/manifest.json');
let manifestCache: ManifestData | null = null;
const sessionCache = new Map<string, SessionHandle>();

function normalizeRuntime(value: unknown): RuntimeProvider[] {
  if (!Array.isArray(value)) {
    return ['webnn', 'wasm'];
  }
  const out: RuntimeProvider[] = [];
  for (const item of value) {
    if (item === 'webnn' || item === 'webgpu' || item === 'wasm') {
      if (!out.includes(item)) {
        out.push(item);
      }
    }
  }
  if (out.length === 0) {
    out.push('webnn', 'wasm');
  }
  return out;
}

function isAbsoluteUrl(url: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(url);
}

function resolveModelAssetUrl(url: string): string {
  if (isAbsoluteUrl(url)) {
    return url;
  }
  if (url.startsWith('//')) {
    return `${window.location.protocol}${url}`;
  }
  if (url.startsWith('/')) {
    return resolveAssetUrl(url);
  }
  return new URL(url, manifestUrl).toString();
}

export async function loadManifest(): Promise<ManifestData> {
  if (manifestCache) {
    return manifestCache;
  }
  const response = await fetch(manifestUrl, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`模型清单读取失败: ${response.status}`);
  }
  const data = (await response.json()) as ManifestData;
  manifestCache = data;
  return data;
}

export async function getModel(name: 'detector' | 'ocr' | 'inpaint'): Promise<ManifestModel> {
  const manifest = await loadManifest();
  const model = manifest.models?.[name];
  if (!model) {
    throw new Error(`manifest 缺少模型定义: ${name}`);
  }
  return {
    ...model,
    url: resolveModelAssetUrl(model.url),
    dictUrl: model.dictUrl ? resolveModelAssetUrl(model.dictUrl) : undefined,
    runtime: normalizeRuntime(model.runtime),
  };
}

export async function getModelSession(
  name: 'detector' | 'ocr' | 'inpaint',
  preferred?: RuntimeProvider[]
): Promise<SessionHandle> {
  const model = await getModel(name);
  const runtime = preferred && preferred.length > 0 ? preferred : model.runtime ?? ['wasm'];
  const cacheKey = `${name}:${runtime.join(',')}`;
  const cached = sessionCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const handle = await createSession(model.url, runtime);
  sessionCache.set(cacheKey, handle);
  return handle;
}
