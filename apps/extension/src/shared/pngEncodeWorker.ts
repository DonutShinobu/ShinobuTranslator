export type WorkerPngInput = ({
  kind: 'image-bitmap';
  bitmap: ImageBitmap;
} | {
  kind: 'rgba';
  pixels: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}) & { profile: boolean; colorSpace: PredefinedColorSpace };

export type WorkerPngOutput = {
  blob?: Blob;
  error?: string;
  drawMs?: number;
  encodeMs?: number;
};

// On a Worker thread Chromium encodes PNG directly, rather than waiting for
// the Window thread's idle task. Keep the source dimensions and encoder format.
export async function encodeWorkerPng(input: WorkerPngInput): Promise<WorkerPngOutput> {
  const width = input.kind === 'image-bitmap' ? input.bitmap.width : input.width;
  const height = input.kind === 'image-bitmap' ? input.bitmap.height : input.height;
  const surface = new OffscreenCanvas(width, height);
  try {
    const context = surface.getContext('2d', { colorSpace: input.colorSpace });
    if (!context) throw new Error('导出译图失败');
    const drawStartedAt = input.profile ? performance.now() : 0;
    if (input.kind === 'image-bitmap') {
      context.globalCompositeOperation = 'copy';
      context.drawImage(input.bitmap, 0, 0);
    } else {
      context.putImageData(new ImageData(input.pixels, width, height, { colorSpace: input.colorSpace }), 0, 0);
    }
    const drawMs = input.profile ? performance.now() - drawStartedAt : undefined;
    const encodeStartedAt = input.profile ? performance.now() : 0;
    const blob = await surface.convertToBlob({ type: 'image/png' });
    const encodeMs = input.profile ? performance.now() - encodeStartedAt : undefined;
    return { blob, drawMs, encodeMs };
  } finally {
    if (input.kind === 'image-bitmap') input.bitmap.close();
    surface.width = 0;
    surface.height = 0;
  }
}

// The guard also allows CPU tests to call the encoder without installing a
// Window message handler. The product only loads this module as a Worker.
if (typeof document === 'undefined' && typeof postMessage === 'function') {
  const scope = globalThis as unknown as {
    onmessage: (event: MessageEvent<WorkerPngInput>) => void;
    postMessage: (message: WorkerPngOutput) => void;
  };
  scope.onmessage = (event) => {
    void encodeWorkerPng(event.data).then(
      (result) => scope.postMessage(result),
      (error: unknown) => scope.postMessage({ error: error instanceof Error ? error.message : String(error) }),
    );
  };
}
