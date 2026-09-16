// Warm Dawn's native pipeline cache without blocking ORT's synchronous kernel setup.
// This runs only in our dedicated model Worker, never in the page's JS realm.
const CACHE_NAME = 'shinobu-webgpu-shaders-v1';
const CACHE_URL = 'https://shinobu.invalid/webgpu-shaders';
// ponytail: keep the first 256 shapes per Worker; add eviction only if real workloads exceed this.
const MAX_SHADERS = 256;
const MAX_BYTES = 2 * 1024 * 1024;
type Shader = { code: string; entryPoint?: string; constants?: Record<string, number> };

function validShader(value: unknown): value is Shader {
  if (!value || typeof value !== 'object') return false;
  const shader = value as Shader;
  return typeof shader.code === 'string'
    && (shader.entryPoint === undefined || typeof shader.entryPoint === 'string')
    && (shader.constants === undefined || (shader.constants !== null
      && typeof shader.constants === 'object' && !Array.isArray(shader.constants)
      && Object.values(shader.constants).every(value => typeof value === 'number' && Number.isFinite(value))));
}

export function warmDeviceShaders(device: GPUDevice, cache: Promise<Cache | undefined>, key: string): void {
  const createModule = device.createShaderModule.bind(device);
  const createPipeline = device.createComputePipeline.bind(device);
  const modules = new WeakMap<GPUShaderModule, string>();
  const captured = new Map<string, Shader>();
  const pipelines: GPUComputePipeline[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lost = false;
  void device.lost.then(() => { lost = true; pipelines.length = 0; });

  device.createShaderModule = descriptor => {
    const module = createModule(descriptor);
    if (!descriptor.compilationHints) modules.set(module, descriptor.code);
    return module;
  };
  device.createComputePipeline = descriptor => {
    const pipeline = createPipeline(descriptor);
    const code = modules.get(descriptor.compute.module);
    // Explicit layouts and module compilation hints are outside ORT's current path.
    if (code && descriptor.layout === 'auto') {
      const shader: Shader = { code, entryPoint: descriptor.compute.entryPoint, constants: descriptor.compute.constants };
      const serialized = JSON.stringify(shader);
      if (!captured.has(serialized) && captured.size < MAX_SHADERS && bytes + serialized.length * 2 <= MAX_BYTES) {
        captured.set(serialized, shader);
        bytes += serialized.length * 2;
        clearTimeout(timer);
        timer = setTimeout(() => {
          void cache.then(store => store?.put(CACHE_URL,
            new Response(JSON.stringify({ key, shaders: [...captured.values()] }))))
            .catch(() => {}); // Storage is optional (quota, private mode, origin eviction).
        }, 500);
      }
    }
    return pipeline;
  };

  // Do not await: compilation overlaps model loading. Failed or missing shaders
  // still go through ORT's normal createComputePipeline call.
  void (async () => {
    const response = await (await cache)?.match(CACHE_URL);
    if (!response) return;
    const text = await response.text();
    if (text.length * 2 > MAX_BYTES) return;
    const record = JSON.parse(text);
    if (record.key !== key || !Array.isArray(record.shaders)
      || record.shaders.length > MAX_SHADERS || !record.shaders.every(validShader)) return;
    const shaders: Shader[] = record.shaders;
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (!lost && next < shaders.length) {
        const shader = shaders[next++];
        try {
          const pipeline = await device.createComputePipelineAsync({
            layout: 'auto', compute: { module: createModule({ code: shader.code }),
              entryPoint: shader.entryPoint, constants: shader.constants },
          });
          if (!lost) pipelines.push(pipeline);
        } catch { /* Best effort; never change inference or provider fallback. */ }
      }
    }));
  })().catch(() => {});
}

let installed = false;
export function installShaderWarmup(ortVersion: string): void {
  if (installed || typeof GPUAdapter === 'undefined' || typeof caches === 'undefined'
    || !/Chrom(?:e|ium)\//.test(navigator.userAgent)) return;
  installed = true;
  let cache: Promise<Cache | undefined>;
  try { cache = caches.open(CACHE_NAME).catch(() => undefined); }
  catch { return; }
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (descriptor) {
    const device = await requestDevice.call(this, descriptor);
    try {
      const info = this.info;
      const limits: Record<string, number> = {};
      for (const name in device.limits) {
        const value = device.limits[name as keyof GPUSupportedLimits];
        if (typeof value === 'number') limits[name] = value;
      }
      const key = JSON.stringify([ortVersion, navigator.userAgent,
        info.vendor, info.architecture, info.device, info.description,
        [...device.features].sort(), limits]);
      warmDeviceShaders(device, cache, key);
    } catch { /* Unsupported browser details must not prevent device creation. */ }
    return device;
  };
}
