import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ImagePipelineRuntimeCapabilities,
  ProviderExecutionReport,
} from '@shinobu/image-pipeline';
import { PRODUCTION_PROVIDER_EXECUTION_POLICY } from '@shinobu/image-pipeline';
import type { ChromePort } from '../../src/shared/chrome';
import type { PipelineArtifacts } from '../../src/types';

const mocks = vi.hoisted(() => ({
  runPipeline: vi.fn(),
  disposeAllModelSessions: vi.fn(async () => undefined),
  blobToBase64: vi.fn(async () => 'cmVzdWx0'),
}));

vi.mock('../../src/pipeline/orchestrator', () => ({
  runPipeline: mocks.runPipeline,
  PipelineStageError: class PipelineStageError extends Error {},
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
  blobToBase64: mocks.blobToBase64,
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

const providerReport: ProviderExecutionReport = {
  schemaVersion: 1,
  contract: {
    id: 'shinobu.production-provider-policy',
    version: 1,
  },
  model: 'detector',
  stage: 'detect',
  attempts: [
    {
      attempt: 1,
      provider: 'wasm',
      outcome: 'succeeded',
      reason: 'completed',
    },
  ],
  finalProvider: 'wasm',
  fallbackTrace: [],
  satisfied: true,
};
const unsatisfiedProviderReport: ProviderExecutionReport = {
  ...providerReport,
  attempts: [
    {
      attempt: 1,
      provider: 'wasm',
      outcome: 'failed',
      reason: 'execution-failed',
    },
  ],
  finalProvider: undefined,
  satisfied: false,
};
const modelSession = {
  loadModel: vi.fn(async () => ({ runtime: ['wasm'] as const })),
  loadSession: vi.fn(async () => ({
    sessionId: 'test-detector',
    provider: 'wasm' as const,
    inputNames: ['images'],
    outputNames: ['output'],
  })),
};
const defaultCapabilities: ImagePipelineRuntimeCapabilities = {
  providerExecution: {
    policy: PRODUCTION_PROVIDER_EXECUTION_POLICY,
    modelSession,
  },
};

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
    ocrPostFilterDebug: null,
    runtimeStages: [],
    providerReports: [providerReport],
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

describe('OffscreenPipelineHost single-task admission', () => {
  let port: FakePort;
  let originalChrome: unknown;
  let hosts: OffscreenPipelineHost[];

  beforeEach(() => {
    mocks.runPipeline.mockReset();
    mocks.disposeAllModelSessions.mockClear();
    mocks.blobToBase64.mockReset();
    mocks.blobToBase64.mockResolvedValue('cmVzdWx0');
    hosts = [];
    port = new FakePort();
    originalChrome = (globalThis as { chrome?: unknown }).chrome;
    (globalThis as { chrome?: unknown }).chrome = {
      runtime: {
        connect: () => port,
      },
    };
  });

  afterEach(() => {
    hosts.forEach((host) => host.dispose());
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
    port.disconnect();
  });

  function createHost(
    capabilities?: ImagePipelineRuntimeCapabilities,
  ): OffscreenPipelineHost {
    const host = new OffscreenPipelineHost(capabilities ?? defaultCapabilities);
    hosts.push(host);
    return host;
  }

  it('rejects unexpected overlap instead of maintaining a second queue', async () => {
    const first = deferred<PipelineArtifacts>();
    mocks.runPipeline.mockImplementationOnce(() => first.promise);
    const host = createHost();
    host.connect();

    sendImageJob(port, 'job-1');
    sendImageJob(port, 'job-2');

    await vi.waitFor(() => expect(mocks.runPipeline).toHaveBeenCalledTimes(1));
    expect(port.sent).toContainEqual(expect.objectContaining({
      type: 'error',
      jobId: 'job-2',
      error: expect.objectContaining({ code: 'RUNTIME_BUSY' }),
    }));

    first.resolve(artifacts());

    await vi.waitFor(() => {
      expect(port.sent).toContainEqual({ type: 'complete', jobId: 'job-1' });
    });
    expect(mocks.runPipeline).toHaveBeenCalledTimes(1);
    expect(port.sent).toContainEqual(expect.objectContaining({
      type: 'result-meta',
      jobId: 'job-1',
      status: 'no-translatable-text',
      providerReports: [providerReport],
      record: expect.objectContaining({
        schemaVersion: 2,
        workingCopy: expect.objectContaining({
          spec: { strategy: 'source-native' },
          sourceToWorkingCopy: { kind: 'identity' },
        }),
      }),
    }));
  });

  it('passes an injected provider policy to the pipeline as a runtime capability', async () => {
    const capabilities: ImagePipelineRuntimeCapabilities = {
      providerExecution: {
        policy: {
          schemaVersion: 1,
          contract: {
            id: 'test.detector-wasm-only',
            version: 2,
          },
          rules: [
            {
              model: 'detector',
              stage: 'detect',
              providers: ['wasm'],
            },
          ],
        },
        modelSession,
      },
    };
    mocks.runPipeline.mockResolvedValueOnce(artifacts());
    const host = createHost(capabilities);
    host.connect();

    sendImageJob(port, 'runtime-capability');

    await vi.waitFor(() => expect(mocks.runPipeline).toHaveBeenCalledOnce());
    expect(mocks.runPipeline.mock.calls[0][3]).toMatchObject({
      runtimeCapabilities: {
        providerExecution: {
          policy: capabilities.providerExecution?.policy,
          modelSession: {
            loadModel: expect.any(Function),
            loadSession: expect.any(Function),
          },
        },
      },
    });
    const injectedCapabilities = mocks.runPipeline.mock.calls[0][3]
      .runtimeCapabilities as ImagePipelineRuntimeCapabilities;
    await injectedCapabilities.providerExecution?.modelSession.loadModel('detector');
    expect(modelSession.loadModel).toHaveBeenCalledWith('detector');
  });

  it('transports an unsatisfied provider report in structured failure diagnostics', async () => {
    mocks.runPipeline.mockRejectedValueOnce(Object.assign(
      new Error('detector failed'),
      {
        failure: {
          code: 'PIPELINE_STAGE_FAILED',
          stage: 'detect',
          scope: 'runtime',
          retryable: false,
          messageKey: 'pipeline.failure.stage',
          diagnostics: {
            providerReports: [unsatisfiedProviderReport],
          },
        },
      },
    ));
    const host = createHost();
    host.connect();

    sendImageJob(port, 'provider-failure');

    await vi.waitFor(() => {
      expect(port.sent).toContainEqual(expect.objectContaining({
        type: 'error',
        jobId: 'provider-failure',
        error: expect.objectContaining({
          diagnostics: {
            providerReports: [unsatisfiedProviderReport],
          },
        }),
      }));
    });
  });

  it('does not retain an unexpectedly overlapping task after rejecting it', async () => {
    const first = deferred<PipelineArtifacts>();
    mocks.runPipeline.mockImplementationOnce(() => first.promise);
    const host = createHost();
    host.connect();
    sendImageJob(port, 'job-1');
    sendImageJob(port, 'job-2');
    await vi.waitFor(() => expect(mocks.runPipeline).toHaveBeenCalledTimes(1));

    expect(port.sent).toContainEqual(expect.objectContaining({
      type: 'error',
      jobId: 'job-2',
      error: expect.objectContaining({ code: 'RUNTIME_BUSY' }),
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
    const host = createHost();
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

  it('does not deliver a late result when cancellation arrives during result encoding', async () => {
    const encoded = deferred<string>();
    mocks.runPipeline.mockResolvedValueOnce(artifacts());
    mocks.blobToBase64.mockImplementationOnce(() => encoded.promise);
    const host = createHost();
    host.connect();
    sendImageJob(port, 'late-cancel');
    await vi.waitFor(() => expect(mocks.blobToBase64).toHaveBeenCalledOnce());

    port.emit({
      type: 'cancel',
      jobId: 'late-cancel',
      reason: {
        code: 'user-requested',
        messageKey: 'pipeline.cancelled.userRequested',
      },
    });
    encoded.resolve('cmVzdWx0');

    await vi.waitFor(() => {
      expect(port.sent).toContainEqual(expect.objectContaining({
        type: 'error',
        jobId: 'late-cancel',
        error: expect.objectContaining({ code: 'TASK_CANCELLED' }),
      }));
    });
    expect(port.sent).not.toContainEqual({
      type: 'complete',
      jobId: 'late-cancel',
    });
  });

  it('releases sessions and asks the background to close after five idle minutes', async () => {
    vi.useFakeTimers();
    try {
      const host = createHost();
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
      const host = createHost();
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
