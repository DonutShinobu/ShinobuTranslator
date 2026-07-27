import { describe, expect, it, vi } from 'vitest';
import { defaultExtensionSettings } from '../../../src/shared/config';
import { sendRuntimeMessage } from '../../../src/shared/messages';
import { createInitialPhotoState } from '../../../src/content/core/state/photoStateStore';
import { TranslationRunner } from '../../../src/content/core/translation/translationRunner';

type RuntimeSender = typeof sendRuntimeMessage;

describe('TranslationRunner', () => {
  it('resets a failed state without replacing its identity', () => {
    const state = createInitialPhotoState('https://example.com/image.jpg');
    state.status = 'error';
    state.errorText = 'failed';
    state.elapsedText = '1.0s';
    state.errorDetailCard = { title: 'detail', content: 'raw', expanded: true };
    const runner = new TranslationRunner();

    runner.resetStateForPipeline(state);

    expect(state).toMatchObject({
      status: 'running',
      mode: 'original',
      stageText: '准备中',
      errorText: '',
      elapsedText: '',
    });
    expect(state.errorDetailCard).toBeUndefined();
  });

  it('loads settings through the injected transport and updates debug state', async () => {
    const settings = {
      ...defaultExtensionSettings,
      showElapsedTime: true,
      showStageTimingDetails: true,
      stageTimingCardExpanded: true,
      showTypesetDebug: true,
      showEraseDebug: true,
      enableDebugLog: true,
    };
    const sendMessage = vi.fn(async () => ({
      ok: true as const,
      type: 'mt:get-settings' as const,
      settings,
    })) as unknown as RuntimeSender;
    const runner = new TranslationRunner({ sendMessage });
    const state = createInitialPhotoState('https://example.com/image.jpg');

    await expect(runner.loadPipelineRunSettings(state)).resolves.toEqual({
      settings,
      showElapsedTime: true,
      showStageTimingDetails: true,
      showRuntimeStages: true,
      stageTimingCardExpanded: true,
      showTypesetDebug: true,
      enableDebugLog: true,
    });
    expect(state.showTypesetDebug).toBe(true);
    expect(state.showEraseDebug).toBe(true);
  });

  it('preserves download response fields and external errors', async () => {
    const successSender = vi.fn(async () => ({
      ok: true as const,
      type: 'mt:download-image' as const,
      base64: 'AQID',
      contentType: 'image/png',
      sourceUrl: 'https://example.com/source.png',
    })) as unknown as RuntimeSender;
    const successRunner = new TranslationRunner({ sendMessage: successSender });

    const source = await successRunner.downloadImageFile({
      originalUrl: 'https://example.com/image.png',
      referrerPolicy: 'strict-origin-when-cross-origin',
    });
    expect(source.blob.type).toBe('image/png');
    expect(source.blob.size).toBe(3);
    expect(source.file.name).toBe('source.png');
    expect(successSender).toHaveBeenCalledWith({
      type: 'mt:download-image',
      imageUrl: 'https://example.com/image.png',
      referrerPolicy: 'strict-origin-when-cross-origin',
    });

    const failureSender = vi.fn(async () => ({
      ok: false as const,
      type: 'mt:download-image' as const,
      error: 'upstream failed',
    })) as unknown as RuntimeSender;
    const failureRunner = new TranslationRunner({ sendMessage: failureSender });
    await expect(failureRunner.downloadImageFile({
      originalUrl: 'https://example.com/image.png',
    })).rejects.toThrow('upstream failed');
  });

  it('runs the production local pipeline through the injected offscreen client', async () => {
    const resultBlob = new Blob(['translated'], { type: 'image/png' });
    const runLocalPipeline = vi.fn(async (_file, _config, onProgress) => {
      onProgress({ stage: 'detect', detail: '文本检测' });
      return {
        result: resultBlob,
        summary: {
          image: { width: 100, height: 200 },
          detectedRegionCount: 2,
          stageTimings: [{ stage: 'detect', label: '文本检测', durationMs: 10 }],
          runtimeStages: [
            { model: 'detector' as const, enabled: true, engine: 'onnx' as const, provider: 'wasm' as const, detail: 'ok' },
            { model: 'bubble' as const, enabled: true, provider: 'wasm' as const, detail: 'ok' },
            { model: 'ocr' as const, enabled: true, provider: 'wasm' as const, detail: 'ok' },
            { model: 'inpaint' as const, enabled: true, provider: 'wasm' as const, detail: 'ok' },
          ],
          translationDebug: null,
          ocrDebug: null,
          ocrPostFilterDebug: null,
          typesetDebug: null,
        },
      };
    });
    const createObjectURL = vi.fn(() => 'blob:translated');
    const revokeObjectURL = vi.fn();
    const runner = new TranslationRunner({
      runLocalPipeline,
      urlApi: { createObjectURL, revokeObjectURL },
    });
    const state = createInitialPhotoState('https://example.com/image.png');
    const settings = { ...defaultExtensionSettings, processMode: 'original' as const };

    await runner.runPipelineFromFile({
      state,
      file: new File([new Uint8Array([1])], 'source.png', { type: 'image/png' }),
      runSettings: {
        settings,
        showElapsedTime: true,
        showStageTimingDetails: true,
        showRuntimeStages: true,
        stageTimingCardExpanded: false,
        showTypesetDebug: false,
        enableDebugLog: false,
      },
      runStartAt: performance.now(),
      includeElapsedText: true,
      onProgress: vi.fn(),
    });

    expect(runLocalPipeline).toHaveBeenCalledTimes(1);
    expect(createObjectURL).toHaveBeenCalledWith(resultBlob);
    expect(state).toMatchObject({
      status: 'translated',
      mode: 'translated',
      translatedUrl: 'blob:translated',
      stageText: '',
    });
    expect(state.stageTimingCard?.runtimes.map((runtime) => runtime.model)).toEqual([
      'detector', 'bubble', 'ocr', 'inpaint',
    ]);
  });
});
