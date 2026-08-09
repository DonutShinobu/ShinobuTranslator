import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPipelineRecord } from '@shinobu/image-pipeline';
import type { ExtensionBrowserApi, ExtensionPort } from '../../../apps/extension/src/shared/extensionRuntime';
import {
  LOCAL_PIPELINE_CLIENT_PORT,
} from '../../../packages/image-pipeline/src/protocol/index';
import type { PipelineConfig } from '../../../packages/image-pipeline/src/types';

class FakePort implements ExtensionPort {
  readonly sent: unknown[] = [];
  readonly messageListeners: Array<(message: unknown, port: ExtensionPort) => void> = [];
  readonly disconnectListeners: Array<(port: ExtensionPort) => void> = [];
  disconnected = false;

  constructor(readonly name: string) {}

  postMessage(message: unknown): void {
    if (this.disconnected) throw new Error('port disconnected');
    this.sent.push(message);
  }

  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const listener of [...this.disconnectListeners]) listener(this);
  }

  onMessage = {
    addListener: (listener: (message: unknown, port: ExtensionPort) => void): void => {
      this.messageListeners.push(listener);
    },
    removeListener: (listener: (message: unknown, port: ExtensionPort) => void): void => {
      const index = this.messageListeners.indexOf(listener);
      if (index >= 0) this.messageListeners.splice(index, 1);
    },
  };

  onDisconnect = {
    addListener: (listener: (port: ExtensionPort) => void): void => {
      this.disconnectListeners.push(listener);
    },
    removeListener: (listener: (port: ExtensionPort) => void): void => {
      const index = this.disconnectListeners.indexOf(listener);
      if (index >= 0) this.disconnectListeners.splice(index, 1);
    },
  };

  emitMessage(message: unknown): void {
    for (const listener of [...this.messageListeners]) listener(message, this);
  }
}

class FakeFileReader {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;

  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((buffer) => {
      this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
      this.onload?.();
    }, () => this.onerror?.());
  }
}

const pipelineConfig: PipelineConfig = {
  sourceLang: 'ja',
  targetLang: 'zh-CN',
  translator: 'llm',
  llmProvider: 'openai',
  llmAuthMode: 'api_key',
  llmBaseUrl: 'https://example.invalid',
  llmModel: 'test-model',
  typesetDebug: false,
  eraseDebug: false,
  collectDebugLog: false,
  ocrEngine: 'paddleocr_v6_medium',
  processMode: 'erase',
};

const record = createPipelineRecord({
  image: { width: 1, height: 1 },
  ocr: [],
  ordered: [],
}, { strategy: 'source-native' });

async function completePipelineRun(
  runLocalPipeline: typeof import('../../../apps/extension/src/content/core/translation/localPipelineClient').runLocalPipeline,
  client: FakePort,
  beforeReady?: () => void,
  options?: Parameters<typeof runLocalPipeline>[3],
  afterTransfer?: (jobId: string) => void,
): Promise<void> {
  const resultPromise = runLocalPipeline(
    new File([Uint8Array.of(1)], 'source.png', { type: 'image/png', lastModified: 1 }),
    pipelineConfig,
    () => undefined,
    options,
  );
  const prepare = client.sent.find((message) => (
    (message as { type?: string }).type === 'prepare'
  )) as { jobId: string } | undefined;
  expect(prepare).toBeDefined();
  const jobId = prepare!.jobId;
  beforeReady?.();
  client.emitMessage({ type: 'ready', jobId });
  await vi.waitFor(() => expect(client.sent).toContainEqual({ type: 'input-complete', jobId }));
  afterTransfer?.(jobId);
  client.emitMessage({
    type: 'result-meta',
    jobId,
    status: 'completed',
    result: { contentType: 'image/png', chunkCount: 1, totalChars: 4 },
    summary: {
      image: { width: 1, height: 1 },
      detectedRegionCount: 0,
      stageTimings: [],
      runtimeStages: [],
    },
    record,
  });
  client.emitMessage({ type: 'result-chunk', jobId, artifact: 'result', index: 0, data: 'AQ==' });
  client.emitMessage({ type: 'complete', jobId });
  await resultPromise;
}

