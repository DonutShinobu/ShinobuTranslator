import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ImagePipelineRuntimeCapabilities,
  ProviderExecutionReport,
} from '@shinobu/image-pipeline';
import { PRODUCTION_PROVIDER_EXECUTION_POLICY } from '@shinobu/image-pipeline';
import type { PipelineArtifacts } from '../../src/types';
import type { PlatformProvider } from '../../src/runtime/platform';
import type {
  JsonValue,
  RuntimeChannel,
  RuntimeChannelDisconnectReason,
} from '../../apps/extension/src/capabilities/contracts';
import type {
  PipelineHostConnection,
} from '../../apps/extension/src/pipelineHost/contracts';
import {
  LOCAL_PIPELINE_OFFSCREEN_PORT,
} from '../../apps/extension/src/pipelineHost/contracts';

const mocks = vi.hoisted(() => ({
  runPipeline: vi.fn(),
  disposeAllModelSessions: vi.fn(async () => undefined),
  blobToBase64: vi.fn(async () => 'cmVzdWx0'),
  emitDiagnosticLogAsync: vi.fn(async () => true),
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
  emitDiagnosticLogAsync: mocks.emitDiagnosticLogAsync,
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

class FakePort implements RuntimeChannel {
  readonly name = LOCAL_PIPELINE_OFFSCREEN_PORT;
  readonly source = { kind: 'extension-document' as const };
  readonly sent: unknown[] = [];
  readonly messageListeners: Array<(message: JsonValue) => void> = [];
  readonly disconnectListeners: Array<(
    reason: RuntimeChannelDisconnectReason,
  ) => void> = [];
  readonly pendingMessages: JsonValue[] = [];
  disconnected = false;
  beforeSend?: (message: JsonValue) => Promise<void>;

  async send(message: JsonValue): Promise<void> {
    if (this.disconnected) throw new Error('port disconnected');
    await this.beforeSend?.(message);
    if (this.disconnected) throw new Error('port disconnected');
    this.sent.push(message);
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const listener of this.disconnectListeners) {
      listener('closed-locally');
    }
  }

  onMessage(listener: (message: JsonValue) => void): () => void {
    this.messageListeners.push(listener);
    for (const message of this.pendingMessages.splice(0)) listener(message);
    return () => undefined;
  }

  onDisconnect(
    listener: (reason: RuntimeChannelDisconnectReason) => void,
  ): () => void {
    this.disconnectListeners.push(listener);
    return () => undefined;
  }

  emit(message: unknown): void {
    const value = message as JsonValue;
    if (this.messageListeners.length === 0) {
      this.pendingMessages.push(value);
      return;
    }
    for (const listener of this.messageListeners) listener(value);
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
  requiredProviders: ['wasm'],
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
const testPlatform = {} as PlatformProvider;

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
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
  let hosts: OffscreenPipelineHost[];

  beforeEach(() => {
    mocks.runPipeline.mockReset();
    mocks.disposeAllModelSessions.mockClear();
    mocks.blobToBase64.mockReset();
    mocks.blobToBase64.mockResolvedValue('cmVzdWx0');
    mocks.emitDiagnosticLogAsync.mockClear();
    hosts = [];
    port = new FakePort();
  });

  afterEach(() => {
    hosts.forEach((host) => host.dispose());
    void port.disconnect();
  });

  function createHost(
    capabilities?: ImagePipelineRuntimeCapabilities,
  ): OffscreenPipelineHost {
    const lifecycle: PipelineHostConnection = {
      connect: async () => port,
    };
    const host = new OffscreenPipelineHost(
      capabilities ?? defaultCapabilities,
      {
        lifecycle,
        platform: testPlatform,
        translationTransport: {
          requestChatCompletion: vi.fn(),
          translatePlain: vi.fn(),
        },
        diagnosticMessageSender: vi.fn(async () => ({
          ok: true,
          type: 'mt:diagnostic-log-event',
        } as const)),
      },
    );
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

  it('runs Canvas work through the platform injected by the composition root', async () => {
    mocks.runPipeline.mockResolvedValue(artifacts());
    const host = createHost();
    host.connect();
    await vi.waitFor(() => {
      expect(port.sent).toContainEqual({ type: 'host-ready' });
    });

    sendImageJob(port, 'injected-canvas-platform');

    await vi.waitFor(() => {
      expect(mocks.runPipeline).toHaveBeenCalledWith(
        expect.any(File),
        expect.any(Object),
        expect.any(Function),
        expect.objectContaining({
          platform: testPlatform,
        }),
      );
    });
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

  it('delays the cancellation terminal until runtime resource settlement', async () => {
    const releaseExecution = deferred<void>();
    mocks.runPipeline.mockImplementation((
      _file,
      _config,
      _progress,
      options: { signal: AbortSignal },
    ) => new Promise<PipelineArtifacts>((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        void releaseExecution.promise.then(() => reject(options.signal.reason));
      }, { once: true });
    }));
    const host = createHost();
    host.connect();
    sendImageJob(port, 'settled-cancel');
    await vi.waitFor(() => expect(mocks.runPipeline).toHaveBeenCalledOnce());

    port.emit({
      type: 'cancel',
      jobId: 'settled-cancel',
      reason: 'cancel after resources settle',
    });
    await vi.waitFor(() => {
      expect(mocks.emitDiagnosticLogAsync).toHaveBeenCalledWith(
        expect.objectContaining({ level: 'error' }),
        expect.any(Function),
      );
    });

    expect(port.sent).not.toContainEqual(expect.objectContaining({
      type: 'error',
      jobId: 'settled-cancel',
    }));

    releaseExecution.resolve(undefined);
    await vi.waitFor(() => {
      expect(port.sent).toContainEqual(expect.objectContaining({
        type: 'error',
        jobId: 'settled-cancel',
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

  it('does not finish a job when a delayed result send rejects', async () => {
    const delivery = deferred<void>();
    let resultDeliveryStarted = false;
    port.beforeSend = async (message) => {
      if ((message as { type?: string }).type !== 'result-meta') return;
      resultDeliveryStarted = true;
      await delivery.promise;
    };
    mocks.runPipeline.mockResolvedValueOnce(artifacts());
    const host = createHost();
    host.connect();
    sendImageJob(port, 'delayed-send-failure');

    await vi.waitFor(() => expect(resultDeliveryStarted).toBe(true));
    expect(port.sent).not.toContainEqual({
      type: 'complete',
      jobId: 'delayed-send-failure',
    });
    expect(port.disconnected).toBe(false);

    delivery.reject(new Error('delayed send failed'));

    await vi.waitFor(() => expect(port.disconnected).toBe(true));
    expect(port.sent).not.toContainEqual({
      type: 'complete',
      jobId: 'delayed-send-failure',
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

  it('settles host disposal only after shared runtime resources are released once', async () => {
    const release = deferred<undefined>();
    mocks.disposeAllModelSessions.mockImplementationOnce(
      async () => release.promise,
    );
    const host = createHost();

    const firstDispose = host.dispose();
    const secondDispose = host.dispose();

    expect(firstDispose).toBe(secondDispose);
    await Promise.resolve();
    expect(mocks.disposeAllModelSessions).toHaveBeenCalledOnce();
    let settled = false;
    void firstDispose.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    release.resolve(undefined);
    await expect(firstDispose).resolves.toBeUndefined();
    expect(mocks.disposeAllModelSessions).toHaveBeenCalledOnce();
  });

  it('reconnects its host Port after the background service worker restarts', async () => {
    vi.useFakeTimers();
    try {
      const host = createHost();
      host.connect();
      const firstPort = port;
      await vi.waitFor(() => {
        expect(firstPort.sent).toContainEqual({ type: 'host-ready' });
      });
      port = new FakePort();

      await firstPort.disconnect();
      await vi.advanceTimersByTimeAsync(250);

      expect(port.sent).toContainEqual({ type: 'host-ready' });
    } finally {
      vi.useRealTimers();
    }
  });
});
