import type { PipelineCanvas } from '@shinobu/image-pipeline';
import type { WorkerPngInput, WorkerPngOutput } from './pngEncodeWorker';

export async function encodeCanvasToPngInWorker(canvas: PipelineCanvas): Promise<Blob> {
  const root = globalThis as {
    __shinobuColdStartWorkerPngRgba?: boolean;
    __shinobuColdStartInitMark?: (record: Record<string, unknown>) => void;
  };
  const rgba = root.__shinobuColdStartWorkerPngRgba === true;
  const observe = root.__shinobuColdStartInitMark;
  const startedAt = observe ? performance.now() : 0;
  const worker = new Worker(new URL('./pngEncodeWorker.ts', import.meta.url), { type: 'module' });
  let bitmap: ImageBitmap | undefined;
  let captureMs: number | undefined;
  let disposed = false;
  try {
    const completed = new Promise<WorkerPngOutput>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<WorkerPngOutput>) => {
        const result = event.data;
        if (!result || typeof result !== 'object') reject(new Error('PNG Worker结果传递失败'));
        else if (result.error) reject(new Error(result.error));
        else if (!(result.blob instanceof Blob) || result.blob.type !== 'image/png' || result.blob.size === 0) {
          reject(new Error('PNG Worker未返回完整图片'));
        } else resolve(result);
      };
      worker.onerror = (event) => reject(new Error(event.message || 'PNG Worker启动失败'));
      worker.onmessageerror = () => reject(new Error('PNG Worker结果传递失败'));
    });
    const send = (async () => {
      const captureStartedAt = observe ? performance.now() : 0;
      const context = (canvas as HTMLCanvasElement).getContext('2d');
      if (!context) throw new Error('导出译图失败');
      const colorSpace = context.getContextAttributes?.().colorSpace ?? 'srgb';
      let input: WorkerPngInput;
      let transfers: Transferable[];
      if (rgba) {
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        input = { kind: 'rgba', pixels, width: canvas.width, height: canvas.height, profile: !!observe, colorSpace };
        transfers = [pixels.buffer];
      } else {
        bitmap = await createImageBitmap(canvas as HTMLCanvasElement);
        if (bitmap.width !== canvas.width || bitmap.height !== canvas.height) throw new Error('PNG Worker图片尺寸变化');
        input = { kind: 'image-bitmap', bitmap, profile: !!observe, colorSpace };
        transfers = [bitmap];
      }
      captureMs = observe ? performance.now() - captureStartedAt : undefined;
      if (disposed) {
        bitmap?.close();
        return;
      }
      worker.postMessage(input, transfers);
    })();
    // Attach both promises immediately: a Worker load error during an async
    // bitmap snapshot must also reject the candidate and release the Worker.
    const [result] = await Promise.all([completed, send]);
    if (observe) {
      try {
        observe({ phase: 'png.worker', startedAt, durationMs: performance.now() - startedAt,
          mode: rgba ? 'rgba' : 'image-bitmap', captureMs, drawMs: result.drawMs, encodeMs: result.encodeMs,
          bytes: result.blob!.size });
      } catch {
        // Diagnostic callbacks never change the exported image.
      }
    }
    return result.blob!;
  } finally {
    disposed = true;
    bitmap?.close();
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  }
}
