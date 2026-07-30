import {
  configureOnnxWorkerBootstrap,
  createSession,
  disposeAll,
  disposeSession,
  runInference,
} from '../../../../src/runtime/onnxWorkerBridge';
import onnxWorkerScriptUrl from '../../../../src/workers/onnx-worker.ts?worker&url';
import type {
  InferenceResult,
  TensorTransport,
  WorkerSessionHandle,
} from '../../../../src/runtime/onnxWorkerTypes';
import type { RuntimeProvider } from '../../../../src/runtime/onnxTypes';
import { createInstalledModelAssetSource } from './installedModelSource';
import {
  WEB_MODEL_PACKAGE,
  type WebModelAsset,
} from './modelPackage';
import { runSyntheticProductionCanary } from './productionCanary';

configureOnnxWorkerBootstrap({
  scriptUrl: onnxWorkerScriptUrl,
  ortPath: '/ort/',
  allowBlobFallback: true,
});

export type ModelCapabilityProgress = {
  completed: number;
  total: number;
  modelId: string;
};

export type ModelCapabilityResult = {
  ok: boolean;
  provider?: 'webgpu' | 'wasm';
  error?: string;
};

type ModelProbeCacheRecord = {
  fingerprint: string;
  provider: 'webgpu' | 'wasm';
};

type ModelProbeSpec = {
  assetId: string;
  imageDims: readonly [number, number, number, number];
  maskDims?: readonly [number, number, number, number];
};

type ModelCapabilityDependencies = {
  createSource: typeof createInstalledModelAssetSource;
  createSession: typeof createSession;
  runInference: typeof runInference;
  disposeSession: typeof disposeSession;
  disposeAll: typeof disposeAll;
  runCanary: (options: { signal?: AbortSignal }) => Promise<void>;
};

const MODEL_PROBE_CACHE_KEY = 'shinobu:production-model-capability:v2';
const MODEL_PROBE_SPECS: readonly ModelProbeSpec[] = [
  { assetId: 'detector', imageDims: [1, 3, 1024, 1024] },
  { assetId: 'bubble', imageDims: [1, 3, 640, 640] },
  { assetId: 'paddleocr-v6-medium', imageDims: [1, 3, 48, 320] },
  {
    assetId: 'inpaint',
    imageDims: [1, 3, 512, 512],
    maskDims: [1, 1, 512, 512],
  },
];

const defaultDependencies: ModelCapabilityDependencies = {
  createSource: createInstalledModelAssetSource,
  createSession,
  runInference,
  disposeSession,
  disposeAll,
  runCanary: runSyntheticProductionCanary,
};

function elementCount(dims: readonly number[]): number {
  return dims.reduce((total, dimension) => total * dimension, 1);
}

export function representativeFeeds(
  handle: Pick<WorkerSessionHandle, 'inputNames'>,
  spec: ModelProbeSpec,
): Record<string, TensorTransport> {
  const feeds: Record<string, TensorTransport> = {};
  for (const inputName of handle.inputNames) {
    const dims = spec.maskDims && /mask/iu.test(inputName)
      ? spec.maskDims
      : spec.imageDims;
    feeds[inputName] = {
      data: new Float32Array(elementCount(dims)),
      dims: [...dims],
      type: 'float32',
    };
  }
  return feeds;
}

function validateInferenceResult(modelId: string, result: InferenceResult): void {
  if (result.error) throw new Error(result.error);
  const outputs = Object.values(result.outputs);
  if (outputs.length === 0 || outputs.some((output) => output.data.length === 0)) {
    throw new Error(`${modelId} 未返回有效输出`);
  }
}

function cacheFingerprint(backend: 'webgpu' | 'wasm'): string {
  return JSON.stringify({
    version: WEB_MODEL_PACKAGE.version,
    backend,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
    crossOriginIsolated: globalThis.crossOriginIsolated,
  });
}

function readCachedSuccess(backend: 'webgpu' | 'wasm'): 'webgpu' | 'wasm' | undefined {
  try {
    const raw = localStorage.getItem(MODEL_PROBE_CACHE_KEY);
    if (!raw) return undefined;
    const record = JSON.parse(raw) as Partial<ModelProbeCacheRecord>;
    if (
      record.fingerprint !== cacheFingerprint(backend)
      || (record.provider !== 'webgpu' && record.provider !== 'wasm')
    ) {
      return undefined;
    }
    return record.provider;
  } catch {
    return undefined;
  }
}

function cacheSuccess(
  backend: 'webgpu' | 'wasm',
  provider: 'webgpu' | 'wasm',
): void {
  try {
    const record: ModelProbeCacheRecord = {
      fingerprint: cacheFingerprint(backend),
      provider,
    };
    localStorage.setItem(MODEL_PROBE_CACHE_KEY, JSON.stringify(record));
  } catch {
    // The current page can still use a successful probe when storage is blocked.
  }
}

function findAsset(assetId: string): WebModelAsset {
  const asset = WEB_MODEL_PACKAGE.assets.find((candidate) => candidate.id === assetId);
  if (!asset) throw new Error(`模型清单缺少能力测试资源: ${assetId}`);
  return asset;
}

export async function probeInstalledProductionModels(options: {
  backend: 'webgpu' | 'wasm';
  signal?: AbortSignal;
  onProgress?: (progress: ModelCapabilityProgress) => void;
  dependencies?: Partial<ModelCapabilityDependencies>;
  useCache?: boolean;
  runFullCanary?: boolean;
}): Promise<ModelCapabilityResult> {
  const {
    backend,
    signal,
    onProgress,
    dependencies: overrides,
    useCache = true,
    runFullCanary = false,
  } = options;
  const cachedProvider = useCache ? readCachedSuccess(backend) : undefined;
  if (cachedProvider) {
    return { ok: true, provider: cachedProvider };
  }
  const dependencies = { ...defaultDependencies, ...overrides };
  const installed = await dependencies.createSource();
  let effectiveProvider: 'webgpu' | 'wasm' = backend;
  const total = MODEL_PROBE_SPECS.length + (runFullCanary ? 1 : 0);
  try {
    for (let index = 0; index < MODEL_PROBE_SPECS.length; index += 1) {
      if (signal?.aborted) throw signal.reason;
      const spec = MODEL_PROBE_SPECS[index];
      const asset = findAsset(spec.assetId);
      onProgress?.({
        completed: index,
        total,
        modelId: spec.assetId,
      });
      const modelUrl = installed.source.resolveAsset(
        asset.url,
        installed.source.manifestUrl(),
      );
      const preferred: RuntimeProvider[] = backend === 'webgpu'
        ? ['webgpu', 'wasm']
        : ['wasm'];
      const session = await dependencies.createSession(
        `web-capability-${spec.assetId}`,
        modelUrl,
        preferred,
      );
      if (session.provider !== 'webgpu') effectiveProvider = 'wasm';
      try {
        const result = await dependencies.runInference(
          session.sessionId,
          representativeFeeds(session, spec),
        );
        validateInferenceResult(spec.assetId, result);
      } finally {
        await dependencies.disposeSession(session.sessionId);
      }
    }
    if (runFullCanary) {
      onProgress?.({
        completed: MODEL_PROBE_SPECS.length,
        total,
        modelId: 'pipeline-canary',
      });
      await dependencies.runCanary({ signal });
    }
    onProgress?.({
      completed: total,
      total,
      modelId: 'complete',
    });
    cacheSuccess(backend, effectiveProvider);
    return { ok: true, provider: effectiveProvider };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    installed.dispose();
    await dependencies.disposeAll().catch(() => undefined);
  }
}
