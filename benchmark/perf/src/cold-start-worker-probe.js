// Experimental instrumentation only; prepended to a built Worker by the experiment runner.
// Inputs are model-generated WGSL from one fixture, not a general production shader cache.
(() => {
  const config = globalThis.__coldStartExperiment;
  const emit = (data) => fetch(config.probeUrl, { method: 'POST', body: JSON.stringify(data) }).catch(() => {});
  const runs = [];
  if (config.capture || config.reusePipelines) {
    // Comlink calls enter the existing inference queue in this order. Session
    // creation can overlap them, so it must not replace the current model label.
    self.addEventListener('message', ({ data }) => {
      const method = data?.path?.at(-1);
      if (data?.type === 'APPLY' && ['runInference', 'runDetectWithGpuPreprocess'].includes(method)) {
        runs.push({ id: data.id, model: data.argumentList?.[0]?.value?.split(':')[0],
          reuse: { moduleHits: 0, pipelineHits: 0, pipelineMisses: 0, nativeSyncMs: 0 } });
      }
    });
    const post = self.postMessage.bind(self);
    self.postMessage = (data, ...args) => {
      const index = runs.findIndex(run => run.id === data?.id);
      if (index !== -1) {
        const [run] = runs.splice(index, 1);
        if (config.reusePipelines) emit({ kind: 'pipeline-reuse', model: run.model, ...run.reuse });
      }
      return post(data, ...args);
    };
  }
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (descriptor) {
    const device = await requestDevice.call(this, descriptor);
    const info = this.info;
    const limits = {};
    for (const name in device.limits) {
      if (typeof device.limits[name] === 'number') limits[name] = device.limits[name];
    }
    const key = JSON.stringify([config.ortVersion, navigator.userAgent,
      info.vendor, info.architecture, info.device, info.description,
      [...device.features].sort(), limits]);
    if (config.capture) emit({ kind: 'device', key });
    const shaders = new WeakMap();
    const modulesByCode = new Map();
    const readyPipelines = new Map();
    const createShaderModule = device.createShaderModule.bind(device);
    const createComputePipeline = device.createComputePipeline.bind(device);
    const createComputePipelineAsync = device.createComputePipelineAsync.bind(device);
    const pipelineKey = (desc) => desc.layout === 'auto' && shaders.has(desc.compute.module)
      ? JSON.stringify([shaders.get(desc.compute.module), desc.compute.entryPoint,
        Object.entries(desc.compute.constants ?? {}).sort(([a], [b]) => a.localeCompare(b))])
      : undefined;
    device.createShaderModule = (desc) => {
      const reusable = config.reusePipelines && !desc.compilationHints;
      if (reusable && modulesByCode.has(desc.code)) {
        if (runs[0]) runs[0].reuse.moduleHits++;
        return modulesByCode.get(desc.code);
      }
      const module = createShaderModule(desc);
      // Hints can contain layouts. Keep these descriptors on the native path.
      if (!desc.compilationHints) shaders.set(module, desc.code);
      if (reusable) modulesByCode.set(desc.code, module);
      return module;
    };
    device.createComputePipeline = (desc) => {
      if (config.capture) emit({ kind: 'shader', code: shaders.get(desc.compute.module),
        entryPoint: desc.compute.entryPoint, constants: desc.compute.constants, label: desc.label,
        model: runs[0]?.model });
      const id = config.reusePipelines ? pipelineKey(desc) : undefined;
      if (id !== undefined && readyPipelines.has(id)) {
        if (runs[0]) runs[0].reuse.pipelineHits++;
        return readyPipelines.get(id);
      }
      const start = performance.now();
      const pipeline = createComputePipeline(desc);
      if (config.reusePipelines && runs[0]) {
        runs[0].reuse.pipelineMisses++;
        runs[0].reuse.nativeSyncMs += performance.now() - start;
      }
      // Seed pipelines have completed asynchronous validation. Cache only those
      // rather than assuming a synchronously returned pipeline is valid.
      return pipeline;
    };
    if (config.reusePipelines) {
      device.createComputePipelineAsync = async (desc) => {
        const id = pipelineKey(desc);
        const pipeline = await createComputePipelineAsync(desc);
        if (id !== undefined) readyPipelines.set(id, pipeline);
        return pipeline;
      };
    }
    if (config.shaders?.length) {
      if (key !== config.templateKey) {
        emit({ kind: 'precompile-skipped', reason: 'device/runtime fingerprint differs' });
        return device;
      }
      const start = performance.now();
      let next = 0;
      // Keep pipelines alive so native caching can reuse them during the measured inference.
      const pipelines = [];
      const ready = Promise.all(Array.from({ length: config.concurrency }, async () => {
        while (next < config.shaders.length) {
          const shader = config.shaders[next++];
          pipelines.push(await device.createComputePipelineAsync({
            label: shader.label, layout: 'auto',
            compute: { module: device.createShaderModule({ code: shader.code }),
              entryPoint: shader.entryPoint, constants: shader.constants },
          }));
        }
      })).then(() => {
        device.__experimentPipelines = pipelines;
        emit({ kind: 'precompile', count: pipelines.length, ms: performance.now() - start });
      });
      if (config.overlap) void ready.catch(error => emit({ kind: 'precompile-error', message: String(error) }));
      else await ready;
    }
    return device;
  };
})();
