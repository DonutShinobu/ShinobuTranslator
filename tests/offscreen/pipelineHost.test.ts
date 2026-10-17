import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionPort } from '../../apps/extension/src/shared/extensionRuntime';
import type { PipelineArtifacts } from '../../packages/image-pipeline/src/types';
import type { PipelinePlatform, PipelineConfig, VisionRegionClassifier } from '@shinobu/image-pipeline';
import type { ModelRuntime } from '@shinobu/model-runtime';
import { LOCAL_PIPELINE_STRUCTURED_CLONE_PROBE_TYPE } from '@shinobu/image-pipeline/protocol';
import { unpackEditableImage } from '@shinobu/image-pipeline/editor';

const mocks = vi.hoisted(() => ({
  runPipeline: vi.fn(),
  probeTextDetection: vi.fn(),
  disposeAllModelSessions: vi.fn(async () => undefined),
  blobToBase64: vi.fn(async (_value: Blob) => 'cmVzdWx0'),
}));

vi.mock('../../packages/image-pipeline/src/pipeline/orchestrator', () => ({
  runPipeline: mocks.runPipeline,
  PipelineStageError: class PipelineStageError extends Error {},
}));

vi.mock('@shinobu/image-pipeline', async (importOriginal) => ({
  ...await importOriginal<typeof import('@shinobu/image-pipeline')>(),
  probeTextDetection: mocks.probeTextDetection,
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
    return new Blob([Uint8Array.from(binary, (char) => char.charCodeAt(0))], { type: contentType });
  },
  blobToBase64: mocks.blobToBase64,
  canvasToPngBlob: vi.fn(async () => new Blob(['result'], { type: 'image/png' })),
}));

import {
  PipelineHost,
  type PipelineHostDependencies,
} from '../../apps/extension/src/offscreen/pipelineHost';
import { LOCAL_PIPELINE_HOST_PORT } from '../../packages/image-pipeline/src/protocol/index';

class FakePort implements ExtensionPort {
  readonly name = LOCAL_PIPELINE_HOST_PORT;
  readonly sent: unknown[] = [];
  readonly messageListeners: Array<(message: unknown, port: ExtensionPort) => void> = [];
  readonly disconnectListeners: Array<(port: ExtensionPort) => void> = [];
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
    addListener: (listener: (message: unknown, port: ExtensionPort) => void): void => {
      this.messageListeners.push(listener);
    },
    removeListener: (): void => undefined,
  };

  onDisconnect = {
    addListener: (listener: (port: ExtensionPort) => void): void => {
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
    ocrPostFilterDebug: null,
    runtimeStages: [],
    stageTimings: [],
  };
}

function sendImageJob(
  port: FakePort,
  jobId: string,
  detection?: {
    width: number;
    height: number;
    packedMaskBase64: string;
    regions: readonly unknown[];
  },
  configOverrides?: Partial<PipelineConfig>,
  binary = false,
  collectEditableLayers = false,
): void {
  port.emit({ type: 'prepare', jobId, ...(binary ? {
    structuredCloneProbe: new Blob([Uint8Array.of(83)], { type: LOCAL_PIPELINE_STRUCTURED_CLONE_PROBE_TYPE }),
  } : {}) });
  port.emit({
    type: 'start',
    jobId,
    ...(collectEditableLayers ? { collectEditableLayers: true } : {}),
    file: { name: `${jobId}.png`, type: 'image/png', size: 1, lastModified: 1 },
    config: {
      sourceLang: 'ja',
      targetLang: 'zh-CN',
      translator: 'google_web',
      llmProvider: 'deepseek',
      llmAuthMode: 'api_key',
      llmBaseUrl: '',
      llmModel: '',
      typesetDebug: false,
      eraseDebug: false,
      collectDebugLog: false,
      ocrEngine: 'paddleocr_v6_medium',
      processMode: 'original',
      ...configOverrides,
    },
    input: binary ? { chunkCount: 0, totalChars: 0 } : { chunkCount: 1, totalChars: 4 },
    ...(binary ? { binaryFile: new File([Uint8Array.of(1)], `${jobId}.png`, { type: 'image/png' }) } : {}),
    ...(detection ? { detection } : {}),
  });
  if (!binary) port.emit({ type: 'input-chunk', jobId, index: 0, data: 'AQ==' });
  port.emit({ type: 'input-complete', jobId });
}