describe('runLocalPipeline', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('FileReader', FakeFileReader);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens one client Port per completed pipeline job', async () => {
    const clients = [
      new FakePort(LOCAL_PIPELINE_CLIENT_PORT),
      new FakePort(LOCAL_PIPELINE_CLIENT_PORT),
    ];
    const connectionNames: string[] = [];
    const api: ExtensionBrowserApi = {
      runtime: {
        getURL: (path) => `moz-extension://test/${path}`,
        connect: ({ name } = {}) => {
          connectionNames.push(name ?? '');
          const client = clients.shift();
          if (!client) throw new Error('unexpected client connection');
          return client;
        },
      },
    };
    vi.stubGlobal('chrome', api);
    const { runLocalPipeline } = await import('../../../apps/extension/src/content/core/translation/localPipelineClient');
    const firstClient = clients[0]!;
    await completePipelineRun(runLocalPipeline, firstClient);
    const secondClient = clients[0]!;
    await completePipelineRun(runLocalPipeline, secondClient);

    expect(connectionNames).toEqual([
      LOCAL_PIPELINE_CLIENT_PORT,
      LOCAL_PIPELINE_CLIENT_PORT,
    ]);
    expect(firstClient.disconnected).toBe(true);
    expect(secondClient.disconnected).toBe(true);
  });

  it('runs a detection-only probe and reconstructs its packed mask blob', async () => {
    const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    const api: ExtensionBrowserApi = {
      runtime: {
        getURL: (path) => `moz-extension://test/${path}`,
        connect: () => client,
      },
    };
    vi.stubGlobal('chrome', api);
    const { runLocalDetectionProbe } = await import(
      '../../../apps/extension/src/content/core/translation/localPipelineClient'
    );
    const resultPromise = runLocalDetectionProbe(
      new File([Uint8Array.of(1)], 'source.png', { type: 'image/png', lastModified: 1 }),
    );
    const prepare = client.sent.find((message) => (
      (message as { type?: string }).type === 'prepare'
    )) as { jobId: string };
    client.emitMessage({ type: 'ready', jobId: prepare.jobId });
    await vi.waitFor(() => expect(client.sent).toContainEqual({
      type: 'input-complete',
      jobId: prepare.jobId,
    }));
    expect(client.sent).toContainEqual(expect.objectContaining({
      type: 'start-detection-probe',
      jobId: prepare.jobId,
    }));
    client.emitMessage({
      type: 'detection-result',
      jobId: prepare.jobId,
      detection: {
        width: 1,
        height: 2,
        packedMaskBase64: 'AQ==',
        regions: [{
          id: 'region-1',
          box: { x: 0, y: 0, width: 1, height: 2 },
          direction: 'v',
          prob: 0.9,
          sourceText: '',
          translatedText: '',
        }],
      },
      detectorSignature: 'detector-v1',
      topTouches: true,
      bottomTouches: true,
    });
    client.emitMessage({ type: 'complete', jobId: prepare.jobId });

    const result = await resultPromise;
    expect(result.detectorSignature).toBe('detector-v1');
    expect(result.topTouches).toBe(true);
    expect(result.bottomTouches).toBe(true);
    expect(result.detection.regions).toHaveLength(1);
    expect(new Uint8Array(await result.detection.packedMask.arrayBuffer())).toEqual(
      Uint8Array.of(1),
    );
    expect(client.disconnected).toBe(true);
  });

  it('sends a precomputed detection with a normal pipeline request', async () => {
    const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    const api: ExtensionBrowserApi = {
      runtime: {
        getURL: (path) => `moz-extension://test/${path}`,
        connect: () => client,
      },
    };
    vi.stubGlobal('chrome', api);
    const { runLocalPipeline } = await import(
      '../../../apps/extension/src/content/core/translation/localPipelineClient'
    );
    const detection = {
      width: 1,
      height: 2,
      packedMask: new Blob([Uint8Array.of(1)], { type: 'application/octet-stream' }),
      regions: [{
        id: 'region-1',
        box: { x: 0, y: 0, width: 1, height: 2 },
        direction: 'v' as const,
        prob: 0.9,
        sourceText: '',
        translatedText: '',
      }],
    };

    await completePipelineRun(
      runLocalPipeline,
      client,
      undefined,
      { precomputedDetection: detection },
      (jobId) => {
        expect(client.sent).toContainEqual(expect.objectContaining({
          type: 'start',
          jobId,
          detection: {
            width: 1,
            height: 2,
            packedMaskBase64: 'AQ==',
            regions: detection.regions,
          },
        }));
      },
    );
  });
});
