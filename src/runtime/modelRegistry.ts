import type { RuntimeProvider } from './onnxTypes';
import type { OnnxSessionOptions } from './onnxSessionOptions';
import type { WorkerSessionHandle } from './onnxWorkerTypes';
import { createSession, disposeAll, disposeSession } from './onnxBridge';
import { serializeOnnxSessionOptions } from './onnxSessionOptions';
import { resolveAssetUrl } from '../shared/assetUrl';
import { recordPerfRuntimeEvent } from '../shared/perfTrace';

type ManifestModel = {
  name: string;
  task: string;
  url: string;
  input: number[];
  runtime?: RuntimeProvider[];
  dictUrl?: string;
  normalize?: 'zero_to_one' | 'minus_one_to_one';
  channelOrder?: 'rgb' | 'bgr';
  outputNormalize?: 'zero_to_one' | 'minus_one_to_one' | 'zero_to_255';
  maskFill?: 'zero_before_normalize' | 'zero_after_normalize';
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
  if (isNode) {
    return ['cuda', 'cpu'];
  }
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

export type ModelName =
  | 'detector'
  | 'inpaint'
  | 'bubble'
  | 'paddleocr_v6_medium_rec';

export async function getModel(name: ModelName): Promise<ManifestModel> {
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
const sessionPromiseCache = new Map<string, Promise<WorkerSessionHandle>>();

export async function getModelSession(
  name: ModelName,
  preferred?: RuntimeProvider[],
  sessionOptions?: OnnxSessionOptions
): Promise<WorkerSessionHandle> {
  const model = await getModel(name);
  const runtime = preferred && preferred.length > 0 ? preferred : model.runtime ?? (isNode ? ['cuda'] : ['wasm']);
  const sessionOptionsKey = serializeOnnxSessionOptions(sessionOptions);
  const cacheKey = `${name}:${runtime.join(',')}:${sessionOptionsKey}`;
  const cached = sessionCache.get(cacheKey);
  if (cached) {
    recordPerfRuntimeEvent({
      kind: 'session-cache-hit',
      model: name,
      provider: cached.provider,
      message: `模型 Session 缓存命中: ${name}`,
      data: { cacheKey, sessionId: cached.sessionId },
    });
    return cached;
  }
  const pending = sessionPromiseCache.get(cacheKey);
  if (pending) {
    recordPerfRuntimeEvent({
      kind: 'session-cache-hit',
      model: name,
      message: `等待并发创建中的模型 Session: ${name}`,
      data: { cacheKey, pending: true },
    });
    return pending;
  }

  recordPerfRuntimeEvent({
    kind: 'session-create-start',
    model: name,
    message: `开始创建模型 Session: ${name}`,
    data: { preferredProviders: runtime, sessionOptionsKey },
  });
  const creation = createSession(name, model.url, runtime, sessionOptions)
    .then((handle) => {
      sessionCache.set(cacheKey, handle);
      recordPerfRuntimeEvent({
        kind: 'session-create-complete',
        model: name,
        provider: handle.provider,
        message: `模型 Session 创建完成: ${name}`,
        data: {
          sessionId: handle.sessionId,
          preferredProviders: runtime,
          webnnDeviceType: handle.webnnDeviceType,
        },
      });
      if (runtime.length > 0 && handle.provider !== runtime[0]) {
        recordPerfRuntimeEvent({
          kind: 'provider-fallback',
          model: name,
          provider: handle.provider,
          message: `模型 provider 已回退: ${name} ${runtime[0]} -> ${handle.provider}`,
          data: { preferredProviders: runtime, actualProvider: handle.provider },
        });
      }
      return handle;
    })
    .catch((error) => {
      recordPerfRuntimeEvent({
        kind: 'session-create-complete',
        model: name,
        message: `模型 Session 创建失败: ${name}`,
        data: { preferredProviders: runtime, sessionOptionsKey },
        error,
      });
      throw error;
    })
    .finally(() => {
      sessionPromiseCache.delete(cacheKey);
    });
  sessionPromiseCache.set(cacheKey, creation);
  return creation;
}

export async function disposeModelSession(name: ModelName): Promise<void> {
  for (const key of [...sessionCache.keys()]) {
    if (key.startsWith(`${name}:`)) {
      sessionCache.delete(key);
    }
  }
  await disposeSession(name);
}

export async function disposeAllModelSessions(): Promise<void> {
  sessionCache.clear();
  sessionPromiseCache.clear();
  manifestCache = null;
  await disposeAll();
}
