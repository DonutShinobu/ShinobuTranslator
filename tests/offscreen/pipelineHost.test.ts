import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChromePort } from '../../src/shared/chrome';
import type { PipelineArtifacts } from '../../src/types';

const mocks = vi.hoisted(() => ({
  runPipeline: vi.fn(),
  disposeAllModelSessions: vi.fn(async () => undefined),
}));

vi.mock('../../src/pipeline/orchestrator', () => ({
  runPipeline: mocks.runPipeline,
}));

vi.mock('../../src/runtime/modelRegistry', () => ({
  disposeAllModelSessions: mocks.disposeAllModelSessions,
}));

vi.mock('../../src/shared/diagnosticLogClient', () => ({
  emitDiagnosticLog: vi.fn(),
  emitDiagnosticLogAsync: vi.fn(async () => true),
}));

vi.mock('../../src/shared/blobCodec', () => ({
  base64ToBlob: (base64: string, contentType: string) => {
    const binary = atob(base64);
    return new Blob([Uint8Array.from(binary, (char) => char.charCodeAt(0))], { type: contentType });
  },
  blobToBase64: vi.fn(async () => 'cmVzdWx0'),
  canvasToPngBlob: vi.fn(async () => new Blob(['result'], { type: 'image/png' })),
}));

import { OffscreenPipelineHost } from '../../src/offscreen/pipelineHost';
import { LOCAL_PIPELINE_OFFSCREEN_PORT } from '../../src/shared/localPipelineProtocol';

class FakePort implements ChromePort {
  readonly name = LOCAL_PIPELINE_OFFSCREEN_PORT;
  readonly sent: unknown[] = [];
  readonly messageListeners: Array<(message: unknown, port: ChromePort) => void> = [];
  readonly disconnectListeners: Array<(port: ChromePort) => void> = [];
  disconnected = false;

