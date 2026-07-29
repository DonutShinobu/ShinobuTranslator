import * as ort from 'onnxruntime-web/wasm';
import ortWasmModuleUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url';
import ortWasmBinaryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';

type CapabilityRequest = {
  bitmap: ImageBitmap;
  width: number;
  height: number;
};

const IDENTITY_MODEL_BASE64 =
  'CAgSB3NoaW5vYnU6SAoQCgF4EgF5IghJZGVudGl0eRISc2hpbm9idV9jYXBhYmlsaXR5Wg8KAXgSCgoICAESBAoCCAFiDwoBeRIKCggIARIECgIIAUIECgAQDQ==';

function decodeIdentityModel(): Uint8Array {
  const binary = atob(IDENTITY_MODEL_BASE64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function runCapabilityProbe(request: CapabilityRequest): Promise<void> {
  const { bitmap, width, height } = request;
  if (!(bitmap instanceof ImageBitmap)) {
    globalThis.postMessage({ ok: false, reason: 'ImageBitmap transfer failed' });
    return;
  }
  try {
    if (
      !Number.isSafeInteger(width)
      || !Number.isSafeInteger(height)
      || width <= 0
      || height <= 0
    ) {
      throw new Error('Invalid target canvas dimensions');
    }
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('OffscreenCanvas 2D unavailable');
    context.drawImage(bitmap, 0, 0, width, height);
    context.getImageData(width - 1, height - 1, 1, 1);

    ort.env.logLevel = 'error';
    ort.env.wasm.wasmPaths = {
      mjs: ortWasmModuleUrl,
      wasm: ortWasmBinaryUrl,
    };
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    const session = await ort.InferenceSession.create(decodeIdentityModel(), {
      executionProviders: ['wasm'],
    });
    try {
      const output = await session.run({
        x: new ort.Tensor('float32', new Float32Array([7]), [1]),
      });
      const value = Number(output.y?.data[0]);
      if (value !== 7) throw new Error('ORT identity inference returned an invalid result');
    } finally {
      await session.release();
    }
    globalThis.postMessage({ ok: true, ort: true });
  } catch (error) {
    globalThis.postMessage({
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    bitmap.close();
  }
}

globalThis.addEventListener('message', (event: MessageEvent<unknown>) => {
  const request = event.data;
  if (
    !request
    || typeof request !== 'object'
    || !('bitmap' in request)
    || !('width' in request)
    || !('height' in request)
  ) {
    globalThis.postMessage({ ok: false, reason: 'Invalid capability request' });
    return;
  }
  void runCapabilityProbe(request as CapabilityRequest);
});
