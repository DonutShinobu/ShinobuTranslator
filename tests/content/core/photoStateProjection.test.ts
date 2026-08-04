import { describe, expect, it, vi } from 'vitest';
import { createInitialPhotoState } from '../../../apps/extension/src/content/core/state/photoStateStore';
import {
  applyImageTranslationProgress,
  applyImageTranslationFailure,
  applyImageTranslationResult,
  resetPhotoStateForImageTranslation,
  startPhotoStateImageTranslation,
} from '../../../apps/extension/src/content/core/translation/photoStateProjection';
import type { LocalPipelineImageTranslationResult } from '../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import { WholeImageTranslationError } from '../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import { createImageTranslationExecutionModule } from '../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import { defaultExtensionSettings } from '../../../apps/extension/src/shared/config';
import type { ProgressJankMonitor } from '../../../apps/extension/src/content/core/progressJank';

function localExecutionResult(): LocalPipelineImageTranslationResult {
  return {
    kind: 'local-pipeline',
    status: 'completed',
    image: new Blob(['translated'], { type: 'image/png' }),
    debug: new Blob(['debug'], { type: 'image/png' }),
    source: {
      file: new File(['source'], 'source.png', { type: 'image/png' }),
      blob: new Blob(['source'], { type: 'image/png' }),
    },
    elapsedMs: 25,
    display: {
      showElapsedTime: true,
      showStageTimingDetails: true,
      showRuntimeStages: true,
      stageTimingCardExpanded: false,
      showTypesetDebug: true,
      showEraseDebug: true,
    },
    summary: {
      image: { width: 100, height: 200 },
      detectedRegionCount: 1,
      stageTimings: [{ stage: 'detect', label: '文本检测', durationMs: 10 }],
      runtimeStages: [],
      translationDebug: null,
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

describe('photo state projection', () => {
  it('projects execution progress and result without exposing PhotoState to execution', () => {
    const state = createInitialPhotoState('https://example.com/source.png');
    state.status = 'error';
    state.errorText = 'failed';
    state.translatedUrl = 'blob:previous';
    const createObjectURL = vi
      .fn()
      .mockReturnValueOnce('blob:translated')
      .mockReturnValueOnce('blob:debug');
    const revokeObjectURL = vi.fn();

    resetPhotoStateForImageTranslation(state);
    applyImageTranslationProgress(state, {
      phase: 'executing',
      execution: {
        kind: 'local-pipeline',
        progress: {
          stage: 'detect',
          operation: 'detect-text',
          detail: '文本检测',
        },
      },
    });
    expect(state.stageText).toBe('文本检测中');

    const outcome = applyImageTranslationResult(state, localExecutionResult(), {
      includeElapsedText: true,
      urlApi: { createObjectURL, revokeObjectURL },
    });

    expect(outcome.translationDebug).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:previous');
    expect(state).toMatchObject({
      status: 'translated',
      mode: 'translated',
      translatedUrl: 'blob:translated',
      debugOriginalUrl: 'blob:debug',
      showTypesetDebug: true,
      showEraseDebug: true,
      stageText: '',
      errorText: '',
    });
    expect(state.stageTimingCard?.stages[0]?.stage).toBe('detect');
  });

  it('projects whole-image provider details without leaking them into PhotoState', () => {
    const state = createInitialPhotoState('https://example.com/source.png');

    applyImageTranslationFailure(
      state,
      new WholeImageTranslationError('generation failed', {
        title: 'Gemini reply',
        content: 'policy blocked',
      }),
    );

    expect(state).toMatchObject({
      status: 'error',
      errorText: 'generation failed',
      errorDetailCard: {
        title: 'Gemini reply',
        content: 'policy blocked',
        expanded: false,
      },
    });
  });

  it('returns a cancelled projection to an idle, retryable state', async () => {
    const state = createInitialPhotoState('https://example.com/source.png');
    const module = createImageTranslationExecutionModule({
      loadSettings: async () => ({ ...defaultExtensionSettings }),
      runLocalPipeline: () => new Promise(() => undefined),
    });
    const task = startPhotoStateImageTranslation({
      executionModule: module,
      request: {
        source: {
          kind: 'prepared-file',
          file: new File(['source'], 'source.png', { type: 'image/png' }),
        },
      },
      state,
      includeElapsedText: false,
    });
    await Promise.resolve();

    task.cancel('closed');

    await expect(task.result).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    expect(state).toMatchObject({
      status: 'idle',
      stageText: '',
      errorText: '',
    });
  });

  it('uses the execution diagnostic run id when a projected task fails', async () => {
    const state = createInitialPhotoState('https://example.com/source.png');
    const monitor = {} as ProgressJankMonitor;
    const finishJankMonitor = vi.fn();
    const module = createImageTranslationExecutionModule({
      loadSettings: async () => ({
        ...defaultExtensionSettings,
        enableDebugLog: true,
      }),
      createDiagnosticRunId: () => 'run-test',
      runLocalPipeline: async () => {
        throw new Error('pipeline failed');
      },
    });
    const task = startPhotoStateImageTranslation({
      executionModule: module,
      request: {
        source: {
          kind: 'prepared-file',
          file: new File(['source'], 'source.png', { type: 'image/png' }),
        },
      },
      state,
      includeElapsedText: false,
      jankMonitor: monitor,
      finishJankMonitor,
    });

    await expect(task.result).rejects.toMatchObject({ diagnosticRunId: 'run-test' });
    expect(finishJankMonitor).toHaveBeenCalledWith(monitor, 'run-test');
  });
});
