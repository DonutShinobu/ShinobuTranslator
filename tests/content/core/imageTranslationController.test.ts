import { describe, expect, it, vi } from 'vitest';
import { defaultExtensionSettings } from '../../../src/shared/config';
import type {
  ImageTarget,
  ImageTranslationContextResolution,
} from '../../../src/content/core/types';
import { ProgressJankMonitor } from '../../../src/content/core/progressJank';
import { PhotoStateStore } from '../../../src/content/core/state/photoStateStore';
import type { RunLocalPipeline } from '../../../src/content/core/translation/localPipelineClient';
import { TranslationRunner } from '../../../src/content/core/translation/translationRunner';
import { sendRuntimeMessage } from '../../../src/shared/messages';
import {
  ImageTranslationController,
  type ImageTranslationRuntime,
} from '../../../src/content/core/translation/imageTranslationController';

function createHarness(
  resolveTranslationContext?: (target: ImageTarget) => ImageTranslationContextResolution,
) {
  const store = new PhotoStateStore(200, { revokeObjectURL: vi.fn() });
  const runner = new TranslationRunner();
  const applyImage = vi.fn();
  const render = vi.fn();
  const monitor = {
    measureUiRender(callback: () => void) {
      callback();
    },
  } as unknown as ProgressJankMonitor;
  const runtime: ImageTranslationRuntime = {
    createJankMonitor: vi.fn(() => monitor),
    finishJankMonitor: vi.fn(),
    createRunId: vi.fn(() => 'run-test'),
    now: vi.fn(() => 100),
  };
  const controller = new ImageTranslationController(
    store,
    runner,
    {
      resolveTarget: () => undefined,
      resolveTranslationContext,
      applyImage,
      render,
    },
    runtime,
  );
  const target: ImageTarget = {
    element: {} as HTMLImageElement,
    key: 'image-1',
    originalUrl: 'https://example.com/image.jpg',
  };
  return { store, runner, applyImage, render, runtime, controller, target };
}

