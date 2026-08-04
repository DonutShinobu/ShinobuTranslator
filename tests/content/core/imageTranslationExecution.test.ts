import { describe, expect, it } from 'vitest';
import {
  buildGeminiImagePrompt,
  defaultExtensionSettings,
  getGeminiAppModelLabel,
  resolveGeminiApiImageModel,
  resolveLlmBaseUrl,
  toPipelineConfig,
  usesGeminiApiImagePipeline,
  usesNanoBananaImagePipeline,
  type ExtensionSettings,
} from '../../../apps/extension/src/shared/config';
import { sendRuntimeMessage } from '../../../apps/extension/src/shared/messages';
import { sanitizeExtensionSettings } from '../../../apps/extension/src/shared/diagnosticSettings';
import type { ExtensionExecutionSnapshot } from '../../../apps/extension/src/shared/extensionControl';
import {
  createImageTranslationExecutionModule,
  ImageTranslationExecutionKindNotAllowedError,
  type ImageTranslationExecutionProgress,
} from '../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import type { PipelineProgress } from '@shinobu/image-pipeline';
import type { LocalPipelineResult } from '@shinobu/image-pipeline/protocol';

function completedLocalResult(image: Blob): LocalPipelineResult {
  return {
    status: 'completed',
    result: image,
    summary: {
      image: { width: 100, height: 200 },
      detectedRegionCount: 2,
      stageTimings: [],
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

function executionSnapshot(
  settings: ExtensionSettings = defaultExtensionSettings,
): ExtensionExecutionSnapshot {
  const wholeImage = usesNanoBananaImagePipeline(settings);
  const wholeImagePreparation: import('../../../apps/extension/src/shared/extensionControl').WholeImageExecutionPreparation | undefined = wholeImage
    ? usesGeminiApiImagePipeline(settings)
      ? {
          provider: 'gemini-api',
          model: resolveGeminiApiImageModel(settings.geminiAppModel),
          modelLabel: `Nano Banana API / ${getGeminiAppModelLabel(settings.geminiAppModel)}`,
          prompt: buildGeminiImagePrompt(settings),
          baseUrl: resolveLlmBaseUrl(settings),
        }
      : {
          provider: 'gemini-app',
          model: settings.geminiAppModel,
          modelLabel: getGeminiAppModelLabel(settings.geminiAppModel),
          prompt: buildGeminiImagePrompt(settings),
          authMode: settings.geminiAppAuthMode,
        }
    : undefined;
  const showStageTimingDetails = settings.showElapsedTime && settings.showStageTimingDetails;
  return {
    revision: 1,
    kind: wholeImage ? 'whole-image' : 'local-pipeline',
    ...(wholeImage
      ? {
          wholeImage: wholeImagePreparation!,
        }
      : { pipelineConfig: toPipelineConfig(settings) }),
    display: {
      showElapsedTime: settings.showElapsedTime,
      showStageTimingDetails,
      showRuntimeStages: showStageTimingDetails,
      stageTimingCardExpanded: settings.stageTimingCardExpanded,
      showTypesetDebug: settings.showTypesetDebug,
      showEraseDebug: settings.showEraseDebug,
    },
    diagnosticLogEnabled: settings.enableDebugLog,
    diagnosticSettings: sanitizeExtensionSettings(settings),
  };
}

function prepareExecution(
  settings: ExtensionSettings = defaultExtensionSettings,
): () => Promise<ExtensionExecutionSnapshot> {
  return async () => executionSnapshot(settings);
}

describe('ImageTranslationExecutionModule', () => {
  it('executes a prepared file through the tagged local-pipeline branch', async () => {
    const translated = new Blob(['translated'], { type: 'image/png' });
    const module = createImageTranslationExecutionModule({
      prepareExecution: prepareExecution(),
      runLocalPipeline: async (_file, _config, onProgress) => {
        onProgress({
          stage: 'detect',
          operation: 'detect-text',
          detail: '文本检测',
        });
        return completedLocalResult(translated);
      },
      now: (() => {
        const values = [100, 125];
        return () => values.shift() ?? 125;
      })(),
    });
    const progress: ImageTranslationExecutionProgress[] = [];

    const task = module.start({
      source: {
        kind: 'prepared-file',
        file: new File(['source'], 'source.png', { type: 'image/png' }),
      },
    });
    task.progress((event) => progress.push(event));

    await expect(task.result).resolves.toMatchObject({
      kind: 'local-pipeline',
      status: 'completed',
      image: translated,
      elapsedMs: 25,
      summary: {
        detectedRegionCount: 2,
      },
    });
    expect(progress).toEqual([
      { phase: 'preparing', operation: 'prepare-execution' },
      { phase: 'preparing', operation: 'acquire-source' },
      {
        phase: 'preparing',
        operation: 'source-ready',
        source: expect.objectContaining({
          file: expect.any(File),
          blob: expect.any(Blob),
        }),
      },
      {
        phase: 'executing',
        execution: {
          kind: 'local-pipeline',
          progress: {
            stage: 'detect',
            operation: 'detect-text',
            detail: '文本检测',
          },
        },
      },
      { phase: 'finalizing', operation: 'collect-artifacts' },
    ]);
  });

  it('keeps whole-image execution distinct from the local pipeline', async () => {
    const sourceBlob = new Blob(['source'], { type: 'image/jpeg' });
    const translated = new Blob(['whole-image'], { type: 'image/png' });
    const geminiSettings = {
      ...defaultExtensionSettings,
      translator: 'llm' as const,
      llmProvider: 'gemini' as const,
    };
    let receivedPreparation: unknown;
    const module = createImageTranslationExecutionModule({
      prepareExecution: prepareExecution(geminiSettings),
      downloadImage: async () => ({
        blob: sourceBlob,
        file: new File([sourceBlob], 'source.jpg', { type: sourceBlob.type }),
      }),
      runWholeImageTranslation: async (_file, options) => {
        receivedPreparation = options.preparation;
        return {
          image: translated,
          metadata: {
            modelLabel: 'Nano Banana Pro',
            stageTimings: [],
          },
        };
      },
      now: () => 10,
    });
    const progress: ImageTranslationExecutionProgress[] = [];

    const task = module.start({
      source: {
        kind: 'remote-image',
        url: 'https://example.com/source.jpg',
        referrerPolicy: 'strict-origin-when-cross-origin',
      },
    });
    task.progress((event) => progress.push(event));

    await expect(task.result).resolves.toMatchObject({
      kind: 'whole-image',
      status: 'completed',
      provider: 'gemini-app',
      image: translated,
      source: { blob: sourceBlob },
    });
    expect(progress.at(-2)).toEqual({
      phase: 'executing',
      execution: {
        kind: 'whole-image',
        provider: 'gemini-app',
        modelLabel: 'Nano Banana Pro',
        operation: 'generate',
      },
    });
    expect(receivedPreparation).toEqual(executionSnapshot(geminiSettings).wholeImage);
  });

  it('rejects an execution kind excluded by the owner', async () => {
    const module = createImageTranslationExecutionModule({
      prepareExecution: prepareExecution({
        ...defaultExtensionSettings,
        translator: 'llm',
        llmProvider: 'gemini',
      }),
    });

    const task = module.start({
      source: {
        kind: 'prepared-file',
        file: new File(['source'], 'source.png', { type: 'image/png' }),
      },
      allowedKinds: ['local-pipeline'],
    });

    await expect(task.result).rejects.toBeInstanceOf(
      ImageTranslationExecutionKindNotAllowedError,
    );
  });

  it('suppresses late progress and result delivery after cancellation', async () => {
    let finishPipeline!: (result: LocalPipelineResult) => void;
    let reportPipelineProgress!: (progress: PipelineProgress) => void;
    const translated = new Blob(['late'], { type: 'image/png' });
    const module = createImageTranslationExecutionModule({
      prepareExecution: prepareExecution(),
      runLocalPipeline: (_file, _config, onProgress) => {
        reportPipelineProgress = onProgress;
        return new Promise((resolve) => {
          finishPipeline = resolve;
        });
      },
    });
    const task = module.start({
      source: {
        kind: 'prepared-file',
        file: new File(['source'], 'source.png', { type: 'image/png' }),
      },
    });
    const progress: ImageTranslationExecutionProgress[] = [];
    task.progress((event) => progress.push(event));
    await Promise.resolve();
    await Promise.resolve();
    const deliveredBeforeCancel = progress.length;

    task.cancel('overlay closed');
    reportPipelineProgress({
      stage: 'done',
      operation: 'complete-pipeline',
      detail: '完成',
    });
    finishPipeline(completedLocalResult(translated));

    await expect(task.result).rejects.toMatchObject({ code: 'TASK_CANCELLED' });
    await Promise.resolve();
    expect(task.signal.aborted).toBe(true);
    expect(progress).toHaveLength(deliveredBeforeCancel);
  });

  it('treats no-translatable-text as a successful local result', async () => {
    const original = new Blob(['original'], { type: 'image/png' });
    const noText = completedLocalResult(original);
    noText.status = 'no-translatable-text';
    const module = createImageTranslationExecutionModule({
      prepareExecution: prepareExecution(),
      runLocalPipeline: async () => noText,
    });

    const task = module.start({
      source: {
        kind: 'prepared-file',
        file: new File([original], 'source.png', { type: original.type }),
      },
    });

    await expect(task.result).resolves.toMatchObject({
      kind: 'local-pipeline',
      status: 'no-translatable-text',
      image: original,
    });
  });

  it('provides production settings and remote-image adapters over runtime messages', async () => {
    const messages: unknown[] = [];
    const sendMessage = (async (message: { type: string }) => {
      messages.push(message);
      if (message.type === 'mt:download-image') {
        return {
          ok: true as const,
          type: 'mt:download-image' as const,
          base64: 'AQID',
          contentType: 'image/png',
          sourceUrl: 'https://example.com/source.png',
        };
      }
      throw new Error(`unexpected message: ${message.type}`);
    }) as typeof sendRuntimeMessage;
    const module = createImageTranslationExecutionModule({
      sendMessage,
      prepareExecution: prepareExecution(),
      runLocalPipeline: async () => completedLocalResult(new Blob(['done'])),
    });

    const result = await module.start({
      source: {
        kind: 'remote-image',
        url: 'https://example.com/image',
        referrerPolicy: 'same-origin',
      },
    }).result;

    expect(result.source.file.name).toBe('source.png');
    expect(result.source.blob.size).toBe(3);
    expect(messages).toContainEqual({
      type: 'mt:download-image',
      imageUrl: 'https://example.com/image',
      referrerPolicy: 'same-origin',
    });
  });

  it('normalizes pipeline-host failures as runtime-scoped execution failures', async () => {
    const module = createImageTranslationExecutionModule({
      prepareExecution: prepareExecution(),
      runLocalPipeline: async () => {
        throw Object.assign(new Error('pipeline host disconnected'), {
          code: 'PIPELINE_HOST_DISCONNECTED',
        });
      },
    });

    const task = module.start({
      source: {
        kind: 'prepared-file',
        file: new File(['source'], 'source.png', { type: 'image/png' }),
      },
    });

    await expect(task.result).rejects.toMatchObject({
      failure: {
        code: 'PIPELINE_HOST_DISCONNECTED',
        scope: 'runtime',
        retryable: true,
      },
    });
  });
});
