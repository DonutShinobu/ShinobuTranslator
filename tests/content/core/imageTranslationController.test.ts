import { describe, expect, it, vi } from 'vitest';
import type { PipelineConfig } from '@shinobu/image-pipeline';
import type { LocalPipelineResult } from '@shinobu/image-pipeline/protocol';
import { defaultExtensionSettings } from '../../../apps/extension/src/shared/config';
import type {
  ImageTarget,
  ImageTranslationContextResolution,
} from '../../../apps/extension/src/content/core/types';
import { PhotoStateStore } from '../../../apps/extension/src/content/core/state/photoStateStore';
import {
  createImageTranslationExecutionModule,
  type ImageTranslationExecutionDependencies,
} from '../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import {
  ImageTranslationController,
} from '../../../apps/extension/src/content/core/translation/imageTranslationController';
import type { ProgressJankMonitor } from '../../../apps/extension/src/content/core/progressJank';

function localResult(translationDebug: LocalPipelineResult['summary']['translationDebug'] = null): LocalPipelineResult {
  return {
    status: 'completed',
    result: new Blob(['translated'], { type: 'image/png' }),
    summary: {
      image: { width: 100, height: 200 },
      detectedRegionCount: 1,
      stageTimings: [],
      runtimeStages: [],
      translationDebug,
      ocrDebug: null,
      ocrPostFilterDebug: null,
      typesetDebug: null,
    },
    record: {
      schemaVersion: 2,
      workingCopy: {
        width: 100,
        height: 200,
        spec: { strategy: 'source-native' },
        sourceToWorkingCopy: { kind: 'identity' },
      },
      ocr: [],
      translations: [],
    },
  };
}

function createHarness(options: {
  resolveTranslationContext?: (target: ImageTarget) => ImageTranslationContextResolution;
  dependencies?: ImageTranslationExecutionDependencies;
} = {}) {
  const store = new PhotoStateStore(200, { revokeObjectURL: vi.fn() });
  const sourceBlob = new Blob(['source'], { type: 'image/png' });
  const downloadImage = vi.fn(async () => ({
    file: new File([sourceBlob], 'source.png', { type: sourceBlob.type }),
    blob: sourceBlob,
  }));
  const runLocalPipeline = vi.fn(async () => localResult());
  const executionModule = createImageTranslationExecutionModule({
    loadSettings: async () => ({ ...defaultExtensionSettings }),
    downloadImage,
    runLocalPipeline,
    ...options.dependencies,
  });
  const applyImage = vi.fn();
  const render = vi.fn();
  const monitor = {
    measureUiRender(callback: () => void) {
      callback();
    },
    setStage() {},
  } as unknown as ProgressJankMonitor;
  const controller = new ImageTranslationController(
    store,
    executionModule,
    {
      resolveTarget: () => undefined,
      resolveTranslationContext: options.resolveTranslationContext,
      applyImage,
      render,
    },
    {
      createJankMonitor: () => monitor,
      finishJankMonitor: vi.fn(),
    },
  );
  const target: ImageTarget = {
    element: {} as HTMLImageElement,
    key: 'image-1',
    originalUrl: 'https://example.com/image.jpg',
  };
  return {
    store,
    executionModule,
    downloadImage,
    runLocalPipeline,
    applyImage,
    render,
    controller,
    target,
  };
}

