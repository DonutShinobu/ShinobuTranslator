import {
  currentWebDeviceSignals,
  detectWebDeviceProfile,
  type WebDeviceProfile,
  type WebSupportLevel,
} from './deviceProfile';

export type WebRuntimeBackend = 'webgpu' | 'wasm';

export type WebRuntimeCapability = {
  ok: boolean;
  reason?: string;
  supportLevel: WebSupportLevel;
  backend: WebRuntimeBackend;
  workPixelBudget: number;
  storagePersistent: boolean;
  wasmThreads: boolean;
  webgpu: boolean;
};

type CapabilityCacheRecord = {
  schemaVersion: 1;
  fingerprint: string;
  modelVersion: string;
  result: WebRuntimeCapability;
};

type GpuDeviceLike = {
  limits?: { maxTextureDimension2D?: number };
  lost?: Promise<unknown>;
  destroy?: () => void;
};

type GpuAdapterLike = {
  requestDevice(): Promise<GpuDeviceLike>;
};

type NavigatorWithGpu = Navigator & {
  gpu?: {
    requestAdapter(options?: { powerPreference?: 'high-performance' | 'low-power' }):
      Promise<GpuAdapterLike | null>;
  };
};

const CAPABILITY_CACHE_KEY = 'shinobu:web-runtime-capability:v1';

function capabilityFingerprint(): string {
  const signals = currentWebDeviceSignals();
  return JSON.stringify({
    origin: globalThis.location.origin,
    userAgent: signals.userAgent,
    maxTouchPoints: signals.maxTouchPoints,
    deviceMemory: signals.deviceMemory ?? null,
    hardwareConcurrency: signals.hardwareConcurrency,
    mobileHint: signals.mobileHint ?? null,
    debugMode: signals.debugMode ?? false,
    crossOriginIsolated: globalThis.crossOriginIsolated,
  });
}

function readCachedCapability(modelVersion: string): WebRuntimeCapability | null {
  try {
    const raw = localStorage.getItem(CAPABILITY_CACHE_KEY);
    if (!raw) return null;
    const record = JSON.parse(raw) as Partial<CapabilityCacheRecord>;
    if (
      record.schemaVersion !== 1
      || record.modelVersion !== modelVersion
      || record.fingerprint !== capabilityFingerprint()
      || record.result?.ok !== true
    ) {
      return null;
    }
    return record.result;
  } catch {
    return null;
  }
}

function cacheCapability(modelVersion: string, result: WebRuntimeCapability): void {
  if (!result.ok) return;
  const record: CapabilityCacheRecord = {
    schemaVersion: 1,
    fingerprint: capabilityFingerprint(),
    modelVersion,
    result,
  };
  try {
    localStorage.setItem(CAPABILITY_CACHE_KEY, JSON.stringify(record));
  } catch {
    // A successful probe remains valid for the current page when storage is blocked.
  }
}

function failedCapability(
  profile: WebDeviceProfile,
  reason: string,
  patch: Partial<WebRuntimeCapability> = {},
): WebRuntimeCapability {
  return {
    ok: false,
    reason,
    supportLevel: profile.supportLevel,
    backend: 'wasm',
    workPixelBudget: profile.initialWorkPixelBudget,
    storagePersistent: false,
    wasmThreads: false,
    webgpu: false,
    ...patch,
  };
}

