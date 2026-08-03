import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineArtifacts } from '../../packages/image-pipeline/src/types';
import type { PipelinePlatform } from '@shinobu/image-pipeline';
import type { ModelRuntime } from '@shinobu/model-runtime';

const mocks = vi.hoisted(() => ({
  runPipeline: vi.fn(),
  disposeAllModelSessions: vi.fn(async () => undefined),
}));

vi.mock('../../packages/image-pipeline/src/pipeline/orchestrator', () => ({
  runPipeline: mocks.runPipeline,
  PipelineStageError: class PipelineStageError extends Error {},
}));

vi.mock('../../packages/model-runtime/src/runtime/modelRegistry', () => ({
  disposeAllModelSessions: mocks.disposeAllModelSessions,
}));

vi.mock('../../packages/diagnostics/src/diagnosticLogClient', () => ({
  emitDiagnosticLog: vi.fn(),
  emitDiagnosticLogAsync: vi.fn(async () => true),
}));

vi.mock('../../packages/image-pipeline/src/protocol/blobCodec', () => ({
  base64ToBlob: (base64: string, contentType: string) => {
    const binary = atob(base64);
    return new Blob(
      [Uint8Array.from(binary, (char) => char.charCodeAt(0))],
      { type: contentType },
    );
  },
  blobToBase64: vi.fn(async () => 'cmVzdWx0'),
  canvasToPngBlob: vi.fn(async () => new Blob(['result'], { type: 'image/png' })),
}));

