// Experimental instrumentation only; prepended to a built Worker by the experiment runner.
// Inputs are model-generated WGSL from one fixture, not a general production shader cache.
(() => {
  const config = globalThis.__coldStartExperiment;
  const emit = (data) => fetch(config.probeUrl, { method: 'POST', body: JSON.stringify(data) }).catch(() => {});
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (descriptor) {
    const device = await requestDevice.call(this, descriptor);
    const shaders = new WeakMap();
    const createShaderModule = device.createShaderModule.bind(device);
    const createComputePipeline = device.createComputePipeline.bind(device);
    device.createShaderModule = (desc) => {
      const module = createShaderModule(desc);
      shaders.set(module, desc.code);
      return module;
    };
    device.createComputePipeline = (desc) => {
      if (config.capture) emit({ kind: 'shader', code: shaders.get(desc.compute.module),
        entryPoint: desc.compute.entryPoint, constants: desc.compute.constants, label: desc.label });
      return createComputePipeline(desc);
    };
    if (config.shaders?.length) {
      const start = performance.now();
      let next = 0;
      // Keep pipelines alive so native caching can reuse them during the measured inference.
      const pipelines = [];
      const ready = Promise.all(Array.from({ length: config.concurrency }, async () => {
        while (next < config.shaders.length) {
          const shader = config.shaders[next++];
          pipelines.push(await device.createComputePipelineAsync({
            label: shader.label, layout: 'auto',
            compute: { module: createShaderModule({ code: shader.code }),
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
