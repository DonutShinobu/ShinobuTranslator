import type { DiagnosticLogObserver } from '@shinobu/diagnostics';
import type { ModelRuntimePerformanceObserver } from '../contracts';
import type { OnnxSessionOptions } from './onnxSessionOptions';
import { serializeOnnxSessionOptions } from './onnxSessionOptions';
import type { RuntimeProvider } from './onnxTypes';
import type { WorkerSessionHandle } from './onnxWorkerTypes';
import type { ModelAssetSource } from './modelSource';

export type ManifestModel = {
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

export type ManifestData = {
  source?: string;
  note?: string;
  models: Record<string, ManifestModel>;
};

export type ModelName =
  | 'detector'
  | 'inpaint'
  | 'bubble'
  | 'paddleocr_v6_medium_rec';

export type ModelRegistryBackend = {
  createSession(
    modelKey: string,
    modelUrl: string,
    preferred: RuntimeProvider[],
    sessionOptions?: OnnxSessionOptions,
  ): Promise<WorkerSessionHandle>;
  disposeSession(sessionId: string): Promise<void>;
  disposeAll(): Promise<void>;
};

export type ModelRegistry = {
  readModel(name: ModelName): Promise<ManifestModel>;
  getSession(
    name: ModelName,
    preferred?: RuntimeProvider[],
    sessionOptions?: OnnxSessionOptions,
  ): Promise<WorkerSessionHandle>;
  releaseSession(name: ModelName): Promise<void>;
  dispose(): Promise<void>;
};

export type ModelRegistryOptions = {
  environment: 'browser' | 'node';
  source?: ModelAssetSource;
  backend: ModelRegistryBackend;
  loadManifest?: () => Promise<ManifestData>;
  resolveAsset?: (asset: string) => Promise<string> | string;
  observer?: DiagnosticLogObserver;
  performanceObserver?: ModelRuntimePerformanceObserver;
};

/** Creates an isolated manifest/session cache for one ModelRuntime instance. */
export function createModelRegistry(options: ModelRegistryOptions): ModelRegistry {
  let instanceManifest: ManifestData | null = null;
  const sessions = new Map<string, WorkerSessionHandle>();
  const pendingSessions = new Map<string, Promise<WorkerSessionHandle>>();

  const emit = (
    event: Parameters<NonNullable<ModelRuntimePerformanceObserver['recordRuntimeEvent']>>[0],
    level: 'info' | 'error' = 'info',
  ): void => {
    options.performanceObserver?.recordRuntimeEvent?.(event);
    options.observer?.emit({
      level,
      category: 'model.runtime',
      source: { context: 'worker', module: 'model-runtime/registry' },
      message: event.message,
      data: {
        kind: event.kind,
        model: event.model,
        provider: event.provider,
        ...event.data,
      },
      ...(event.error instanceof Error ? {
        error: {
          name: event.error.name,
          message: event.error.message,
          stack: event.error.stack,
        },
      } : {}),
    });
  };

  const readManifest = async (): Promise<ManifestData> => {
    if (instanceManifest) return instanceManifest;
    if (options.loadManifest) {
      instanceManifest = await options.loadManifest();
      return instanceManifest;
    }
    if (!options.source) {
      throw new Error('Browser ModelRuntime 缺少模型来源');
    }
    const response = await fetch(options.source.manifestUrl());
    if (!response.ok) {
      throw new Error(`模型清单读取失败: ${response.status}`);
    }
    instanceManifest = await response.json() as ManifestData;
    return instanceManifest;
  };

  const normalizeProviders = (value: unknown): RuntimeProvider[] => {
    if (options.environment === 'node') return ['cuda', 'cpu'];
    if (!Array.isArray(value)) return ['webnn', 'wasm'];
    const providers = value.filter((item): item is RuntimeProvider => (
      item === 'webnn' || item === 'webgpu' || item === 'wasm'
    ));
    return providers.length > 0 ? [...new Set(providers)] : ['webnn', 'wasm'];
  };

  const readModel = async (name: ModelName): Promise<ManifestModel> => {
    const manifest = await readManifest();
    const model = manifest.models[name];
    if (!model) throw new Error(`manifest 缺少模型定义: ${name}`);
    const resolveAsset = async (asset: string): Promise<string> => {
      if (options.resolveAsset) return options.resolveAsset(asset);
      if (!options.source) return asset;
      return options.source.resolveAsset(asset, options.source.manifestUrl());
    };
    return {
      ...model,
      url: await resolveAsset(model.url),
      dictUrl: model.dictUrl ? await resolveAsset(model.dictUrl) : undefined,
      runtime: normalizeProviders(model.runtime),
    };
  };

  const getSession = async (
    name: ModelName,
    preferred?: RuntimeProvider[],
    sessionOptions?: OnnxSessionOptions,
  ): Promise<WorkerSessionHandle> => {
    const model = await readModel(name);
    const runtime = preferred?.length
      ? preferred
      : model.runtime ?? (options.environment === 'node' ? ['cuda', 'cpu'] : ['wasm']);
    const sessionOptionsKey = serializeOnnxSessionOptions(sessionOptions);
    const cacheKey = `${name}:${runtime.join(',')}:${sessionOptionsKey}`;
    const cached = sessions.get(cacheKey);
    if (cached) {
      emit({
        kind: 'session-cache-hit',
        model: name,
        provider: cached.provider,
        message: `模型 Session 缓存命中: ${name}`,
        data: { cacheKey, sessionId: cached.sessionId },
      });
      return cached;
    }
    const pending = pendingSessions.get(cacheKey);
    if (pending) {
      emit({
        kind: 'session-cache-hit',
        model: name,
        message: `等待并发创建中的模型 Session: ${name}`,
        data: { cacheKey, pending: true },
      });
      return pending;
    }
    emit({
      kind: 'session-create-start',
      model: name,
      message: `开始创建模型 Session: ${name}`,
      data: { preferredProviders: runtime, sessionOptionsKey },
    });
    const creation = options.backend.createSession(
      name,
      model.url,
      runtime,
      sessionOptions,
    ).then((handle) => {
      sessions.set(cacheKey, handle);
      emit({
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
      if (runtime[0] !== handle.provider) {
        emit({
          kind: 'provider-fallback',
          model: name,
          provider: handle.provider,
          message: `模型 provider 已回退: ${name} ${runtime[0]} -> ${handle.provider}`,
          data: { preferredProviders: runtime, actualProvider: handle.provider },
        });
      }
      return handle;
    }).catch((error) => {
      emit({
        kind: 'session-create-complete',
        model: name,
        message: `模型 Session 创建失败: ${name}`,
        data: { preferredProviders: runtime, sessionOptionsKey },
        error,
      }, 'error');
      throw error;
    }).finally(() => {
      pendingSessions.delete(cacheKey);
    });
    pendingSessions.set(cacheKey, creation);
    return creation;
  };

  return Object.freeze({
    readModel,
    getSession,
    async releaseSession(name: ModelName) {
      for (const [cacheKey, handle] of [...sessions.entries()]) {
        if (!cacheKey.startsWith(`${name}:`)) continue;
        sessions.delete(cacheKey);
        await options.backend.disposeSession(handle.sessionId);
      }
    },
    async dispose() {
      await Promise.allSettled([...pendingSessions.values()]);
      sessions.clear();
      pendingSessions.clear();
      instanceManifest = null;
      await options.backend.disposeAll();
    },
  });
}
