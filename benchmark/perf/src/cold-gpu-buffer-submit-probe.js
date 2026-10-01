// Benchmark diagnostics only. Buffer bytes are requested descriptor sizes of
// successful createBuffer calls, not actual VRAM; textures/driver heaps are absent.
// Configure __coldGpuBufferSubmitProbeUrl (or __coldRuntimeProbeUrl) before loading.
(() => {
  const url = self.__coldGpuBufferSubmitProbeUrl ?? self.__coldRuntimeProbeUrl;
  if (!url || typeof GPUAdapter === 'undefined') return;
  const apiTimingEnabled = self.__coldGpuApiTiming === true;
  const originalFetch = self.fetch.bind(self);
  const devices = [], incidents = [], inpaintRequests = new Set(), installed = new WeakSet();
  const flush = reason => {
    const records = [...devices.map(device => ({ kind: 'gpu-buffer-submit-summary',
      timeOrigin: performance.timeOrigin, requestedBytesOnly: true, ...device })), ...incidents.splice(0)];
    try {
      void originalFetch(url, { method: 'POST', body: JSON.stringify({
        kind: 'gpu-buffer-submit-batch', reason, records,
      }) }).catch(() => {});
    } catch { /* Diagnostics must not prevent the original reply or GPU error handler. */ }
  };
  const requestDevice = GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice = async function (...args) {
    const device = await requestDevice.apply(this, args);
    if (installed.has(device)) return device;
    installed.add(device);
    const stats = { deviceId: devices.length, deviceReadyAt: performance.now(),
      requestedBufferBytesCreated: 0, requestedBufferBytesLive: 0, requestedBufferBytesPeak: 0,
      buffersCreated: 0, buffersDestroyed: 0, buffersLive: 0, buffersPeak: 0,
      uploadStagingBuffersCreated: 0, uploadStagingBytesCreated: 0,
      queueSubmits: 0, firstSubmitAt: null, firstSubmitMsSinceDevice: null,
      queueWriteBufferCalls: 0, queueWriteBufferBytes: 0,
      firstWriteBufferAt: null, firstWriteBufferMsSinceDevice: null,
      apiTimingEnabled, queueSubmitNativeSyncMs: 0, maxQueueSubmitNativeSyncMs: 0,
      queueWriteBufferNativeSyncMs: 0,
      uniformWriteBufferCalls: 0, uniformWriteBufferBytes: 0,
      uniformWriteBufferNativeSyncMs: 0, maxUniformWriteBufferNativeSyncMs: 0,
      deviceLost: false, uncapturedErrors: 0 };
    devices.push(stats);
    const createBuffer = device.createBuffer;
    device.createBuffer = function (...args) {
      const buffer = createBuffer.apply(this, args);
      if (this !== device) return buffer;
      const size = Number(args[0].size);
      stats.buffersCreated++;
      stats.buffersLive++;
      stats.buffersPeak = Math.max(stats.buffersPeak, stats.buffersLive);
      stats.requestedBufferBytesCreated += size;
      stats.requestedBufferBytesLive += size;
      stats.requestedBufferBytesPeak = Math.max(stats.requestedBufferBytesPeak, stats.requestedBufferBytesLive);
      // This is ORT's upload staging descriptor pattern, not a model/phase label.
      const uploadUsage = GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC;
      if (args[0].mappedAtCreation && Number(args[0].usage) === uploadUsage) {
        stats.uploadStagingBuffersCreated++;
        stats.uploadStagingBytesCreated += size;
      }
      const destroy = buffer.destroy;
      let live = true;
      buffer.destroy = function (...destroyArgs) {
        const result = destroy.apply(this, destroyArgs);
        if (this === buffer && live) {
          live = false;
          stats.buffersDestroyed++;
          stats.buffersLive--;
          stats.requestedBufferBytesLive -= size;
        }
        return result;
      };
      return buffer;
    };
    const queue = device.queue, submit = queue.submit;
    queue.submit = function (...args) {
      const firstAt = this === queue && stats.queueSubmits === 0 ? performance.now() : null;
      const timingAt = apiTimingEnabled && this === queue ? firstAt ?? performance.now() : null;
      const result = submit.apply(this, args);
      const nativeSyncMs = timingAt === null ? 0 : performance.now() - timingAt;
      if (this === queue) {
        stats.queueSubmits++;
        stats.queueSubmitNativeSyncMs += nativeSyncMs;
        stats.maxQueueSubmitNativeSyncMs = Math.max(stats.maxQueueSubmitNativeSyncMs, nativeSyncMs);
        if (stats.firstSubmitAt === null) {
          stats.firstSubmitAt = firstAt;
          stats.firstSubmitMsSinceDevice = firstAt - stats.deviceReadyAt;
        }
      }
      return result;
    };
    const writeBuffer = queue.writeBuffer;
    queue.writeBuffer = function (...args) {
      const firstAt = this === queue && stats.queueWriteBufferCalls === 0 ? performance.now() : null;
      const timingAt = apiTimingEnabled && this === queue ? firstAt ?? performance.now() : null;
      const result = writeBuffer.apply(this, args);
      const nativeSyncMs = timingAt === null ? 0 : performance.now() - timingAt;
      if (this === queue) {
        const data = args[2];
        // TypedArray offsets/counts are elements; ArrayBuffer/DataView use bytes.
        const elementSize = ArrayBuffer.isView(data) ? data.BYTES_PER_ELEMENT ?? 1 : 1;
        const offset = Number(args[3] ?? 0);
        const elements = Number(args[4] ?? data.byteLength / elementSize - offset);
        stats.queueWriteBufferCalls++;
        stats.queueWriteBufferBytes += elements * elementSize;
        stats.queueWriteBufferNativeSyncMs += nativeSyncMs;
        // Descriptor role only: this does not label a model or initializer.
        if (apiTimingEnabled && (args[0].usage & GPUBufferUsage.UNIFORM) !== 0) {
          stats.uniformWriteBufferCalls++;
          stats.uniformWriteBufferBytes += elements * elementSize;
          stats.uniformWriteBufferNativeSyncMs += nativeSyncMs;
          stats.maxUniformWriteBufferNativeSyncMs = Math.max(stats.maxUniformWriteBufferNativeSyncMs, nativeSyncMs);
        }
        if (stats.firstWriteBufferAt === null) {
          stats.firstWriteBufferAt = firstAt;
          stats.firstWriteBufferMsSinceDevice = firstAt - stats.deviceReadyAt;
        }
      }
      return result;
    };
    device.addEventListener('uncapturederror', event => {
      stats.uncapturedErrors++;
      incidents.push({ kind: 'gpu-uncaptured-error', deviceId: stats.deviceId, at: performance.now(),
        name: event.error?.name, message: String(event.error?.message ?? event.error).slice(0, 2000) });
      flush('uncaptured-error');
    });
    void device.lost.then(info => {
      stats.deviceLost = true;
      incidents.push({ kind: 'gpu-device-lost', deviceId: stats.deviceId, at: performance.now(),
        reason: info.reason, message: String(info.message).slice(0, 2000) });
      flush('device-lost');
    });
    return device;
  };
  self.addEventListener('message', ({ data }) => {
    if (data?.type === 'APPLY' && data.path?.at(-1) === 'runInference'
      && data.argumentList?.[0]?.value?.split?.(':')[0] === 'inpaint') inpaintRequests.add(data.id);
  });
  const post = self.postMessage.bind(self);
  self.postMessage = (data, ...args) => {
    const result = post(data, ...args);
    if (inpaintRequests.delete(data?.id)) flush('inpaint-reply');
    return result;
  };
})();