  postMessage(message: unknown): void {
    this.sent.push(message);
  }

  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const listener of this.disconnectListeners) listener(this);
  }

  onMessage = {
    addListener: (listener: (message: unknown, port: ChromePort) => void): void => {
      this.messageListeners.push(listener);
    },
    removeListener: (): void => undefined,
  };

  onDisconnect = {
    addListener: (listener: (port: ChromePort) => void): void => {
      this.disconnectListeners.push(listener);
    },
    removeListener: (): void => undefined,
  };

  emit(message: unknown): void {
    for (const listener of this.messageListeners) listener(message, this);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function artifacts(): PipelineArtifacts {
  return {
    original: { naturalWidth: 1, naturalHeight: 1 } as PipelineArtifacts['original'],
    detectedRegions: [],
    stageRegions: {
      detected: [],
      ocr: [],
      merged: [],
      ordered: [],
    },
    detectionCanvas: {} as PipelineArtifacts['detectionCanvas'],
    ocrCanvas: {} as PipelineArtifacts['ocrCanvas'],
    segmentationCanvas: null,
    cleanedCanvas: {} as PipelineArtifacts['cleanedCanvas'],
    resultCanvas: {} as PipelineArtifacts['resultCanvas'],
    debugOriginalCanvas: null,
    typesetDebugLog: null,
    translationDebug: null,
    ocrDebug: null,
    runtimeStages: [],
    stageTimings: [],
  };
}

function sendImageJob(port: FakePort, jobId: string): void {
  port.emit({ type: 'prepare', jobId });
  port.emit({
    type: 'start',
    jobId,
    file: { name: `${jobId}.png`, type: 'image/png', size: 1, lastModified: 1 },
    config: {
      sourceLang: 'ja',
      targetLang: 'zh-CN',
      translator: 'google_web',
      llmProvider: 'deepseek',
      llmAuthMode: 'api_key',
      llmBaseUrl: '',
      llmApiKey: '',
      llmModel: '',
      typesetDebug: false,
      eraseDebug: false,
      collectDebugLog: false,
      ocrEngine: 'paddleocr_v6_medium',
      processMode: 'original',
    },
    input: { chunkCount: 1, totalChars: 4 },
  });
  port.emit({ type: 'input-chunk', jobId, index: 0, data: 'AQ==' });
  port.emit({ type: 'input-complete', jobId });
}

describe('OffscreenPipelineHost FIFO queue', () => {
  let port: FakePort;
  let originalChrome: unknown;

  beforeEach(() => {
    mocks.runPipeline.mockReset();
    mocks.disposeAllModelSessions.mockClear();
    port = new FakePort();
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        connect: () => port,
      },
    };
  });

  afterEach(() => {
    port.disconnect();
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
  });

  it('runs one task at a time and starts the next only after completion', async () => {
    const first = deferred<PipelineArtifacts>();
    mocks.runPipeline
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(artifacts());
    const host = new OffscreenPipelineHost();
    host.connect();

    sendImageJob(port, 'job-1');
    sendImageJob(port, 'job-2');

    await vi.waitFor(() => expect(mocks.runPipeline).toHaveBeenCalledTimes(1));
    expect(port.sent).toContainEqual({ type: 'queued', jobId: 'job-2', position: 1 });

    first.resolve(artifacts());

    await vi.waitFor(() => expect(mocks.runPipeline).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(port.sent).toContainEqual({ type: 'complete', jobId: 'job-2' });
    });
  });

  it('removes a queued task when it is cancelled', async () => {
    const first = deferred<PipelineArtifacts>();
    mocks.runPipeline.mockImplementationOnce(() => first.promise);
    const host = new OffscreenPipelineHost();
    host.connect();
    sendImageJob(port, 'job-1');
    sendImageJob(port, 'job-2');
    await vi.waitFor(() => expect(mocks.runPipeline).toHaveBeenCalledTimes(1));

    port.emit({ type: 'cancel', jobId: 'job-2', reason: 'test cancel' });

    expect(port.sent).toContainEqual(expect.objectContaining({
      type: 'error',
      jobId: 'job-2',
      error: expect.objectContaining({ code: 'TASK_CANCELLED' }),
    }));
    first.resolve(artifacts());
    await vi.waitFor(() => {
      expect(port.sent).toContainEqual({ type: 'complete', jobId: 'job-1' });
    });
    expect(mocks.runPipeline).toHaveBeenCalledTimes(1);
  });

  it('cooperatively aborts the active task', async () => {
    mocks.runPipeline.mockImplementation((_file, _config, _progress, options: { signal: AbortSignal }) => (
      new Promise<PipelineArtifacts>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      })
    ));
    const host = new OffscreenPipelineHost();
    host.connect();
    sendImageJob(port, 'active-cancel');
    await vi.waitFor(() => expect(mocks.runPipeline).toHaveBeenCalledTimes(1));

    port.emit({ type: 'cancel', jobId: 'active-cancel', reason: 'cancel active' });

    await vi.waitFor(() => {
      expect(port.sent).toContainEqual(expect.objectContaining({
        type: 'error',
        jobId: 'active-cancel',
        error: expect.objectContaining({ code: 'TASK_CANCELLED' }),
      }));
    });
  });

  it('releases sessions and asks the background to close after five idle minutes', async () => {
    vi.useFakeTimers();
    try {
      const host = new OffscreenPipelineHost();
      host.connect();

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(mocks.disposeAllModelSessions).toHaveBeenCalledTimes(1);
      expect(port.sent).toContainEqual({ type: 'idle-close' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnects its host Port after the background service worker restarts', async () => {
    vi.useFakeTimers();
    try {
      const host = new OffscreenPipelineHost();
      host.connect();
      const firstPort = port;
      port = new FakePort();

      firstPort.disconnect();
      await vi.advanceTimersByTimeAsync(250);

      expect(port.sent).toContainEqual({ type: 'host-ready' });
    } finally {
      vi.useRealTimers();
    }
  });
});