async function probeOriginPrivateFileSystem(): Promise<{
  ok: boolean;
  persistent: boolean;
  reason?: string;
}> {
  if (
    !navigator.storage
    || typeof navigator.storage.getDirectory !== 'function'
    || typeof navigator.storage.estimate !== 'function'
  ) {
    return {
      ok: false,
      persistent: false,
      reason: '缺少浏览器私有文件系统或存储配额 API',
    };
  }
  const probeName = `.shinobu-capability-${crypto.randomUUID()}`;
  let root: FileSystemDirectoryHandle | null = null;
  try {
    await navigator.storage.estimate();
    root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(probeName, { create: true });
    const writer = await handle.createWritable();
    await writer.write('shinobu-opfs-probe');
    await writer.close();
    const content = await (await handle.getFile()).text();
    if (content !== 'shinobu-opfs-probe') {
      return {
        ok: false,
        persistent: false,
        reason: '浏览器私有文件系统读写校验失败',
      };
    }
    const alreadyPersistent = typeof navigator.storage.persisted === 'function'
      ? await navigator.storage.persisted()
      : false;
    const persistent = alreadyPersistent || (
      typeof navigator.storage.persist === 'function'
      && await navigator.storage.persist()
    );
    return { ok: true, persistent };
  } catch (error) {
    return {
      ok: false,
      persistent: false,
      reason: `浏览器私有文件系统不可用: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    if (root) {
      await root.removeEntry(probeName).catch(() => undefined);
    }
  }
}

function targetCanvasDimensions(pixelBudget: number): { width: number; height: number } {
  const width = Math.min(8_192, Math.max(1, Math.floor(Math.sqrt(pixelBudget * 1.5))));
  return {
    width,
    height: Math.max(1, Math.floor(pixelBudget / width)),
  };
}

async function probeWebGpu(targetLongEdge: number): Promise<boolean> {
  const gpu = (navigator as NavigatorWithGpu).gpu;
  if (!gpu) return false;
  let device: GpuDeviceLike | null = null;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter) return false;
    device = await adapter.requestDevice();
    const maxTextureDimension = Number(device.limits?.maxTextureDimension2D ?? 0);
    return (
      maxTextureDimension >= targetLongEdge
      && device.lost instanceof Promise
    );
  } catch {
    return false;
  } finally {
    device?.destroy?.();
  }
}

async function probeWorkerCanvasAndOrt(
  width: number,
  height: number,
): Promise<{ ok: boolean; reason?: string }> {
  const sourceCanvas = new OffscreenCanvas(1, 1);
  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) return { ok: false, reason: '无法创建 OffscreenCanvas 2D 上下文' };
  sourceContext.fillStyle = '#ffffff';
  sourceContext.fillRect(0, 0, 1, 1);
  const bitmap = sourceCanvas.transferToImageBitmap();
  const worker = new Worker(new URL('./capability.worker.ts', import.meta.url), {
    type: 'module',
    name: 'shinobu-capability-probe',
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: { ok: boolean; reason?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      worker.terminate();
      resolve(result);
    };
    const timeout = globalThis.setTimeout(() => {
      finish({ ok: false, reason: 'Worker、目标 Canvas 或 ORT 最小推理测试超时' });
    }, 30_000);

    worker.addEventListener('message', (event: MessageEvent<unknown>) => {
      const result = event.data;
      if (
        result
        && typeof result === 'object'
        && 'ok' in result
        && typeof result.ok === 'boolean'
      ) {
        finish({
          ok: result.ok,
          reason: 'reason' in result && typeof result.reason === 'string'
            ? result.reason
            : undefined,
        });
      } else {
        finish({ ok: false, reason: 'Worker 能力测试返回无效结果' });
      }
    }, { once: true });
    worker.addEventListener('error', (event) => {
      finish({ ok: false, reason: event.message || 'module Worker 启动失败' });
    }, { once: true });
    worker.postMessage({ bitmap, width, height }, [bitmap]);
  });
}

export async function probeWebRuntimeCapability(
  modelVersion = 'unknown',
  options: { useCache?: boolean } = {},
): Promise<WebRuntimeCapability> {
  const profile = detectWebDeviceProfile();
  const cached = options.useCache === false ? null : readCachedCapability(modelVersion);
  if (cached) return cached;
  if (profile.supportLevel === 'unsupported') {
    return failedCapability(profile, '当前浏览器或系统不在首发本地推理支持范围内');
  }
  if (!globalThis.isSecureContext) {
    return failedCapability(profile, '需要 HTTPS 或 localhost 安全上下文');
  }
  if (
    typeof Worker !== 'function'
    || typeof OffscreenCanvas !== 'function'
    || typeof createImageBitmap !== 'function'
  ) {
    return failedCapability(profile, '缺少 Worker、OffscreenCanvas 或 ImageBitmap');
  }

  const storage = await probeOriginPrivateFileSystem();
  if (!storage.ok) return failedCapability(profile, storage.reason ?? '本地存储能力测试失败');

  const wasmThreads = Boolean(
    globalThis.crossOriginIsolated
    && typeof SharedArrayBuffer === 'function',
  );
  const initialDimensions = targetCanvasDimensions(profile.initialWorkPixelBudget);
  const webgpu = await probeWebGpu(Math.max(initialDimensions.width, initialDimensions.height));
  let workPixelBudget = profile.initialWorkPixelBudget;
  if (!webgpu) {
    workPixelBudget = Math.min(workPixelBudget, profile.mobile ? 4_000_000 : 6_000_000);
  }
  if (!wasmThreads) {
    workPixelBudget = Math.min(workPixelBudget, profile.mobile ? 3_000_000 : 4_000_000);
  }
  const dimensions = targetCanvasDimensions(workPixelBudget);
  const worker = await probeWorkerCanvasAndOrt(dimensions.width, dimensions.height);
  if (!worker.ok) {
    return failedCapability(profile, worker.reason ?? '本地推理能力测试失败', {
      backend: webgpu ? 'webgpu' : 'wasm',
      workPixelBudget,
      storagePersistent: storage.persistent,
      wasmThreads,
      webgpu,
    });
  }

  const result: WebRuntimeCapability = {
    ok: true,
    supportLevel: profile.supportLevel,
    backend: webgpu ? 'webgpu' : 'wasm',
    workPixelBudget,
    storagePersistent: storage.persistent,
    wasmThreads,
    webgpu,
  };
  cacheCapability(modelVersion, result);
  return result;
}
