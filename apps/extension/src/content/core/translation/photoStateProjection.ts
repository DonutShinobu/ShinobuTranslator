import { emitDiagnosticLog } from '../../../shared/diagnosticLogClient';
import type { TranslationTask } from '@shinobu/translator-core';
import type {
  ErrorDetailCardData,
  PhotoState,
  ProgressJankEntry,
  ProgressJankReport,
  TranslationDebugInfo,
} from '../types';
import {
  buildStageTimingCardData,
  formatElapsedText,
  getStageLabel,
  toErrorMessage,
} from '../utils';
import { ProgressJankMonitor } from '../progressJank';
import {
  ImageTranslationExecutionError,
  WholeImageTranslationError,
  type AcquiredImageTranslationSource,
  type ImageTranslationExecutionModule,
  type ImageTranslationExecutionProgress,
  type ImageTranslationExecutionRequest,
  type ImageTranslationExecutionResult,
} from './imageTranslationExecution';

const loggedProgressJankReports = new Set<string>();

export type PhotoStateProjectionOptions = {
  jankMonitor?: ProgressJankMonitor | null;
  onProgress?: () => void;
};

export type PhotoStateResultProjectionOptions = {
  includeElapsedText: boolean;
  urlApi?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
};

export type PhotoStateProjectionOutcome = {
  translationDebug: TranslationDebugInfo | null;
};

export type PhotoStateImageTranslationOutcome = PhotoStateProjectionOutcome & {
  execution: ImageTranslationExecutionResult;
};

export type StartPhotoStateImageTranslationOptions = {
  executionModule: ImageTranslationExecutionModule;
  request: ImageTranslationExecutionRequest;
  state: PhotoState;
  includeElapsedText: boolean;
  jankMonitor?: ProgressJankMonitor | null;
  finishJankMonitor?: (monitor: ProgressJankMonitor, diagnosticRunId?: string) => void;
  onSourceReady?: (source: AcquiredImageTranslationSource) => void;
  onChange?: () => void;
  urlApi?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
};

export function clearPhotoStateTiming(state: PhotoState): void {
  state.elapsedText = '';
  state.stageTimingCard = undefined;
}

export function resetPhotoStateForImageTranslation(state: PhotoState): void {
  state.status = 'running';
  state.mode = 'original';
  state.errorText = '';
  state.errorDetailCard = undefined;
  state.contextNoticeText = undefined;
  clearPhotoStateTiming(state);
  state.debugLogData = undefined;
  state.stageText = '准备中';
}

export function createProgressJankMonitor(entry: ProgressJankEntry): ProgressJankMonitor {
  const monitor = new ProgressJankMonitor(entry);
  monitor.start();
  return monitor;
}

export function finishProgressJankMonitor(
  monitor: ProgressJankMonitor | null,
  diagnosticRunId?: string,
): ProgressJankReport | null {
  if (!monitor) return null;
  const report = monitor.finish();
  if (!loggedProgressJankReports.has(report.runId)) {
    loggedProgressJankReports.add(report.runId);
    console.info('[shinobu:jank]', report);
    emitDiagnosticLog({
      runId: diagnosticRunId ?? report.runId,
      level: 'info',
      category: 'ui.perf',
      source: { context: 'content', module: 'progressJank.ts' },
      message: `进度 UI 卡顿报告：${report.entry}`,
      data: { progressJank: report },
    });
  }
  return report;
}

export function applyImageTranslationProgress(
  state: PhotoState,
  event: ImageTranslationExecutionProgress,
  options: PhotoStateProjectionOptions = {},
): void {
  if (event.phase === 'preparing') {
    state.stageText = event.operation === 'acquire-source' ? '获取图片中' : '准备中';
    options.onProgress?.();
    return;
  }
  if (event.phase === 'finalizing') {
    options.jankMonitor?.setStage('finalize', event.operation, state.stageText);
    return;
  }
  if (event.execution.kind === 'whole-image') {
    state.stageText = `${event.execution.modelLabel} 全图翻译中`;
    options.jankMonitor?.setStage(
      event.execution.provider === 'gemini-api' ? 'gemini_api' : 'gemini_app',
      `${event.execution.modelLabel} 生成译图`,
      state.stageText,
    );
    options.onProgress?.();
    return;
  }

  const progress = event.execution.progress;
  const detail = progress.detail ?? progress.operation;
  if (progress.stage === 'runtime-prepare' || progress.stage === 'finalize') {
    options.jankMonitor?.setStage(progress.stage, detail, state.stageText);
    return;
  }
  const stageLabel = getStageLabel(progress.stage);
  if (progress.stage === 'parallel') {
    state.stageText = detail;
  } else if (progress.stage === 'done') {
    state.stageText = '完成';
  } else {
    state.stageText = `${stageLabel}中`;
  }
  options.jankMonitor?.setStage(progress.stage, detail, state.stageText);
  options.onProgress?.();
}

function replaceUrl(
  previous: string | undefined,
  blob: Blob,
  urlApi: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>,
): string {
  const next = urlApi.createObjectURL(blob);
  if (previous) urlApi.revokeObjectURL(previous);
  return next;
}