describe('ImageTranslationController', () => {
  it('ignores duplicate clicks while running', async () => {
    const harness = createHarness();
    harness.store.ensure(harness.target.key, harness.target.originalUrl).status = 'running';
    const start = vi.spyOn(harness.executionModule, 'start');

    await harness.controller.handleTranslateClick(harness.target);

    expect(start).not.toHaveBeenCalled();
    expect(harness.render).not.toHaveBeenCalled();
  });

  it('toggles an existing translation without starting another task', async () => {
    const harness = createHarness();
    const state = harness.store.ensure(harness.target.key, harness.target.originalUrl);
    state.translatedUrl = 'blob:translated';
    state.status = 'translated';
    state.mode = 'translated';
    const start = vi.spyOn(harness.executionModule, 'start');

    await harness.controller.handleTranslateClick(harness.target);

    expect(state).toMatchObject({ status: 'showingOriginal', mode: 'original' });
    expect(start).not.toHaveBeenCalled();
    expect(harness.applyImage).toHaveBeenCalledWith(harness.target, state);
  });

  it('projects a settings failure into an actionable error state', async () => {
    const harness = createHarness({
      dependencies: {
        loadSettings: async () => {
          throw new Error('provider failed');
        },
      },
    });

    await harness.controller.handleTranslateClick(harness.target);

    expect(harness.store.get(harness.target.key)).toMatchObject({
      status: 'error',
      errorText: 'provider failed',
      stageText: '',
    });
    expect(harness.render).toHaveBeenCalled();
  });

  it('captures tweet context synchronously when the click starts', async () => {
    const resolveTranslationContext = vi.fn(() => ({ status: 'empty' as const }));
    let rejectSettings!: (reason: Error) => void;
    const harness = createHarness({
      resolveTranslationContext,
      dependencies: {
        loadSettings: () => new Promise((_resolve, reject) => {
          rejectSettings = reject;
        }),
      },
    });

    const click = harness.controller.handleTranslateClick(harness.target);

    expect(resolveTranslationContext).toHaveBeenCalledWith(harness.target);
    await Promise.resolve();
    rejectSettings(new Error('stop after capture'));
    await click;
  });

  it('starts a remote-image task with the element referrer policy', async () => {
    const harness = createHarness();
    harness.target.element = { referrerPolicy: 'origin' } as HTMLImageElement;

    await harness.controller.handleTranslateClick(harness.target);

    expect(harness.downloadImage).toHaveBeenCalledWith(
      {
        kind: 'remote-image',
        url: harness.target.originalUrl,
        referrerPolicy: 'origin',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(harness.store.get(harness.target.key)?.status).toBe('translated');
    expect(harness.applyImage).toHaveBeenCalledOnce();
  });

  it('cancels its active task when the execution owner is disposed', async () => {
    let pipelineSignal: AbortSignal | undefined;
    const harness = createHarness({
      dependencies: {
        runLocalPipeline: (_file, _config, _onProgress, options) => {
          pipelineSignal = options?.signal;
          return new Promise(() => undefined);
        },
      },
    });
    const click = harness.controller.handleTranslateClick(harness.target);
    await vi.waitFor(() => expect(pipelineSignal).toBeDefined());

    harness.controller.dispose();
    await click;

    expect(pipelineSignal?.aborted).toBe(true);
    expect(harness.store.get(harness.target.key)).toMatchObject({
      status: 'idle',
      errorText: '',
    });
  });

  it('passes captured tweet context into the local LLM pipeline', async () => {
    const context = {
      source: 'x_tweet' as const,
      currentTweetText: '当前推文正文',
      quotedTweetText: '引用推文正文',
    };
    let receivedConfig: PipelineConfig | undefined;
    const harness = createHarness({
      resolveTranslationContext: () => ({ status: 'available', context }),
      dependencies: {
        loadSettings: async () => ({
          ...defaultExtensionSettings,
          translator: 'llm',
          llmProfiles: {
            ...defaultExtensionSettings.llmProfiles,
            deepseek: {
              ...defaultExtensionSettings.llmProfiles.deepseek,
              apiKey: 'sk-test',
            },
          },
        }),
        runLocalPipeline: async (_file, config) => {
          receivedConfig = config;
          return localResult({ llmBatchRequestedRegionCount: 1 });
        },
      },
    });

    await harness.controller.handleTranslateClick(harness.target);

    expect(receivedConfig).toMatchObject({ translationContext: context });
  });

  it.each([
    {
      name: 'missing tweet context',
      contextResolution: { status: 'unavailable' } as const,
      translationDebug: { llmBatchRequestedRegionCount: 1 },
      expectedNotice: '未找到推文作为上下文',
    },
    {
      name: 'tweet context length fallback',
      contextResolution: {
        status: 'available',
        context: { source: 'x_tweet', currentTweetText: '当前推文正文' },
      } as const,
      translationDebug: {
        llmBatchRequestedRegionCount: 1,
        tweetContextLengthFallback: true,
      },
      expectedNotice: '推文上下文过长，已改为无上下文翻译',
    },
    {
      name: 'tweet DOM extraction failure',
      contextResolution: new Error('tweet DOM changed'),
      translationDebug: { llmBatchRequestedRegionCount: 1 },
      expectedNotice: '未找到推文作为上下文',
    },
  ])('stores a non-blocking notice after successful LLM translation with $name', async ({
    contextResolution,
    translationDebug,
    expectedNotice,
  }) => {
    const harness = createHarness({
      resolveTranslationContext: () => {
        if (contextResolution instanceof Error) throw contextResolution;
        return contextResolution;
      },
      dependencies: {
        loadSettings: async () => ({
          ...defaultExtensionSettings,
          translator: 'llm',
          llmProfiles: {
            ...defaultExtensionSettings.llmProfiles,
            deepseek: {
              ...defaultExtensionSettings.llmProfiles.deepseek,
              apiKey: 'sk-test',
            },
          },
        }),
        runLocalPipeline: async () => localResult(translationDebug),
      },
    });

    await harness.controller.handleTranslateClick(harness.target);

    expect(harness.store.get(harness.target.key)).toMatchObject({
      status: 'translated',
      contextNoticeText: expectedNotice,
    });
  });
});
