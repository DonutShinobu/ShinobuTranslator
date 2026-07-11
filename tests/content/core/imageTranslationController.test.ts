import { describe, expect, it, vi } from 'vitest';
import { defaultExtensionSettings } from '../../../src/shared/config';
import type { ImageTarget } from '../../../src/content/core/types';
import type { ProgressJankMonitor } from '../../../src/content/core/progressJank';
import { PhotoStateStore } from '../../../src/content/core/state/photoStateStore';
import { TranslationRunner } from '../../../src/content/core/translation/translationRunner';
import {
  ImageTranslationController,
  type ImageTranslationRuntime,
} from '../../../src/content/core/translation/imageTranslationController';

function createHarness() {
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

  it('applies a successful result produced by the runner', async () => {
    const harness = createHarness();
    vi.spyOn(harness.runner, 'loadPipelineRunSettings').mockResolvedValue({
      settings: defaultExtensionSettings,
      showElapsedTime: false,
      showStageTimingDetails: false,
      showRuntimeStages: false,
      stageTimingCardExpanded: false,
      showTypesetDebug: false,
      enableDebugLog: false,
    });
    vi.spyOn(harness.runner, 'downloadImageFile').mockResolvedValue({
      file: new File([new Uint8Array([1])], 'source.png', { type: 'image/png' }),
      blob: new Blob([new Uint8Array([1])], { type: 'image/png' }),
    });
    vi.spyOn(harness.runner, 'runPipelineFromFile').mockImplementation(async ({ state }) => {
      state.translatedUrl = 'blob:translated';
      state.mode = 'translated';
      state.status = 'translated';
    });

    await harness.controller.handleTranslateClick(harness.target);

    expect(harness.store.get(harness.target.key)?.status).toBe('translated');
    expect(harness.applyImage).toHaveBeenCalledOnce();
  });
});