describe('ImageTranslationController', () => {
  it('ignores duplicate clicks while running', async () => {
    const harness = createHarness();
    harness.store.ensure(harness.target.key, harness.target.originalUrl).status = 'running';
    const loadSettings = vi.spyOn(harness.runner, 'loadPipelineRunSettings');

    await harness.controller.handleTranslateClick(harness.target);

    expect(loadSettings).not.toHaveBeenCalled();
    expect(harness.runtime.createJankMonitor).not.toHaveBeenCalled();
    expect(harness.render).not.toHaveBeenCalled();
  });

  it('toggles an existing translation without rerunning the pipeline', async () => {
    const harness = createHarness();
    const state = harness.store.ensure(harness.target.key, harness.target.originalUrl);
    state.translatedUrl = 'blob:translated';
    state.status = 'translated';
    state.mode = 'translated';
    const loadSettings = vi.spyOn(harness.runner, 'loadPipelineRunSettings');

    await harness.controller.handleTranslateClick(harness.target);

    expect(state.status).toBe('showingOriginal');
    expect(state.mode).toBe('original');
    expect(loadSettings).not.toHaveBeenCalled();
    expect(harness.applyImage).toHaveBeenCalledWith(harness.target, state);
    expect(harness.render).toHaveBeenCalledWith(harness.target.key);
  });

  it('restores an actionable error state when a run fails', async () => {
    const harness = createHarness();
    vi.spyOn(harness.runner, 'loadPipelineRunSettings').mockRejectedValue(new Error('provider failed'));

    await harness.controller.handleTranslateClick(harness.target);

    const state = harness.store.get(harness.target.key);
    expect(state).toMatchObject({
      status: 'error',
      errorText: 'provider failed',
      stageText: '',
    });
    expect(harness.runtime.finishJankMonitor).toHaveBeenCalledOnce();
    expect(harness.render).toHaveBeenLastCalledWith(harness.target.key);
  });

  it('captures tweet context synchronously when the click starts', async () => {
    const resolveTranslationContext = vi.fn(() => ({ status: 'empty' as const }));
    const harness = createHarness(resolveTranslationContext);
    let rejectSettings!: (reason: Error) => void;
    vi.spyOn(harness.runner, 'loadPipelineRunSettings').mockImplementation(() => (
      new Promise((_resolve, reject) => {
        rejectSettings = reject;
      })
    ));

    const click = harness.controller.handleTranslateClick(harness.target);

    expect(resolveTranslationContext).toHaveBeenCalledWith(harness.target);
    rejectSettings(new Error('stop after capture'));
    await click;
  });

  it('applies a successful result produced by the runner', async () => {
    const harness = createHarness();
    harness.target.element = {
      referrerPolicy: 'origin',
    } as HTMLImageElement;
    vi.spyOn(harness.runner, 'loadPipelineRunSettings').mockResolvedValue({
      settings: defaultExtensionSettings,
      showElapsedTime: false,
      showStageTimingDetails: false,
      showRuntimeStages: false,
      stageTimingCardExpanded: false,
      showTypesetDebug: false,
      enableDebugLog: false,
    });
    const downloadImageFile = vi.spyOn(harness.runner, 'downloadImageFile').mockResolvedValue({
      file: new File([new Uint8Array([1])], 'source.png', { type: 'image/png' }),
      blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
    });
    vi.spyOn(harness.runner, 'runPipelineFromFile').mockImplementation(async ({ state }) => {
      state.translatedUrl = 'blob:translated';
      state.mode = 'translated';
      state.status = 'translated';
      return { translationDebug: null };
    });

    await harness.controller.handleTranslateClick(harness.target);

    expect(harness.store.get(harness.target.key)?.status).toBe('translated');
    expect(downloadImageFile).toHaveBeenCalledWith({
      originalUrl: harness.target.originalUrl,
      referrerPolicy: 'origin',
      diagnosticRunId: undefined,
    });
    expect(harness.applyImage).toHaveBeenCalledOnce();
  });

  it('passes captured tweet context into the local LLM pipeline', async () => {
    const settings = {
      ...defaultExtensionSettings,
      translator: 'llm' as const,
      llmProfiles: {
        ...defaultExtensionSettings.llmProfiles,
        deepseek: {
          ...defaultExtensionSettings.llmProfiles.deepseek,
          apiKey: 'sk-test',
        },
      },
    };
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'mt:get-settings') {
        return {
          ok: true as const,
          type: 'mt:get-settings' as const,
          settings,
        };
      }
      if (message.type === 'mt:download-image') {
        return {
          ok: true as const,
          type: 'mt:download-image' as const,
          base64: 'AQ==',
          contentType: 'image/png',
          sourceUrl: 'https://example.com/source.png',
        };
      }
      throw new Error(`unexpected message: ${message.type}`);
    }) as unknown as typeof sendRuntimeMessage;
    const runLocalPipelineMock = vi.fn(async (
      _file: File,
      _config: Parameters<RunLocalPipeline>[1],
    ) => ({
      result: new Blob(['translated'], { type: 'image/png' }),
      summary: {
        image: { width: 100, height: 200 },
        detectedRegionCount: 1,
        stageTimings: [],
        runtimeStages: [],
        translationDebug: {
          llmBatchRequestedRegionCount: 1,
        },
        ocrDebug: null,
        typesetDebug: null,
      },
    }));
    const runLocalPipeline = runLocalPipelineMock as unknown as RunLocalPipeline;
    const runner = new TranslationRunner({
      sendMessage,
      runLocalPipeline,
      urlApi: {
        createObjectURL: vi.fn(() => 'blob:translated'),
        revokeObjectURL: vi.fn(),
      },
    });
    const store = new PhotoStateStore(200, { revokeObjectURL: vi.fn() });
    const target: ImageTarget = {
      element: {} as HTMLImageElement,
      key: 'status:123::image-1',
      originalUrl: 'https://example.com/image.jpg',
    };
    const context = {
      source: 'x_tweet' as const,
      currentTweetText: '当前推文正文',
      quotedTweetText: '引用推文正文',
    };
    const monitor = new ProgressJankMonitor('image');
    const controller = new ImageTranslationController(
      store,
      runner,
      {
        resolveTarget: () => target,
        resolveTranslationContext: () => ({
          status: 'available',
          context,
        }),
        applyImage: vi.fn(),
        render: vi.fn(),
      },
      {
        createJankMonitor: () => monitor,
        finishJankMonitor: vi.fn(),
        createRunId: () => 'run-test',
        now: () => performance.now(),
      },
    );

    await controller.handleTranslateClick(target);

    expect(runLocalPipelineMock).toHaveBeenCalledOnce();
    expect(runLocalPipelineMock.mock.calls[0][1]).toMatchObject({
      translationContext: context,
    });
  });

  it.each([
    {
      name: 'missing tweet context',
      contextResolution: { status: 'unavailable' } as const,
      translationDebug: {
        llmBatchRequestedRegionCount: 1,
      },
      expectedNotice: '未找到推文作为上下文',
    },
    {
      name: 'tweet context length fallback',
      contextResolution: {
        status: 'available',
        context: {
          source: 'x_tweet',
          currentTweetText: '当前推文正文',
        },
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
      translationDebug: {
        llmBatchRequestedRegionCount: 1,
      },
      expectedNotice: '未找到推文作为上下文',
    },
  ])('stores a non-blocking notice after successful LLM translation with $name', async ({
    contextResolution,
    translationDebug,
    expectedNotice,
  }) => {
    const settings = {
      ...defaultExtensionSettings,
      translator: 'llm' as const,
      llmProfiles: {
        ...defaultExtensionSettings.llmProfiles,
        deepseek: {
          ...defaultExtensionSettings.llmProfiles.deepseek,
          apiKey: 'sk-test',
        },
      },
    };
    const sendMessage = vi.fn(async (message: { type: string }) => {
      if (message.type === 'mt:get-settings') {
        return {
          ok: true as const,
          type: 'mt:get-settings' as const,
          settings,
        };
      }
      if (message.type === 'mt:download-image') {
        return {
          ok: true as const,
          type: 'mt:download-image' as const,
          base64: 'AQ==',
          contentType: 'image/png',
          sourceUrl: 'https://example.com/source.png',
        };
      }
      throw new Error(`unexpected message: ${message.type}`);
    }) as unknown as typeof sendRuntimeMessage;
    const runLocalPipeline = vi.fn(async () => ({
      result: new Blob(['translated'], { type: 'image/png' }),
      summary: {
        image: { width: 100, height: 200 },
        detectedRegionCount: 1,
        stageTimings: [],
        runtimeStages: [],
        translationDebug,
        ocrDebug: null,
        typesetDebug: null,
      },
    })) as unknown as RunLocalPipeline;
    const runner = new TranslationRunner({
      sendMessage,
      runLocalPipeline,
      urlApi: {
        createObjectURL: vi.fn(() => 'blob:translated'),
        revokeObjectURL: vi.fn(),
      },
    });
    const store = new PhotoStateStore(200, { revokeObjectURL: vi.fn() });
    const target: ImageTarget = {
      element: {} as HTMLImageElement,
      key: 'status:123::image-1',
      originalUrl: 'https://example.com/image.jpg',
    };
    const controller = new ImageTranslationController(
      store,
      runner,
      {
        resolveTarget: () => target,
        resolveTranslationContext: () => {
          if (contextResolution instanceof Error) {
            throw contextResolution;
          }
          return contextResolution;
        },
        applyImage: vi.fn(),
        render: vi.fn(),
      },
      {
        createJankMonitor: () => new ProgressJankMonitor('image'),
        finishJankMonitor: vi.fn(),
        createRunId: () => 'run-test',
        now: () => performance.now(),
      },
    );

    await controller.handleTranslateClick(target);

    expect(store.get(target.key)).toMatchObject({
      status: 'translated',
      contextNoticeText: expectedNotice,
    });
  });
});