describe('PipelineHost single-task admission', () => {
  let port: FakePort;
  let originalChrome: unknown;
  let hosts: PipelineHost[];

  beforeEach(() => {
    mocks.runPipeline.mockReset();
    mocks.probeTextDetection.mockReset();
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
    vi.unstubAllGlobals();
    (globalThis as { chrome?: unknown }).chrome = originalChrome;
    port.disconnect();
  });

  function createHost(overrides: Partial<PipelineHostDependencies> = {}): PipelineHost {
    const modelRuntime: ModelRuntime = {
      readModel: vi.fn(),
      getSession: vi.fn(),
      run: vi.fn(),
      runImage: vi.fn(),
      readTextResource: vi.fn(),
      releaseSession: vi.fn(async () => undefined),
      dispose: mocks.disposeAllModelSessions,
    };
    const platform = {} as PipelinePlatform;
    const host = new PipelineHost(undefined, {
      modelRuntime,
      platform,
      hostInstanceId: 'pipeline-host-test',
      ...overrides,
    });
    hosts.push(host);
    return host;
  }

  it('routes filtering through the injected transport using the job model snapshot', async () => {
    const requestChatCompletion = vi.fn(async () => ({ choices: [{ message: { content: 'false_positive' } }] }));
    mocks.runPipeline.mockImplementationOnce(async (_source, _config, _progress, options: { classifyVisionRegions: VisionRegionClassifier }) => {
      expect(await options.classifyVisionRegions([{
        id: 'r1', text: 'あ', ocrConfidence: 0.6, detectorConfidence: 0.7, direction: 'v',
        lineCount: 1, inBubble: false, areaPercent: 12, boxPercent: { x: 0, y: 0, width: 30, height: 40 },
        imageDataUrl: 'data:image/jpeg;base64,YQ==',
      }])).toEqual(['r1']);
      return artifacts();
    });
    const host = createHost({ translationTransport: { requestChatCompletion, translatePlain: vi.fn() } });
    host.connect();
    sendImageJob(port, 'filter', undefined, {
      translator: 'llm', llmOcrFilter: true, llmProvider: 'mimo', llmModel: 'mimo-v2.6-flash', llmBaseUrl: 'https://api.xiaomimimo.com/v1',
    });
    await vi.waitFor(() => expect(port.sent).toContainEqual({ type: 'complete', jobId: 'filter' }));
    expect(requestChatCompletion).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.objectContaining({ model: 'mimo-v2.6-flash' }),
      proxyConfig: expect.objectContaining({ provider: 'mimo', baseUrl: 'https://api.xiaomimimo.com/v1' }),
    }));
  });

  it.each([false, true])('exports opted-in layers through the host transport (native=%s)', async (native) => {
    vi.stubGlobal('__shinobuColdStartStructuredClone', native);
    mocks.blobToBase64.mockImplementation(async (value: Blob) => Buffer.from(await value.arrayBuffer()).toString('base64'));
    const output = artifacts();
    output.editableLayers = { erase: [{ regionId: 'r1',
      canvas: { width: 1, height: 1 } as PipelineArtifacts['resultCanvas'],
      bounds: { x: 0, y: 0, width: 1, height: 1 } }], text: [] };
    mocks.runPipeline.mockResolvedValueOnce(output);
    const host = createHost({ platform: { encodeCanvasToPng: async () => new Blob(['png'], { type: 'image/png' }) } as unknown as PipelinePlatform });
    host.connect(); sendImageJob(port, 'editable', undefined, undefined, native, true);
    await vi.waitFor(() => expect(port.sent).toContainEqual({ type: 'complete', jobId: 'editable' }));
    expect(mocks.runPipeline.mock.calls[0]![3]).toMatchObject({ collectEditableLayers: true });
    const meta = port.sent.find((value) => (value as { type: string }).type === 'result-meta') as {
      editable: { contentType: string }; editableBlob?: Blob;
    };
    const chunks = port.sent.filter((value) => (value as { artifact?: string }).artifact === 'editable') as { data: string }[];
    const packed = meta.editableBlob ?? new Blob([Buffer.from(chunks.map((part) => part.data).join(''), 'base64')], { type: meta.editable.contentType });
    const restored = await unpackEditableImage(packed);
    expect(restored.layers[0]).toMatchObject({ id: 'erase:r1', kind: 'erase', transform: [1, 0, 0, 1, 0, 0] });
    expect(await restored.layers[0].image.text()).toBe('png');
    expect(chunks.length > 0).toBe(!native);
  });

  it('waits for full result and debug PNG encoding before delivering native Blobs', async () => {
    vi.stubGlobal('__shinobuColdStartStructuredClone', true);
    const image = deferred<Blob>();
    const debug = deferred<Blob>();
    const encodeCanvasToPng = vi.fn()
      .mockImplementationOnce(() => image.promise)
      .mockImplementationOnce(() => debug.promise);
    const output = artifacts();
    output.debugOriginalCanvas = {} as PipelineArtifacts['debugOriginalCanvas'];
    mocks.runPipeline.mockResolvedValueOnce(output);
    const host = createHost({ platform: { encodeCanvasToPng } as unknown as PipelinePlatform });
    host.connect();
    sendImageJob(port, 'binary-png', undefined, { typesetDebug: true }, true);
    expect(port.sent).toContainEqual({ type: 'ready', jobId: 'binary-png', structuredClone: true });
    await vi.waitFor(() => expect(encodeCanvasToPng).toHaveBeenCalledOnce());
    const received = mocks.runPipeline.mock.calls[0]![0] as File;
    expect(received.name).toBe('binary-png.png');
    expect(new Uint8Array(await received.arrayBuffer())).toEqual(Uint8Array.of(1));
    expect(port.sent).not.toContainEqual(expect.objectContaining({ type: 'result-meta' }));
    const imageBlob = new Blob([Uint8Array.of(0, 128, 255)], { type: 'image/png' });
    const debugBlob = new Blob([Uint8Array.of(2, 255)], { type: 'image/png' });
    image.resolve(imageBlob);
    await vi.waitFor(() => expect(encodeCanvasToPng).toHaveBeenCalledTimes(2));
    expect(port.sent).not.toContainEqual(expect.objectContaining({ type: 'result-meta' }));
    debug.resolve(debugBlob);
    await vi.waitFor(() => expect(port.sent).toContainEqual({ type: 'complete', jobId: 'binary-png' }));
    expect(port.sent).toContainEqual(expect.objectContaining({
      type: 'result-meta', jobId: 'binary-png',
      result: { contentType: 'image/png', chunkCount: 0, totalChars: 0 }, resultBlob: imageBlob,
      debug: { contentType: 'image/png', chunkCount: 0, totalChars: 0 }, debugBlob,
    }));
    expect(port.sent).not.toContainEqual(expect.objectContaining({ type: 'result-chunk' }));
    expect(mocks.blobToBase64).not.toHaveBeenCalled();
  });

  it.each([undefined, false, true])('loads ordered early sessions and only defers inpaint when enabled (%s)', async (lateInpaint) => {
    vi.stubGlobal('__shinobuColdStartEarlySessions', true);
    vi.stubGlobal('__shinobuColdStartEarlyInpaintAfterBubble', lateInpaint);
    const getSession = vi.fn(async (name: string) => ({
      sessionId: name, provider: 'webgpu' as const, inputNames: ['input'], outputNames: ['output'],
    }));
    const readModel = vi.fn(async () => ({
      name: 'paddleocr_v6_medium_rec', task: 'ocr', url: 'ocr.onnx',
      dictUrl: 'early-session-order-dict.txt', input: [48, 320],
      runtime: ['webgpu', 'webnn', 'wasm'],
    }));
    const run = vi.fn();
    const host = createHost({ modelRuntime: {
      getSession, readModel, readTextResource: vi.fn(async () => 'a\nb'),
      run, dispose: mocks.disposeAllModelSessions,
    } as unknown as ModelRuntime });
    await (host as unknown as { earlySessions: Promise<void> }).earlySessions;
    const earlyNames = ['detector', 'bubble', 'paddleocr_v6_medium_rec'];
    if (lateInpaint !== true) earlyNames.push('inpaint');
    expect(getSession.mock.calls.map(([name]) => name)).toEqual(earlyNames);
    expect(getSession).toHaveBeenNthCalledWith(3, 'paddleocr_v6_medium_rec', ['webgpu', 'webnn', 'wasm'], undefined);
    if (lateInpaint !== true) {
      expect(getSession).toHaveBeenNthCalledWith(4, 'inpaint', ['webgpu', 'webnn', 'wasm']);
    }
    expect(run).not.toHaveBeenCalled();
    if (lateInpaint === true) {
      mocks.runPipeline.mockImplementationOnce(async (_file, _config, _progress, options: { modelRuntime: ModelRuntime }) => {
        await options.modelRuntime.getSession('inpaint', ['webgpu', 'webnn', 'wasm']);
        return artifacts();
      });
      host.connect();
      sendImageJob(port, 'late-inpaint');
      await vi.waitFor(() => expect(port.sent).toContainEqual({ type: 'complete', jobId: 'late-inpaint' }));
      expect(getSession).toHaveBeenCalledTimes(4);
      expect(getSession).toHaveBeenNthCalledWith(4, 'inpaint', ['webgpu', 'webnn', 'wasm']);
    }
  });

  it('stops later session preparation on dispose and waits for the current step', async () => {
    vi.stubGlobal('__shinobuColdStartEarlySessions', true);
    const bubble = deferred<void>();
    const getSession = vi.fn(async (name: string) => {
      if (name === 'bubble') await bubble.promise;
      return { sessionId: name, provider: 'webgpu' as const, inputNames: [], outputNames: [] };
    });
    const host = createHost({ modelRuntime: {
      getSession, dispose: mocks.disposeAllModelSessions,
    } as unknown as ModelRuntime });
    await vi.waitFor(() => expect(getSession).toHaveBeenCalledWith('bubble'));
    host.dispose();
    expect(mocks.disposeAllModelSessions).not.toHaveBeenCalled();
    bubble.resolve(undefined);
    await vi.waitFor(() => expect(mocks.disposeAllModelSessions).toHaveBeenCalledOnce());
    expect(getSession.mock.calls.map(([name]) => name)).toEqual(['detector', 'bubble']);
  });

  it('starts ordered early sessions only after the real detector submission, without waiting for its output', async () => {
    vi.stubGlobal('__shinobuColdStartEarlySessions', true);
    vi.stubGlobal('__shinobuColdStartSessionsAfterSubmit', true);
    const events: string[] = [];
    const detectorResult = deferred<unknown>();
    let submitted: (() => void) | undefined;
    const getSession = vi.fn(async (name: string) => {
      events.push(`session:${name}`);
      return { sessionId: name, provider: 'webgpu' as const, inputNames: [], outputNames: [] };
    });
    const runImage = vi.fn((_id: string, _image: ImageBitmap, onSubmitted?: () => void) => {
      submitted = onSubmitted;
      return detectorResult.promise;
    });
    mocks.runPipeline.mockImplementation(async (_file, _config, _progress, options: { modelRuntime: ModelRuntime }) => {
      await options.modelRuntime.runImage('detector', {} as ImageBitmap);
      return artifacts();
    });
    const host = createHost({ modelRuntime: {
      getSession, runImage,
      readModel: vi.fn(async () => ({ name: 'paddleocr_v6_medium_rec', task: 'ocr', url: 'ocr.onnx', dictUrl: 'after-submit-order.txt', input: [48, 320] })),
      readTextResource: vi.fn(async () => 'a\nb'), dispose: mocks.disposeAllModelSessions,
    } as unknown as ModelRuntime });
    host.connect();
    sendImageJob(port, 'after-submit');
    await vi.waitFor(() => expect(runImage).toHaveBeenCalledOnce());
    expect(getSession.mock.calls.map(([name]) => name)).toEqual(['detector']);
    events.push('detector:posted');
    submitted?.();
    await vi.waitFor(() => expect(getSession).toHaveBeenCalledTimes(4));
    expect(events).toEqual(['session:detector', 'detector:posted', 'session:bubble', 'session:paddleocr_v6_medium_rec', 'session:inpaint']);
    expect(port.sent).not.toContainEqual({ type: 'complete', jobId: 'after-submit' });
    submitted?.();
    expect(getSession).toHaveBeenCalledTimes(4);
    detectorResult.resolve({ outputs: {}, ratio: 1, unpaddedWidth: 1, unpaddedHeight: 1 });
    await vi.waitFor(() => expect(port.sent).toContainEqual({ type: 'complete', jobId: 'after-submit' }));
  });

  it.each(['complete', 'failed', 'cancel'] as const)('releases the detector submission gate when a job ends without submitting (%s)', async (terminal) => {
    vi.stubGlobal('__shinobuColdStartEarlySessions', true);
    vi.stubGlobal('__shinobuColdStartSessionsAfterSubmit', true);
    const getSession = vi.fn(async () => ({ sessionId: 'detector', provider: 'webgpu' as const, inputNames: [], outputNames: [] }));
    if (terminal === 'complete') mocks.runPipeline.mockResolvedValueOnce(artifacts());
    else if (terminal === 'failed') mocks.runPipeline.mockRejectedValueOnce(new Error('decode failed'));
    else mocks.runPipeline.mockImplementation((_file, _config, _progress, options: { signal: AbortSignal }) => (
      new Promise<PipelineArtifacts>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
    ));
    const host = createHost({ modelRuntime: { getSession, dispose: mocks.disposeAllModelSessions } as unknown as ModelRuntime });
    host.connect();
    sendImageJob(port, `gate-${terminal}`);
    await vi.waitFor(() => expect(mocks.runPipeline).toHaveBeenCalledOnce());
    if (terminal === 'cancel') port.emit({ type: 'cancel', jobId: 'gate-cancel', reason: 'cancel before detector' });
    await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ type: terminal === 'complete' ? 'complete' : 'error', jobId: `gate-${terminal}` })));
    host.dispose();
    await vi.waitFor(() => expect(mocks.disposeAllModelSessions).toHaveBeenCalledOnce());
    expect(getSession).toHaveBeenCalledOnce();
  });

  it.each(['webgpu', 'wasm', 'webnn'] as const)('closes an idle host without creating later sessions (%s)', async (provider) => {
    vi.stubGlobal('__shinobuColdStartEarlySessions', true);
    vi.stubGlobal('__shinobuColdStartSessionsAfterSubmit', true);
    vi.useFakeTimers();
    try {
      const getSession = vi.fn(async () => ({ sessionId: 'detector', provider, inputNames: [], outputNames: [] }));
      const host = createHost({ idleTimeoutMs: 1_000, modelRuntime: { getSession, dispose: mocks.disposeAllModelSessions } as unknown as ModelRuntime });
      host.connect();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.disposeAllModelSessions).toHaveBeenCalledOnce();
      expect(getSession).toHaveBeenCalledOnce();
      expect(port.sent).toContainEqual({ type: 'idle-close', hostInstanceId: 'pipeline-host-test' });
    } finally { vi.useRealTimers(); }
  });

  it.each([
    { provider: 'wasm' as const, afterSubmit: false },
    { provider: 'wasm' as const, afterSubmit: true },
    { provider: 'webnn' as const, afterSubmit: false },
    { provider: 'webnn' as const, afterSubmit: true },
  ])('loads later models only in the normal pipeline for $provider (afterSubmit=$afterSubmit)', async ({ provider, afterSubmit }) => {
    vi.stubGlobal('__shinobuColdStartEarlySessions', true);
    vi.stubGlobal('__shinobuColdStartSessionsAfterSubmit', afterSubmit);
    const getSession = vi.fn(async (name: string) => ({ sessionId: name, provider, inputNames: [], outputNames: [] }));
    const readModel = vi.fn();
    const host = createHost({ modelRuntime: {
      getSession, readModel, dispose: mocks.disposeAllModelSessions,
    } as unknown as ModelRuntime });
    await (host as unknown as { earlySessions: Promise<void> }).earlySessions;
    expect(getSession.mock.calls.map(([name]) => name)).toEqual(['detector']);
    expect(readModel).not.toHaveBeenCalled();
    mocks.runPipeline.mockImplementationOnce(async (_file, _config, _progress, options: { modelRuntime: ModelRuntime }) => {
      for (const model of ['bubble', 'paddleocr_v6_medium_rec', 'inpaint'] as const) {
        await options.modelRuntime.getSession(model);
      }
      return artifacts();
    });
    host.connect();
    sendImageJob(port, 'normal-cpu-stages');
    await vi.waitFor(() => expect(port.sent).toContainEqual({ type: 'complete', jobId: 'normal-cpu-stages' }));
    expect(getSession.mock.calls.map(([name]) => name)).toEqual(['detector', 'bubble', 'paddleocr_v6_medium_rec', 'inpaint']);
  });

  it('starts fonts and detector together and waits for fonts before delivering a result', async () => {
    vi.stubGlobal('__shinobuColdStartOverlap', true);
    const fonts = deferred<void>();
    const getSession = vi.fn(async () => ({ sessionId: 'detector', provider: 'webgpu' as const }));
    const platform = {
      registerFont: vi.fn(),
      waitForFonts: vi.fn(() => fonts.promise),
    } as unknown as PipelinePlatform;
    const output = artifacts();
    mocks.runPipeline.mockResolvedValueOnce(output);
    const host = createHost({
      modelRuntime: { getSession, dispose: mocks.disposeAllModelSessions } as unknown as ModelRuntime,
      platform,
      fontSource: (path) => `extension://${path}`,
    });
    expect(platform.registerFont).toHaveBeenCalledTimes(2);
    expect(getSession).toHaveBeenCalledWith('detector');
    host.connect();
    sendImageJob(port, 'fonts-overlap');
    await vi.waitFor(() => expect(mocks.runPipeline).toHaveBeenCalledOnce());
    expect(port.sent).not.toContainEqual({ type: 'complete', jobId: 'fonts-overlap' });
    fonts.resolve(undefined);
    await vi.waitFor(() => expect(port.sent).toContainEqual({ type: 'complete', jobId: 'fonts-overlap' }));
  });

  it.each([false, true])('selected fonts wait for config, support later language/debug requests and reuse registered faces (late=%s)', async (late) => {
    vi.stubGlobal('__shinobuColdStartOverlap', true);
    vi.stubGlobal('__shinobuColdStartFontsAfterDetect', late);
    vi.stubGlobal('__shinobuColdStartSelectedFonts', true);
    const registerFont = vi.fn();
    const platform = { registerFont, waitForFonts: vi.fn(async () => undefined) } as unknown as PipelinePlatform;
    mocks.runPipeline.mockImplementation(async (_file, _config, onProgress) => {
      onProgress({ stage: 'typeset', operation: 'render' });
      return artifacts();
    });
    const host = createHost({
      modelRuntime: {
        getSession: vi.fn(async () => ({ sessionId: 'detector', provider: 'webgpu' })),
        dispose: mocks.disposeAllModelSessions,
      } as unknown as ModelRuntime,
      platform, fontSource: (path) => `extension://${path}`,
    });
    expect(registerFont).not.toHaveBeenCalled(); // The target language is unknown in the constructor.
    host.connect();
    for (const [jobId, config, count] of [
      ['selected-cn', { targetLang: 'zh-CN' }, 1],
      ['selected-ja', { targetLang: 'ja' }, 1],
      ['selected-tw', { targetLang: 'zh-CHT' }, 2],
      ['selected-debug', { targetLang: 'zh-CHT', typesetDebug: true }, 4],
    ] as const) {
      sendImageJob(port, jobId, undefined, config);
      await vi.waitFor(() => expect(port.sent).toContainEqual({ type: 'complete', jobId }));
      expect(registerFont).toHaveBeenCalledTimes(count);
    }
    expect(registerFont.mock.calls.slice(0, 2).map((args) => args[1])).toEqual(['MTX-SourceHanSans-CN', 'MTX-SourceHanSans-TW']);
  });

  it.each(['typesetDebug', 'eraseDebug', 'collectDebugLog'] as const)('selected fonts retain both families before early debug rendering (%s)', async (flag) => {
    vi.stubGlobal('__shinobuColdStartOverlap', true);
    vi.stubGlobal('__shinobuColdStartFontsAfterDetect', true);
    vi.stubGlobal('__shinobuColdStartSelectedFonts', true);
    const fonts = deferred<void>();
    const platform = { registerFont: vi.fn(), waitForFonts: vi.fn(() => fonts.promise) } as unknown as PipelinePlatform;
    mocks.runPipeline.mockResolvedValueOnce(artifacts());
    const host = createHost({
      modelRuntime: {
        getSession: vi.fn(async () => ({ sessionId: 'detector', provider: 'webgpu' })),
        dispose: mocks.disposeAllModelSessions,
      } as unknown as ModelRuntime,
      platform, fontSource: (path) => `extension://${path}`,
    });
    host.connect();
    sendImageJob(port, 'selected-early-debug', undefined, { targetLang: 'zh-CHT', [flag]: true });
    await vi.waitFor(() => expect(platform.registerFont).toHaveBeenCalledTimes(2));
    expect(mocks.runPipeline).not.toHaveBeenCalled();
    fonts.resolve(undefined);
    await vi.waitFor(() => expect(port.sent).toContainEqual({ type: 'complete', jobId: 'selected-early-debug' }));
  });

  it.each([false, true])('reports a deferred font failure and releases produced canvases (late=%s)', async (late) => {
    vi.stubGlobal('__shinobuColdStartOverlap', true);
    vi.stubGlobal('__shinobuColdStartFontsAfterDetect', late);
    const output = artifacts();
    mocks.runPipeline.mockResolvedValueOnce(output);
    const host = createHost({
      modelRuntime: {
        getSession: vi.fn(async () => ({ sessionId: 'detector', provider: 'webgpu' })),
        dispose: mocks.disposeAllModelSessions,
      } as unknown as ModelRuntime,
      platform: {
        registerFont: vi.fn(),
        waitForFonts: vi.fn(async () => { throw new Error('font failed'); }),
      } as unknown as PipelinePlatform,
      fontSource: (path) => `extension://${path}`,
    });
    await Promise.resolve();
    host.connect();
    sendImageJob(port, 'fonts-fail');
    await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({
      type: 'error', jobId: 'fonts-fail',
      error: expect.objectContaining({ code: 'PIPELINE_EXECUTION_FAILED', stage: 'finalize' }),
    })));
    expect(output.resultCanvas.width).toBe(0);
    expect(output.resultCanvas.height).toBe(0);
    expect(port.sent).not.toContainEqual({ type: 'complete', jobId: 'fonts-fail' });
  });

  it.each(['bubble', 'typeset', 'none'])('starts late fonts before rendering or at finalization and waits before delivery (%s)', async (stage) => {
    vi.stubGlobal('__shinobuColdStartOverlap', true);
    vi.stubGlobal('__shinobuColdStartFontsAfterDetect', true);
    const fonts = deferred<void>();
    const platform = {
      registerFont: vi.fn(),
      waitForFonts: vi.fn(() => fonts.promise),
    } as unknown as PipelinePlatform;
    mocks.runPipeline.mockImplementationOnce(async (_file, _config, onProgress) => {
      expect(platform.registerFont).not.toHaveBeenCalled();
      onProgress({ stage: 'detect', detail: 'detect' });
      expect(platform.registerFont).not.toHaveBeenCalled();
      if (stage !== 'none') {
        onProgress({ stage, detail: stage });
        expect(platform.registerFont).toHaveBeenCalledTimes(2);
      }
      return artifacts();
    });
    const host = createHost({
      modelRuntime: {
        getSession: vi.fn(async () => ({ sessionId: 'detector', provider: 'webgpu' })),
        dispose: mocks.disposeAllModelSessions,
      } as unknown as ModelRuntime,
      platform,
      fontSource: (path) => `extension://${path}`,
    });
    expect(platform.registerFont).not.toHaveBeenCalled();
    host.connect();
    sendImageJob(port, 'late-fonts');
    await vi.waitFor(() => expect(platform.registerFont).toHaveBeenCalledTimes(2));
    expect(port.sent).not.toContainEqual({ type: 'complete', jobId: 'late-fonts' });
    fonts.resolve(undefined);
    await vi.waitFor(() => expect(port.sent).toContainEqual({ type: 'complete', jobId: 'late-fonts' }));
    expect(platform.registerFont).toHaveBeenCalledTimes(2);
  });

  it.each(['typesetDebug', 'eraseDebug', 'collectDebugLog'] as const)('waits for late fonts before any debug pipeline work (%s)', async (flag) => {
    vi.stubGlobal('__shinobuColdStartOverlap', true);
    vi.stubGlobal('__shinobuColdStartFontsAfterDetect', true);
    const fonts = deferred<void>();
    const platform = {
      registerFont: vi.fn(),
      waitForFonts: vi.fn(() => fonts.promise),
    } as unknown as PipelinePlatform;
    mocks.runPipeline.mockResolvedValueOnce(artifacts());
    const host = createHost({
      modelRuntime: {
        getSession: vi.fn(async () => ({ sessionId: 'detector', provider: 'webgpu' })),
        dispose: mocks.disposeAllModelSessions,
      } as unknown as ModelRuntime,
      platform,
      fontSource: (path) => `extension://${path}`,
    });
    host.connect();
    sendImageJob(port, 'debug-fonts', undefined, { [flag]: true });
    await vi.waitFor(() => expect(platform.registerFont).toHaveBeenCalledTimes(2));
    expect(mocks.runPipeline).not.toHaveBeenCalled();
    fonts.resolve(undefined);
    await vi.waitFor(() => expect(port.sent).toContainEqual({ type: 'complete', jobId: 'debug-fonts' }));
  });

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
      record: expect.objectContaining({
        schemaVersion: 2,
        workingCopy: expect.objectContaining({
          spec: { strategy: 'source-native' },
          sourceToWorkingCopy: { kind: 'identity' },
        }),
      }),
    }));
  });

  it('executes a detection-only job and returns the packed reusable artifact', async () => {
    mocks.blobToBase64.mockResolvedValueOnce('AQ==');
    mocks.probeTextDetection.mockResolvedValueOnce({
      detection: {
        width: 1,
        height: 2,
        packedMask: new Blob([Uint8Array.of(1)], { type: 'application/octet-stream' }),
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
    const host = createHost();
    host.connect();

    port.emit({ type: 'prepare', jobId: 'probe-1' });
    port.emit({
      type: 'start-detection-probe',
      jobId: 'probe-1',
      file: { name: 'probe.png', type: 'image/png', size: 1, lastModified: 1 },
      input: { chunkCount: 1, totalChars: 4 },
    });
    port.emit({ type: 'input-chunk', jobId: 'probe-1', index: 0, data: 'AQ==' });
    port.emit({ type: 'input-complete', jobId: 'probe-1' });

    await vi.waitFor(() => expect(port.sent).toContainEqual({
      type: 'complete',
      jobId: 'probe-1',
    }));
    expect(mocks.probeTextDetection).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({
        modelRuntime: expect.any(Object),
        platform: expect.any(Object),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(port.sent).toContainEqual({
      type: 'detection-result',
      jobId: 'probe-1',
      detection: {
        width: 1,
        height: 2,
        packedMaskBase64: 'AQ==',
        regions: expect.any(Array),
      },
      detectorSignature: 'detector-v1',
      topTouches: true,
      bottomTouches: true,
      topStrength: 16,
      bottomStrength: 15,
    });
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  it('injects a transmitted precomputed detection into a normal pipeline run', async () => {
    mocks.runPipeline.mockResolvedValueOnce(artifacts());
    const host = createHost();
    host.connect();
    sendImageJob(port, 'reuse-1', {
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
    });

    await vi.waitFor(() => expect(mocks.runPipeline).toHaveBeenCalledOnce());
    const options = mocks.runPipeline.mock.calls[0][3];
    expect(options.precomputedDetection).toEqual(expect.objectContaining({
      width: 1,
      height: 2,
      regions: expect.any(Array),
      packedMask: expect.any(Blob),
    }));
    expect(new Uint8Array(await options.precomputedDetection.packedMask.arrayBuffer())).toEqual(
      Uint8Array.of(1),
    );
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
      expect(port.sent).toContainEqual({
        type: 'idle-close',
        hostInstanceId: 'pipeline-host-test',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses an injected idle timeout and emits structured host lifecycle events', async () => {
    vi.useFakeTimers();
    try {
      const lifecycleEvents: Array<Record<string, unknown> | undefined> = [];
      const diagnostics = {
        emit: vi.fn((event: { data?: Record<string, unknown> }) => {
          lifecycleEvents.push(event.data);
        }),
        emitAsync: vi.fn(async (event: { data?: Record<string, unknown> }) => {
          lifecycleEvents.push(event.data);
          return true;
        }),
      };
      const host = createHost({ idleTimeoutMs: 1_000, diagnostics });
      host.connect();

      await vi.advanceTimersByTimeAsync(999);
      expect(mocks.disposeAllModelSessions).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(mocks.disposeAllModelSessions).toHaveBeenCalledOnce();
      expect(lifecycleEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          lifecycleEvent: 'host-created',
          hostInstanceId: 'pipeline-host-test',
        }),
        expect.objectContaining({
          lifecycleEvent: 'idle-dispose-complete',
          hostInstanceId: 'pipeline-host-test',
          idleTimeoutMs: 1_000,
        }),
        expect.objectContaining({
          lifecycleEvent: 'idle-close-requested',
          hostInstanceId: 'pipeline-host-test',
        }),
      ]));
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let diagnostic persistence block an idle close request', async () => {
    vi.useFakeTimers();
    try {
      const persisted = deferred<boolean>();
      const diagnostics = {
        emit: vi.fn(),
        emitAsync: vi.fn(() => persisted.promise),
      };
      const host = createHost({ idleTimeoutMs: 1_000, diagnostics });
      host.connect();

      await vi.advanceTimersByTimeAsync(1_000);

      expect(port.sent).toContainEqual({
        type: 'idle-close',
        hostInstanceId: 'pipeline-host-test',
      });
      persisted.resolve(true);
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

      expect(port.sent).toContainEqual({
        type: 'host-ready',
        hostInstanceId: 'pipeline-host-test',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