import { FirefoxPipelineHostLifecycle } from '../../src/background/localPipeline/firefoxPipelineHostLifecycle';
import { PipelineHostBroker } from '../../src/background/localPipeline/offscreenBroker';
import type { ExtensionBrowserApi, ExtensionPort } from '../../src/shared/extensionRuntime';
import { createLocalExtensionPortPair } from '../../src/shared/localExtensionPort';
import { LOCAL_PIPELINE_CLIENT_PORT } from '../../packages/image-pipeline/src/protocol/index';

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
    stageTimings: [],
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function transferImageJob(client: ExtensionPort, jobId: string): void {
  client.postMessage({
    type: 'start',
    jobId,
    file: {
      name: `${jobId}.png`,
      type: 'image/png',
      size: 1,
      lastModified: 1,
    },
    config: {
      sourceLang: 'ja',
      targetLang: 'zh-CN',
      translator: 'llm',
      llmProvider: 'deepseek',
      llmAuthMode: 'api_key',
      llmBaseUrl: 'https://api.deepseek.com/',
      llmModel: 'deepseek-v4-flash',
      typesetDebug: false,
      eraseDebug: false,
      collectDebugLog: true,
      ocrEngine: 'paddleocr_v6_medium',
      processMode: 'translate',
    },
    input: { chunkCount: 1, totalChars: 4 },
  });
  client.postMessage({
    type: 'input-chunk',
    jobId,
    index: 0,
    data: 'AQ==',
  });
  client.postMessage({ type: 'input-complete', jobId });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FirefoxPipelineHostLifecycle', () => {
  const createRuntimeDependencies = () => ({
    modelRuntime: {
      readModel: vi.fn(),
      getSession: vi.fn(),
      run: vi.fn(),
      runImage: vi.fn(),
      readTextResource: vi.fn(),
      releaseSession: vi.fn(async () => undefined),
      dispose: mocks.disposeAllModelSessions,
    } satisfies ModelRuntime,
    platform: {} as PipelinePlatform,
  });

  beforeEach(() => {
    mocks.runPipeline.mockReset();
    mocks.disposeAllModelSessions.mockClear();
  });

  it('connects the broker to the in-page host without a runtime self-connection', async () => {
    const runtimeConnect = vi.fn(() => {
      throw new Error('Firefox does not deliver runtime.connect to the same context');
    });
    const api: ExtensionBrowserApi = {
      runtime: {
        connect: runtimeConnect,
        getURL: (path) => `moz-extension://test/${path}`,
        onConnect: { addListener: () => undefined },
      },
    };
    vi.stubGlobal('chrome', api);
    const lifecycle = new FirefoxPipelineHostLifecycle(createRuntimeDependencies());
    const broker = new PipelineHostBroker(api, lifecycle);
    const [brokerClient, contentClient] = createLocalExtensionPortPair(
      LOCAL_PIPELINE_CLIENT_PORT,
    );
    const responses: unknown[] = [];
    contentClient.onMessage.addListener((message) => responses.push(message));
    broker.handlePort(brokerClient);

    contentClient.postMessage({ type: 'prepare', jobId: 'firefox-job' });

    await vi.waitFor(() => {
      expect(responses).toContainEqual({ type: 'ready', jobId: 'firefox-job' });
    });
    expect(runtimeConnect).not.toHaveBeenCalled();

    contentClient.disconnect();
    await lifecycle.closeHost();
  });

  it('uses an in-process translation transport instead of messaging its own background frame', async () => {
    const runtimeSendMessage = vi.fn(() => {
      throw new Error('Firefox excludes the sending frame from runtime.onMessage');
    });
    const api: ExtensionBrowserApi = {
      runtime: {
        sendMessage: runtimeSendMessage,
        getURL: (path) => `moz-extension://test/${path}`,
        onConnect: { addListener: () => undefined },
      },
    };
    vi.stubGlobal('chrome', api);
    const requestChatCompletion = vi.fn(async () => ({
      choices: [{ message: { content: JSON.stringify({
        regions: [{ id: 'region-1', translation: 'translated' }],
      }) } }],
    }));
    const emitDiagnosticLog = vi.fn();
    const emitDiagnosticLogAsync = vi.fn(async () => true);
    const lifecycle = new FirefoxPipelineHostLifecycle({
      ...createRuntimeDependencies(),
      translationTransport: {
        requestChatCompletion,
        translatePlain: vi.fn(async () => 'translated'),
      },
      diagnostics: {
        emit: emitDiagnosticLog,
        emitAsync: emitDiagnosticLogAsync,
      },
    });
    const broker = new PipelineHostBroker(api, lifecycle);
    const [brokerClient, contentClient] = createLocalExtensionPortPair(
      LOCAL_PIPELINE_CLIENT_PORT,
    );
    const responses: unknown[] = [];
    contentClient.onMessage.addListener((message) => responses.push(message));
    broker.handlePort(brokerClient);
    mocks.runPipeline.mockImplementation(async (
      _file,
      _config,
      _progress,
      options: {
        textTranslator: {
          translateRegions(request: unknown): Promise<unknown>;
        };
      },
    ) => {
      await options.textTranslator.translateRegions({
        regions: [{
          id: 'region-1',
          sourceText: 'source',
          translatedText: '',
          direction: 'h',
        }],
        config: _config,
      });
      return artifacts();
    });

    contentClient.postMessage({
      type: 'prepare',
      jobId: 'firefox-translate',
      diagnosticRunId: 'run-firefox-translate',
    });
    await vi.waitFor(() => {
      expect(responses).toContainEqual({ type: 'ready', jobId: 'firefox-translate' });
    });
    contentClient.postMessage({
      type: 'start',
      jobId: 'firefox-translate',
      file: {
        name: 'source.png',
        type: 'image/png',
        size: 1,
        lastModified: 1,
      },
      config: {
        sourceLang: 'ja',
        targetLang: 'zh-CN',
        translator: 'llm',
        llmProvider: 'deepseek',
        llmAuthMode: 'api_key',
        llmBaseUrl: 'https://api.deepseek.com/',
        llmModel: 'deepseek-v4-flash',
        typesetDebug: false,
        eraseDebug: false,
        collectDebugLog: true,
        ocrEngine: 'paddleocr_v6_medium',
        processMode: 'translate',
      },
      input: { chunkCount: 1, totalChars: 4 },
    });
    contentClient.postMessage({
      type: 'input-chunk',
      jobId: 'firefox-translate',
      index: 0,
      data: 'AQ==',
    });
    contentClient.postMessage({ type: 'input-complete', jobId: 'firefox-translate' });

    await vi.waitFor(() => {
      expect(responses).toContainEqual({ type: 'complete', jobId: 'firefox-translate' });
    });
    expect(requestChatCompletion).toHaveBeenCalledOnce();
    expect(emitDiagnosticLogAsync).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-firefox-translate',
      source: { context: 'pipeline-host', module: 'pipelineHost.ts' },
    }));
    expect(runtimeSendMessage).not.toHaveBeenCalled();

    contentClient.disconnect();
    await lifecycle.closeHost();
  });

  it('waits for host cleanup before admitting the next image', async () => {
    const api: ExtensionBrowserApi = {
      runtime: {
        getURL: (path) => `moz-extension://test/${path}`,
        onConnect: { addListener: () => undefined },
      },
    };
    vi.stubGlobal('chrome', api);
    const finishLogStarted = deferred();
    const releaseFinishLog = deferred();
    const emitDiagnosticLogAsync = vi.fn(async (event: { message: string }) => {
      if (event.message === '本地流水线宿主执行完成') {
        finishLogStarted.resolve();
        await releaseFinishLog.promise;
      }
      return true;
    });
    const lifecycle = new FirefoxPipelineHostLifecycle({
      ...createRuntimeDependencies(),
      diagnostics: {
        emit: vi.fn(),
        emitAsync: emitDiagnosticLogAsync,
      },
    });
    const broker = new PipelineHostBroker(api, lifecycle);
    const [firstBrokerClient, firstContentClient] = createLocalExtensionPortPair(
      LOCAL_PIPELINE_CLIENT_PORT,
    );
    const [secondBrokerClient, secondContentClient] = createLocalExtensionPortPair(
      LOCAL_PIPELINE_CLIENT_PORT,
    );
    const firstResponses: unknown[] = [];
    const secondResponses: unknown[] = [];
    firstContentClient.onMessage.addListener((message) => firstResponses.push(message));
    secondContentClient.onMessage.addListener((message) => secondResponses.push(message));
    broker.handlePort(firstBrokerClient);
    broker.handlePort(secondBrokerClient);
    mocks.runPipeline.mockResolvedValue(artifacts());

    try {
      firstContentClient.postMessage({ type: 'prepare', jobId: 'first-image' });
      secondContentClient.postMessage({ type: 'prepare', jobId: 'second-image' });
      await vi.waitFor(() => {
        expect(firstResponses).toContainEqual({ type: 'ready', jobId: 'first-image' });
        expect(secondResponses).toContainEqual({ type: 'ready', jobId: 'second-image' });
      });

      transferImageJob(firstContentClient, 'first-image');
      transferImageJob(secondContentClient, 'second-image');
      await finishLogStarted.promise;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      releaseFinishLog.resolve();

      await vi.waitFor(() => {
        expect(firstResponses).toContainEqual({ type: 'complete', jobId: 'first-image' });
        expect(secondResponses).toContainEqual({ type: 'complete', jobId: 'second-image' });
      });
      expect(secondResponses).not.toContainEqual(expect.objectContaining({
        type: 'error',
        error: expect.objectContaining({ code: 'RUNTIME_BUSY' }),
      }));
      expect(mocks.runPipeline).toHaveBeenCalledTimes(2);
    } finally {
      releaseFinishLog.resolve();
      firstContentClient.disconnect();
      secondContentClient.disconnect();
      await lifecycle.closeHost();
    }
  });
});
