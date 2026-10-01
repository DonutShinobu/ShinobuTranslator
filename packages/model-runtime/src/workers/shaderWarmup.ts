// Warm Dawn's native pipeline cache without blocking ORT's synchronous kernel setup.
// This runs only in our dedicated model Worker, never in the page's JS realm.
const CACHE_NAME = 'shinobu-webgpu-shaders-v1';
const CACHE_URL = 'https://shinobu.invalid/webgpu-shaders';
// ponytail: keep the first 256 shapes per Worker; add eviction only if real workloads exceed this.
const MAX_SHADERS = 256;
const MAX_BYTES = 2 * 1024 * 1024;
type Shader = { code: string; entryPoint?: string; constants?: Record<string, number> };
type ShaderRecord = { key: string; shaders: Shader[] };

function validShader(value: unknown): value is Shader {
  if (!value || typeof value !== 'object') return false;
  const shader = value as Shader;
  return typeof shader.code === 'string'
    && (shader.entryPoint === undefined || typeof shader.entryPoint === 'string')
    && (shader.constants === undefined || (shader.constants !== null
      && typeof shader.constants === 'object' && !Array.isArray(shader.constants)
      && Object.values(shader.constants).every(value => typeof value === 'number' && Number.isFinite(value))));
}

async function readShaderRecord(response?: Response): Promise<ShaderRecord | undefined> {
  if (!response) return;
  const text = await response.text();
  if (text.length * 2 > MAX_BYTES) return;
  const record = JSON.parse(text);
  if (typeof record?.key !== 'string' || !Array.isArray(record.shaders)
    || record.shaders.length === 0 || record.shaders.length > MAX_SHADERS
    || !record.shaders.every(validShader)) return;
  return record;
}

function compatibleTemplateKey(templateKey: string, deviceKey: string): boolean {
  try {
    const fingerprint = (key: string) => {
      const parts = JSON.parse(key);
      if (!Array.isArray(parts) || parts.length !== 8
        || !parts.slice(0, 6).every(value => typeof value === 'string')
        || !Array.isArray(parts[6]) || !parts[6].every(value => typeof value === 'string')
        || !parts[7] || typeof parts[7] !== 'object' || Array.isArray(parts[7])
        || !Object.values(parts[7]).every(value => typeof value === 'number' && Number.isFinite(value))) return;
      // A different Chromium UA can still generate identical WGSL. GPU capabilities
      // and ORT must match; model/asset hashes are checked by the build.
      return JSON.stringify([parts[0], ...parts.slice(2, 6), [...parts[6]].sort(),
        Object.entries(parts[7]).sort(([a], [b]) => a.localeCompare(b))]);
    };
    const expected = fingerprint(templateKey);
    return expected !== undefined && expected === fingerprint(deviceKey);
  } catch { return false; }
}

export function warmDeviceShaders(device: GPUDevice, cache: Promise<Cache | undefined>, key: string): void {
  const createModule = device.createShaderModule.bind(device);
  const createPipeline = device.createComputePipeline.bind(device);
  const reusePipelines = (globalThis as typeof globalThis & {
    __shinobuColdStartReuseShaderPipelines?: boolean;
  }).__shinobuColdStartReuseShaderPipelines === true;
  const modules = new WeakMap<GPUShaderModule, string>();
  const modulesByCode = new Map<string, GPUShaderModule>();
  const readyPipelines = new Map<string, GPUComputePipeline>();
  const captured = new Map<string, Shader>();
  const pipelines: GPUComputePipeline[] = [];
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lost = false;
  void device.lost.then(() => {
    lost = true;
    pipelines.length = 0;
    modulesByCode.clear();
    readyPipelines.clear();
  });
  const pipelineKey = (descriptor: GPUComputePipelineDescriptor): string | undefined => {
    const code = modules.get(descriptor.compute.module);
    if (descriptor.layout !== 'auto' || code === undefined) return;
    const constants = Object.entries(descriptor.compute.constants ?? {});
    if (!constants.every(([, value]) => Number.isFinite(value))) return;
    return JSON.stringify([code, descriptor.compute.entryPoint,
      constants.sort(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => [name, Object.is(value, -0) ? '-0' : value])]);
  };

  device.createShaderModule = descriptor => {
    const reusable = reusePipelines && !lost && !descriptor.compilationHints;
    if (reusable && modulesByCode.has(descriptor.code)) return modulesByCode.get(descriptor.code)!;
    const module = createModule(descriptor);
    if (!descriptor.compilationHints) modules.set(module, descriptor.code);
    if (reusable && modulesByCode.size < MAX_SHADERS) modulesByCode.set(descriptor.code, module);
    return module;
  };
  device.createComputePipeline = descriptor => {
    const id = reusePipelines && !lost ? pipelineKey(descriptor) : undefined;
    // Only asynchronously validated pipelines enter this cache. A miss still uses
    // the original synchronous ORT path and its error/provider handling.
    const pipeline = id === undefined ? createPipeline(descriptor)
      : readyPipelines.get(id) ?? createPipeline(descriptor);
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
    let record: ShaderRecord | undefined;
    try {
      const historical = await readShaderRecord(await (await cache)?.match(CACHE_URL));
      if (historical?.key === key) record = historical;
    } catch { /* A missing/denied historical cache can use the packaged seed. */ }
    let concurrency = 4;
    if (!record && (globalThis as typeof globalThis & {
      __shinobuColdStartShaderTemplates?: boolean;
    }).__shinobuColdStartShaderTemplates === true) {
      try {
        const response = await fetch(new URL(/* @vite-ignore */ 'webgpu-shader-templates.json', import.meta.url));
        const template = response.ok ? await readShaderRecord(response) : undefined;
        if (template && compatibleTemplateKey(template.key, key)) {
          record = template;
          concurrency = 8;
        }
      } catch { /* Offline/missing/incompatible templates leave native creation intact. */ }
    }
    if (!record) return;
    const shaders = record.shaders;
    let next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (!lost && next < shaders.length) {
        const shader = shaders[next++];
        try {
          const descriptor: GPUComputePipelineDescriptor = {
            layout: 'auto', compute: { module: device.createShaderModule({ code: shader.code }),
              entryPoint: shader.entryPoint, constants: shader.constants },
          };
          const pipeline = await device.createComputePipelineAsync(descriptor);
          if (!lost) {
            pipelines.push(pipeline);
            const id = reusePipelines ? pipelineKey(descriptor) : undefined;
            if (id !== undefined) readyPipelines.set(id, pipeline);
          }
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
