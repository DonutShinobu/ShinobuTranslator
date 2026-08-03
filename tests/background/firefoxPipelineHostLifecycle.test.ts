import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineArtifacts } from '../../src/types';

const mocks = vi.hoisted(() => ({
  runPipeline: vi.fn(),
  disposeAllModelSessions: vi.fn(async () => undefined),
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
import type { ExtensionBrowserApi } from '../../src/shared/extensionRuntime';
import { createLocalExtensionPortPair } from '../../src/shared/localExtensionPort';
import { LOCAL_PIPELINE_CLIENT_PORT } from '../../src/shared/localPipelineProtocol';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FirefoxPipelineHostLifecycle', () => {
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
    const lifecycle = new FirefoxPipelineHostLifecycle();
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
      choices: [{ message: { content: 'translated' } }],
    }));
    const emitDiagnosticLog = vi.fn();
    const emitDiagnosticLogAsync = vi.fn(async () => true);
    const lifecycle = new FirefoxPipelineHostLifecycle({
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
        translationTransport: {
          requestChatCompletion(request: unknown): Promise<unknown>;
        };
      },
    ) => {
      await options.translationTransport.requestChatCompletion({
        body: {
          model: 'deepseek-v4-flash',
          messages: [{ role: 'user', content: 'source' }],
        },
        proxyConfig: {
          provider: 'deepseek',
          authMode: 'api_key',
          baseUrl: 'https://api.deepseek.com/',
        },
        diagnosticRunId: 'run-firefox-translate',
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
        llmApiKey: '',
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
});