export function applyImageTranslationResult(
  state: PhotoState,
  result: ImageTranslationExecutionResult,
  options: PhotoStateResultProjectionOptions,
): PhotoStateProjectionOutcome {
  const urlApi = options.urlApi ?? URL;
  state.translatedUrl = replaceUrl(state.translatedUrl, result.image, urlApi);

  if (state.debugOriginalUrl) {
    urlApi.revokeObjectURL(state.debugOriginalUrl);
    state.debugOriginalUrl = undefined;
  }
  if (result.kind === 'local-pipeline' && result.display.showTypesetDebug && result.debug) {
    state.debugOriginalUrl = urlApi.createObjectURL(result.debug);
  }

  state.showTypesetDebug = result.display.showTypesetDebug;
  state.showEraseDebug = result.display.showEraseDebug;
  state.debugLogData = undefined;

  const stageTimings = result.kind === 'local-pipeline'
    ? result.summary.stageTimings
    : result.metadata.stageTimings;
  const runtimeStages = result.kind === 'local-pipeline'
    ? result.summary.runtimeStages
    : [];
  const translationDebug = result.kind === 'local-pipeline'
    ? result.summary.translationDebug
    : null;
  if (options.includeElapsedText && result.display.showElapsedTime) {
    const showStageTimingCard = result.display.showStageTimingDetails && stageTimings.length > 0;
    state.elapsedText = formatElapsedText(
      result.elapsedMs,
      stageTimings,
      runtimeStages,
      !showStageTimingCard && result.display.showStageTimingDetails,
      !showStageTimingCard && result.display.showRuntimeStages,
      translationDebug,
    );
    state.stageTimingCard = showStageTimingCard
      ? buildStageTimingCardData(
          result.elapsedMs,
          stageTimings,
          runtimeStages,
          result.display.stageTimingCardExpanded,
          translationDebug,
        )
      : undefined;
  } else {
    clearPhotoStateTiming(state);
  }

  state.stageText = '';
  state.errorText = '';
  state.errorDetailCard = undefined;
  state.mode = 'translated';
  state.status = 'translated';
  return { translationDebug };
}

function toErrorDetailCard(error: unknown): ErrorDetailCardData | undefined {
  if (!(error instanceof WholeImageTranslationError) || !error.detail) return undefined;
  return {
    title: error.detail.title || 'Gemini 回复',
    content: error.detail.content,
    expanded: false,
  };
}

export function applyImageTranslationFailure(state: PhotoState, error: unknown): void {
  state.status = 'error';
  state.errorText = toErrorMessage(error);
  state.errorDetailCard = toErrorDetailCard(error);
  state.stageText = '';
  clearPhotoStateTiming(state);
  state.debugLogData = undefined;
  state.contextNoticeText = undefined;
}

export function startPhotoStateImageTranslation(
  options: StartPhotoStateImageTranslationOptions,
): TranslationTask<ImageTranslationExecutionProgress, PhotoStateImageTranslationOutcome> {
  const notify = (): void => {
    if (!options.onChange) return;
    if (options.jankMonitor) {
      options.jankMonitor.measureUiRender(options.onChange);
    } else {
      options.onChange();
    }
  };

  resetPhotoStateForImageTranslation(options.state);
  notify();
  const executionTask = options.executionModule.start(options.request);
  const stopProgress = executionTask.progress((event) => {
    if (event.phase === 'preparing' && event.operation === 'source-ready') {
      options.onSourceReady?.(event.source);
    }
    applyImageTranslationProgress(options.state, event, {
      jankMonitor: options.jankMonitor,
      onProgress: notify,
    });
  });
  let jankFinished = false;
  const finishJank = (diagnosticRunId?: string): void => {
    if (jankFinished) return;
    jankFinished = true;
    if (!options.jankMonitor) return;
    if (options.finishJankMonitor) {
      options.finishJankMonitor(options.jankMonitor, diagnosticRunId);
    } else {
      finishProgressJankMonitor(options.jankMonitor, diagnosticRunId);
    }
  };
  const result = executionTask.result
    .then((execution) => {
      finishJank(execution.diagnosticRunId);
      const projection = applyImageTranslationResult(options.state, execution, {
        includeElapsedText: options.includeElapsedText,
        urlApi: options.urlApi,
      });
      notify();
      return { execution, ...projection };
    })
    .catch((error: unknown) => {
      finishJank(
        error instanceof ImageTranslationExecutionError
          ? error.diagnosticRunId
          : undefined,
      );
      if (executionTask.signal.aborted) {
        options.state.status = 'idle';
        options.state.mode = 'original';
        options.state.stageText = '';
        options.state.errorText = '';
        options.state.errorDetailCard = undefined;
        clearPhotoStateTiming(options.state);
        options.state.debugLogData = undefined;
        notify();
        throw error;
      }
      applyImageTranslationFailure(options.state, error);
      notify();
      throw error;
    })
    .finally(stopProgress);

  return {
    result,
    signal: executionTask.signal,
    cancel: (reason) => executionTask.cancel(reason),
    progress: (listener) => executionTask.progress(listener),
  };
}
