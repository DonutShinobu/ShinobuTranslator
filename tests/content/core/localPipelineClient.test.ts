import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPipelineRecord } from '@shinobu/image-pipeline';
import { packEditableImage } from '@shinobu/image-pipeline/editor';
import type { ExtensionBrowserApi, ExtensionPort } from '../../../apps/extension/src/shared/extensionRuntime';
import {
  LOCAL_PIPELINE_CLIENT_PORT,
  LOCAL_PIPELINE_STRUCTURED_CLONE_PROBE_TYPE,
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

  it.each([false, true])('collects editable layers through the negotiated transport (native=%s)', async (native) => {
    vi.stubGlobal('__shinobuColdStartStructuredClone', native);
    const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    vi.stubGlobal('chrome', { runtime: { connect: () => client } } satisfies ExtensionBrowserApi);
    const { runLocalPipeline } = await import(
      '../../../apps/extension/src/content/core/translation/localPipelineClient'
    );
    const pending = runLocalPipeline(new File(['source'], 'source.png', { type: 'image/png' }), pipelineConfig,
      () => undefined, { collectEditableLayers: true });
    const { jobId } = client.sent[0] as { jobId: string };
    client.emitMessage({ type: 'ready', jobId, structuredClone: native });
    await vi.waitFor(() => expect(client.sent).toContainEqual({ type: 'input-complete', jobId }));
    expect(client.sent).toContainEqual(expect.objectContaining({ type: 'start', collectEditableLayers: true }));
    const editableBlob = packEditableImage({ width: 1, height: 1, targetLang: 'zh-CN', layers: [{
      id: 'erase:r1', regionId: 'r1', kind: 'erase', image: new Blob([Uint8Array.of(3, 128, 255)], { type: 'image/png' }),
      width: 1, height: 1, transform: [1, 0, 0, 1, 0, 0],
      quad: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
    }] });
    const base64 = Buffer.from(await editableBlob.arrayBuffer()).toString('base64');
    client.emitMessage({
      type: 'result-meta', jobId, status: 'completed',
      result: { contentType: 'image/png', chunkCount: native ? 0 : 1, totalChars: native ? 0 : 4 },
      editable: { contentType: editableBlob.type, chunkCount: native ? 0 : 1, totalChars: native ? 0 : base64.length },
      ...(native ? { resultBlob: new Blob(['png'], { type: 'image/png' }), editableBlob } : {}),
      summary: { image: { width: 1, height: 1 }, detectedRegionCount: 0, stageTimings: [], runtimeStages: [] }, record,
    });
    if (!native) {
      client.emitMessage({ type: 'result-chunk', jobId, artifact: 'result', index: 0, data: 'AQ==' });
      client.emitMessage({ type: 'result-chunk', jobId, artifact: 'editable', index: 0, data: base64 });
    }
    client.emitMessage({ type: 'complete', jobId });
    // The host may close its Port while the completed artifact is still being decoded.
    client.disconnect();
    const result = await pending;
    expect(result.editable?.layers[0]).toMatchObject({ id: 'erase:r1', kind: 'erase' });
    expect(new Uint8Array(await result.editable!.layers[0].image.arrayBuffer())).toEqual(Uint8Array.of(3, 128, 255));
    expect(client.messageListeners).toHaveLength(0);
    expect(client.disconnectListeners).toHaveLength(0);
  });

  it('transfers native File and completed PNG Blobs only after capability acknowledgement', async () => {
    vi.stubGlobal('__shinobuColdStartStructuredClone', true);
    const read = vi.spyOn(FakeFileReader.prototype, 'readAsDataURL');
    const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    vi.stubGlobal('chrome', { runtime: { connect: () => client } } satisfies ExtensionBrowserApi);
    const { runLocalPipeline } = await import(
      '../../../apps/extension/src/content/core/translation/localPipelineClient'
    );
    const source = new File([Uint8Array.of(0, 128, 255)], 'source.png', { type: 'image/png' });
    const pending = runLocalPipeline(source, pipelineConfig, () => undefined);
    const prepare = client.sent[0] as { jobId: string; structuredCloneProbe: Blob };
    expect(prepare.structuredCloneProbe).toBeInstanceOf(Blob);
    expect(prepare.structuredCloneProbe.type).toBe(LOCAL_PIPELINE_STRUCTURED_CLONE_PROBE_TYPE);
    client.emitMessage({ type: 'ready', jobId: prepare.jobId, structuredClone: true });
    await vi.waitFor(() => expect(client.sent).toContainEqual({ type: 'input-complete', jobId: prepare.jobId }));
    expect(client.sent).toContainEqual(expect.objectContaining({
      type: 'start', binaryFile: source, input: { chunkCount: 0, totalChars: 0 },
    }));
    expect(client.sent.some((message) => (message as { type: string }).type === 'input-chunk')).toBe(false);
    expect(read).not.toHaveBeenCalled();
    const resultBlob = new Blob([Uint8Array.of(3, 127, 255)], { type: 'image/png' });
    const debugBlob = new Blob([Uint8Array.of(5, 255)], { type: 'image/png' });
    client.emitMessage({
      type: 'result-meta', jobId: prepare.jobId, status: 'completed',
      result: { contentType: 'image/png', chunkCount: 0, totalChars: 0 }, resultBlob,
      debug: { contentType: 'image/png', chunkCount: 0, totalChars: 0 }, debugBlob,
      summary: { image: { width: 1, height: 1 }, detectedRegionCount: 0, stageTimings: [], runtimeStages: [] },
      record,
    });
    expect(client.disconnected).toBe(false);
    client.emitMessage({ type: 'complete', jobId: prepare.jobId });
    const result = await pending;
    expect(result.result).toBe(resultBlob);
    expect(result.debug).toBe(debugBlob);
    expect(new Uint8Array(await result.result.arrayBuffer())).toEqual(Uint8Array.of(3, 127, 255));
    expect(client.disconnected).toBe(true);
    read.mockRestore();
  });

  it('falls back to Base64 when a requested capability is not acknowledged', async () => {
    vi.stubGlobal('__shinobuColdStartStructuredClone', true);
    const read = vi.spyOn(FakeFileReader.prototype, 'readAsDataURL');
    const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    vi.stubGlobal('chrome', { runtime: { connect: () => client } } satisfies ExtensionBrowserApi);
    const { runLocalPipeline } = await import(
      '../../../apps/extension/src/content/core/translation/localPipelineClient'
    );
    await completePipelineRun(runLocalPipeline, client);
    expect(client.sent).toContainEqual(expect.objectContaining({ type: 'input-chunk', data: 'AQ==' }));
    expect(client.sent.find((message) => (message as { type: string }).type === 'start'))
      .not.toHaveProperty('binaryFile');
    expect(read).toHaveBeenCalledOnce();
    read.mockRestore();
  });

  it('rejects an unsolicited native Blob result', async () => {
    const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    vi.stubGlobal('chrome', { runtime: { connect: () => client } } satisfies ExtensionBrowserApi);
    const { runLocalPipeline } = await import(
      '../../../apps/extension/src/content/core/translation/localPipelineClient'
    );
    const pending = runLocalPipeline(new File(['x'], 'source.png'), pipelineConfig, () => undefined);
    const { jobId } = client.sent[0] as { jobId: string };
    const rejected = expect(pending).rejects.toMatchObject({ code: 'TRANSFER_PROTOCOL_ERROR' });
    client.emitMessage({
      type: 'result-meta', jobId, status: 'completed',
      result: { contentType: 'image/png', chunkCount: 0, totalChars: 0 },
      resultBlob: new Blob(['x'], { type: 'image/png' }),
      summary: { image: { width: 1, height: 1 }, detectedRegionCount: 0, stageTimings: [], runtimeStages: [] },
      record,
    });
    await rejected;
    expect(client.disconnected).toBe(true);
  });

  it('opens the Port before a promised input arrives and closes it on source failure', async () => {
    const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    vi.stubGlobal('chrome', {
      runtime: { connect: () => client },
    } satisfies ExtensionBrowserApi);
    const { runLocalPipeline } = await import(
      '../../../apps/extension/src/content/core/translation/localPipelineClient'
    );
    let rejectSource!: (error: Error) => void;
    const source = new Promise<File>((_resolve, reject) => { rejectSource = reject; });
    const result = runLocalPipeline(source, pipelineConfig, () => undefined);
    const prepare = client.sent[0] as { jobId: string };
    expect(client.sent[0]).toMatchObject({ type: 'prepare' });
    client.emitMessage({ type: 'ready', jobId: prepare.jobId });
    await Promise.resolve();
    expect(client.sent).toHaveLength(1);
    const failure = new Error('download failed');
    const rejected = expect(result).rejects.toBe(failure);
    rejectSource(failure);
    await rejected;
    expect(client.disconnected).toBe(true);
    expect(client.sent).toHaveLength(1);
  });

  it.each([false, true])('does not transfer a promised input after cancellation (native=%s)', async (native) => {
    vi.stubGlobal('__shinobuColdStartStructuredClone', native);
    const client = new FakePort(LOCAL_PIPELINE_CLIENT_PORT);
    vi.stubGlobal('chrome', {
      runtime: { connect: () => client },
    } satisfies ExtensionBrowserApi);
    const { runLocalPipeline } = await import(
      '../../../apps/extension/src/content/core/translation/localPipelineClient'
    );
    let resolveSource!: (file: File) => void;
    const source = new Promise<File>((resolve) => { resolveSource = resolve; });
    const controller = new AbortController();
    const result = runLocalPipeline(source, pipelineConfig, () => undefined, { signal: controller.signal });
    const { jobId } = client.sent[0] as { jobId: string };
    client.emitMessage({ type: 'ready', jobId, structuredClone: native });
    const rejected = expect(result).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    controller.abort('closed');
    client.emitMessage({
      type: 'error', jobId,
      error: { name: 'ImagePipelineCancelledError', code: 'TASK_CANCELLED', message: 'cancelled' },
    });
    await rejected;
    resolveSource(new File(['source'], 'source.png', { type: 'image/png' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(client.disconnected).toBe(true);
    expect(client.sent.map((message) => (message as { type: string }).type)).toEqual(['prepare', 'cancel']);
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
      topStrength: 16,
      bottomStrength: 15,
    });
    client.emitMessage({ type: 'complete', jobId: prepare.jobId });

    const result = await resultPromise;
    expect(result.detectorSignature).toBe('detector-v1');
    expect(result.topTouches).toBe(true);
    expect(result.bottomTouches).toBe(true);
    expect(result.topStrength).toBe(16);
    expect(result.bottomStrength).toBe(15);
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
