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

    const source = await successRunner.downloadImageFile('https://example.com/image.png');
    expect(source.blob.type).toBe('image/png');
    expect(source.blob.size).toBe(3);
    expect(source.file.name).toBe('source.png');

    const failureSender = vi.fn(async () => ({
      ok: false as const,
      type: 'mt:download-image' as const,
      error: 'upstream failed',
    })) as unknown as RuntimeSender;
    const failureRunner = new TranslationRunner({ sendMessage: failureSender });
    await expect(failureRunner.downloadImageFile('https://example.com/image.png')).rejects.toThrow('upstream failed');
  });
});
