import type { RuntimeProvider } from './onnxTypes';
import type { OnnxSessionOptions } from './onnxSessionOptions';
import type { WorkerSessionHandle } from './onnxWorkerTypes';
import { createSession, disposeAll, disposeSession } from './onnxBridge';
import { serializeOnnxSessionOptions } from './onnxSessionOptions';
import { recordPerfRuntimeEvent } from '../shared/perfTrace';
import {
  createOriginModelAssetSource,
  type ModelAssetSource,
} from './modelSource';
import { isNodeRuntime } from './runtimeTarget';
import { ProviderSessionContractError } from './providerExecution';

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
// Manifest loading — Node uses fs (dynamic import), Browser uses fetch
// ---------------------------------------------------------------------------

let manifestCache: ManifestData | null = null;
let modelAssetSource = createOriginModelAssetSource();

export function configureModelAssetSource(source: ModelAssetSource): void {
  if (
    manifestCache
    || sessionCache.size > 0
    || sessionPromiseCache.size > 0
  ) {
    throw new Error('模型来源必须在清单或 Session 加载前配置');
  }
  modelAssetSource = source;
}

async function loadManifestNode(): Promise<ManifestData> {
  const { loadManifestNode: load } = await import('./modelRegistryNode');
  return load();
}

async function loadManifestBrowser(): Promise<ManifestData> {
  const manifestUrl = modelAssetSource.manifestUrl();
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
  const data = isNodeRuntime ? await loadManifestNode() : await loadManifestBrowser();
  manifestCache = data;
  return data;
}

// ---------------------------------------------------------------------------
// Model URL resolution — Node uses file path, Browser uses URL
// ---------------------------------------------------------------------------

function normalizeRuntime(value: unknown): RuntimeProvider[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('模型清单 runtime 必须声明非空 provider 顺序');
  }
  const out: RuntimeProvider[] = [];
  for (const item of value) {
    if (
      item !== 'webnn'
      && item !== 'webgpu'
      && item !== 'wasm'
    ) {
      throw new Error('模型清单 runtime 包含不支持的 provider');
    }
    if (out.includes(item)) {
      throw new Error('模型清单 runtime 不得包含重复 provider');
    }
    out.push(item);
  }
  // Browser production follows the manifest exactly. Node is a benchmark/test
  // adapter and maps a valid production declaration to its local EPs.
  return isNodeRuntime ? ['cuda', 'cpu'] : out;
}

function resolveModelAssetUrl(url: string): string {
  if (isNodeRuntime) {
    // In Node, model URLs are resolved to local file paths later
    // by resolveModelFilePath in modelRegistryNode.ts
    return url;
  }
  return modelAssetSource.resolveAsset(url, modelAssetSource.manifestUrl());
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
  const finalUrl = isNodeRuntime ? await resolveModelFilePath(resolvedUrl) : resolvedUrl;
  return {
    ...model,
    url: finalUrl,
    dictUrl: model.dictUrl ? (isNodeRuntime ? await resolveModelFilePath(resolveModelAssetUrl(model.dictUrl)) : resolveModelAssetUrl(model.dictUrl)) : undefined,
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
  provider: RuntimeProvider,
  sessionOptions?: OnnxSessionOptions
): Promise<WorkerSessionHandle> {
  const model = await getModel(name);
  const sessionOptionsKey = serializeOnnxSessionOptions(sessionOptions);
  const cacheKey = `${name}:${provider}:${sessionOptionsKey}`;
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
    provider,
    message: `开始创建模型 Session: ${name}`,
    data: { sessionOptionsKey },
  });
  const creation = createSession(name, model.url, provider, sessionOptions)
    .then(async (handle) => {
      if (handle.provider !== provider) {
        let cleanup: 'succeeded' | 'failed' = 'succeeded';
        let recovery:
          | 'not-required'
          | 'runtime-reset'
          | 'runtime-reset-failed' = 'not-required';
        try {
          await disposeSession(handle.sessionId);
        } catch {
          cleanup = 'failed';
          sessionCache.clear();
          sessionPromiseCache.clear();
          try {
            await disposeAll();
            recovery = 'runtime-reset';
          } catch {
            recovery = 'runtime-reset-failed';
          }
        }
        throw new ProviderSessionContractError(
          provider,
          handle.provider,
          cleanup,
          recovery,
        );
      }
      sessionCache.set(cacheKey, handle);
      recordPerfRuntimeEvent({
        kind: 'session-create-complete',
        model: name,
        provider: handle.provider,
        message: `模型 Session 创建完成: ${name}`,
        data: {
          sessionId: handle.sessionId,
          webnnDeviceType: handle.webnnDeviceType,
        },
      });
      return handle;
    })
    .catch((error) => {
      recordPerfRuntimeEvent({
        kind: 'session-create-complete',
        model: name,
        provider,
        message: `模型 Session 创建失败: ${name}`,
        data: { sessionOptionsKey },
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
