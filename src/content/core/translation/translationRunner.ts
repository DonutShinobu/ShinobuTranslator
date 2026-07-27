import {
  getGeminiAppModelLabel,
  toPipelineConfig,
  usesGeminiApiImagePipeline,
  usesNanoBananaImagePipeline,
  validateSettings,
} from '../../../shared/config';
import type { ExtensionSettings } from '../../../shared/config';
import {
  sanitizeDiagnosticUrl,
  sanitizeExtensionSettings,
  sanitizePipelineConfig,
  toDiagnosticError,
} from '../../../shared/diagnosticLog';
import { createDiagnosticRunId, emitDiagnosticLog, emitDiagnosticLogAsync } from '../../../shared/diagnosticLogClient';
import type { LocalPipelineArtifactSummary } from '../../../shared/localPipelineProtocol';
import { sendRuntimeMessage } from '../../../shared/messages';
import type { RuntimeErrorDetail } from '../../../shared/messages';
import type {
  ErrorDetailCardData,
  PhotoState,
  PipelineProgress,
  ProgressJankEntry,
  ProgressJankReport,
  TranslationReferenceContext,
  TranslationDebugInfo,
} from '../types';
import {
  base64ToBlob,
  blobToBase64,
  buildStageTimingCardData,
  formatElapsedText,
  getStageLabel,
  inferFileExtension,
  toErrorMessage,
} from '../utils';
import { ProgressJankMonitor } from '../progressJank';
import { runLocalPipeline, type RunLocalPipeline } from './localPipelineClient';

const loggedProgressJankReports = new Set<string>();

function validateActiveSettings(settings: ExtensionSettings): string | null {
  const baseError = validateSettings(settings);
  if (baseError) return baseError;
  return null;
}

function toErrorDetailCard(errorDetail: RuntimeErrorDetail | undefined): ErrorDetailCardData | undefined {
  if (!errorDetail) return undefined;
  return {
    title: errorDetail.title || 'Gemini 回复',
    content: errorDetail.content,
    expanded: false,
  };
}

export function clearTimingDisplay(state: PhotoState): void {
  state.elapsedText = '';
  state.stageTimingCard = undefined;
}

export function createProgressJankMonitor(entry: ProgressJankEntry): ProgressJankMonitor {
  const monitor = new ProgressJankMonitor(entry);
  monitor.start();
  return monitor;
}

export function finishProgressJankMonitor(monitor: ProgressJankMonitor | null, diagnosticRunId?: string): ProgressJankReport | null {
  if (!monitor) {
    return null;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getPipelineArtifactsFromError(error: unknown): LocalPipelineArtifactSummary | null {
  if (!isRecord(error) || !('artifacts' in error)) {
    return null;
  }
  const artifacts = error.artifacts;
  if (!isRecord(artifacts) || !Array.isArray(artifacts.stageTimings)) {
    return null;
  }
  return artifacts as LocalPipelineArtifactSummary;
}

function toFileDiagnosticData(file: File): Record<string, unknown> {
  return {
    name: file.name,
    type: file.type,
    size: file.size,
    lastModified: file.lastModified,
  };
}

function toPipelineArtifactsDiagnosticData(
  artifacts: LocalPipelineArtifactSummary,
  progressJank: ProgressJankReport | null,
): Record<string, unknown> {
  return {
    image: artifacts.image,
    detectedRegionCount: artifacts.detectedRegionCount,
    stageTimings: artifacts.stageTimings,
    runtimeStages: artifacts.runtimeStages,
    translationDebug: artifacts.translationDebug,
    ocrDebug: artifacts.ocrDebug,
    ocrPostFilterDebug: artifacts.ocrPostFilterDebug,
    progressJank,
    typesetDebug: artifacts.typesetDebug,
  };
}

export type PipelineRunSettings = {
  settings: ExtensionSettings;
  showElapsedTime: boolean;
  showStageTimingDetails: boolean;
  showRuntimeStages: boolean;
  stageTimingCardExpanded: boolean;
  showTypesetDebug: boolean;
  enableDebugLog: boolean;
};

export type PipelineRunFileOptions = {
  state: PhotoState;
  file: File;
  runSettings: PipelineRunSettings;
  runStartAt: number;
  includeElapsedText: boolean;
  onProgress: (stageText: string) => void;
  jankMonitor?: ProgressJankMonitor;
  diagnosticRunId?: string;
  translationContext?: TranslationReferenceContext;
};

export type PipelineRunOutcome = {
  translationDebug: TranslationDebugInfo | null;
};

export type DownloadImageFileOptions = {
  originalUrl: string;
  referrerPolicy?: ReferrerPolicy;
  diagnosticRunId?: string;
};

export type TranslationRunnerDependencies = {
  sendMessage?: typeof sendRuntimeMessage;
  runLocalPipeline?: RunLocalPipeline;
  urlApi?: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;
};

export class TranslationRunner {
  private readonly sendMessage: typeof sendRuntimeMessage;
  private readonly runLocalPipeline: RunLocalPipeline;
  private readonly urlApi: Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>;

  constructor(dependencies: TranslationRunnerDependencies = {}) {
    this.sendMessage = dependencies.sendMessage ?? sendRuntimeMessage;
    this.runLocalPipeline = dependencies.runLocalPipeline ?? runLocalPipeline;
    this.urlApi = dependencies.urlApi ?? URL;
  }

  resetStateForPipeline(state: PhotoState): void {
      state.status = 'running';
      state.mode = 'original';
      state.errorText = '';
      state.errorDetailCard = undefined;
      state.contextNoticeText = undefined;
      clearTimingDisplay(state);
      state.debugLogData = undefined;
      state.stageText = '准备中';
    }

  async loadPipelineRunSettings(state: PhotoState): Promise<PipelineRunSettings> {
      const settingsResponse = await this.sendMessage({ type: 'mt:get-settings' });
      if (!settingsResponse.ok || settingsResponse.type !== 'mt:get-settings') {
        throw new Error(settingsResponse.ok ? '读取配置失败' : settingsResponse.error);
      }
      const validationError = validateActiveSettings(settingsResponse.settings);
      if (validationError) throw new Error(validationError);

      const settings = settingsResponse.settings;
      const showElapsedTime = settings.showElapsedTime === true;
      const showStageTimingDetails = showElapsedTime && settings.showStageTimingDetails === true;
      const showRuntimeStages = showStageTimingDetails;
      const stageTimingCardExpanded = settings.stageTimingCardExpanded === true;
      const showTypesetDebug = settings.showTypesetDebug === true;
      const showEraseDebug = settings.showEraseDebug === true;
      const enableDebugLog = settings.enableDebugLog === true;
      state.showTypesetDebug = showTypesetDebug;
      state.showEraseDebug = showEraseDebug;
      return {
        settings,
        showElapsedTime,
        showStageTimingDetails,
        showRuntimeStages,
        stageTimingCardExpanded,
        showTypesetDebug,
        enableDebugLog,
      };
    }

  async downloadImageFile(options: DownloadImageFileOptions): Promise<{
      file: File;
      blob: Blob;
    }> {
      const {
        originalUrl,
        referrerPolicy,
        diagnosticRunId,
      } = options;
      const startedAt = performance.now();
      if (diagnosticRunId) {
        await emitDiagnosticLogAsync({
          runId: diagnosticRunId,
          level: 'info',
          category: 'image.io',
          source: { context: 'content', module: 'TranslatorCore.ts' },
          message: '开始下载原图',
          data: {
            originalUrl: sanitizeDiagnosticUrl(originalUrl),
            referrerPolicy,
          },
        });
      }
      try {
        const downloadResponse = await this.sendMessage({
          type: 'mt:download-image',
          imageUrl: originalUrl,
          ...(referrerPolicy !== undefined ? { referrerPolicy } : {}),
        });
        if (!downloadResponse.ok || downloadResponse.type !== 'mt:download-image') {
          throw new Error(downloadResponse.ok ? '下载图片失败' : downloadResponse.error);
        }

        const blob = base64ToBlob(downloadResponse.base64, downloadResponse.contentType);
        const suffix = inferFileExtension(downloadResponse.contentType, downloadResponse.sourceUrl);
        const file = new File([blob], `source.${suffix}`, { type: blob.type || 'image/jpeg' });
        if (diagnosticRunId) {
          emitDiagnosticLog({
            runId: diagnosticRunId,
            level: 'info',
            category: 'image.io',
            source: { context: 'content', module: 'TranslatorCore.ts' },
            message: '原图下载完成',
            data: {
              originalUrl: sanitizeDiagnosticUrl(originalUrl),
              sourceUrl: sanitizeDiagnosticUrl(downloadResponse.sourceUrl),
              contentType: downloadResponse.contentType,
              referrerPolicy,
              blobSize: blob.size,
              base64Length: downloadResponse.base64.length,
              durationMs: performance.now() - startedAt,
            },
          });
        }
        return {
          file,
          blob,
        };
      } catch (error) {
        if (diagnosticRunId) {
          emitDiagnosticLog({
            runId: diagnosticRunId,
            level: 'error',
            category: 'image.io',
            source: { context: 'content', module: 'TranslatorCore.ts' },
            message: `原图下载失败：${toErrorMessage(error)}`,
            data: {
              originalUrl: sanitizeDiagnosticUrl(originalUrl),
              referrerPolicy,
              durationMs: performance.now() - startedAt,
            },
            error: toDiagnosticError(error),
          });
        }
        throw error;
      }
    }

  private updatePipelineProgress(
      state: PhotoState,
      progress: PipelineProgress,
      onProgress: (stageText: string) => void,
      jankMonitor?: ProgressJankMonitor,
    ): void {
      const stageLabel = getStageLabel(progress.stage);
      if (progress.stage === 'parallel') {
        state.stageText = progress.detail;
      } else if (progress.stage === 'done') {
        state.stageText = '完成';
      } else {
        state.stageText = `${stageLabel}中`;
      }
      jankMonitor?.setStage(progress.stage, progress.detail, state.stageText);
      onProgress(state.stageText);
    }

  private getNanoBananaModelLabel(settings: ExtensionSettings): string {
      const modelLabel = getGeminiAppModelLabel(settings.geminiAppModel);
      return usesGeminiApiImagePipeline(settings) ? `Nano Banana API / ${modelLabel}` : modelLabel;
    }

  private async runNanoBananaImageTranslateFromFile(options: {
      state: PhotoState;
      file: File;
      runSettings: PipelineRunSettings;
      runStartAt: number;
      includeElapsedText: boolean;
      onProgress: (stageText: string) => void;
      jankMonitor?: ProgressJankMonitor;
      diagnosticRunId?: string;
    }): Promise<void> {
      const { state, file, runSettings, runStartAt, includeElapsedText, onProgress, jankMonitor, diagnosticRunId } = options;
      const modelLabel = this.getNanoBananaModelLabel(runSettings.settings);
      state.stageText = `${modelLabel} 全图翻译中`;
      jankMonitor?.setStage(usesGeminiApiImagePipeline(runSettings.settings) ? 'gemini_api' : 'gemini_app', `${modelLabel} 生成译图`, state.stageText);
      onProgress(state.stageText);

      const imageBase64 = await blobToBase64(file);
      const image = {
        base64: imageBase64,
        contentType: file.type || 'image/png',
        filename: file.name || 'source.png',
      };
      const response = usesGeminiApiImagePipeline(runSettings.settings)
        ? await this.sendMessage({
            type: 'mt:gemini-api-image-translate',
            image,
            diagnosticRunId,
          })
        : await this.sendMessage({
            type: 'mt:gemini-app-image-translate',
            image,
            diagnosticRunId,
          });
      if (!response.ok) {
        state.errorDetailCard = toErrorDetailCard(response.errorDetail);
        throw new Error(response.error);
      }
      if (
        response.type !== 'mt:gemini-app-image-translate' &&
        response.type !== 'mt:gemini-api-image-translate'
      ) {
        throw new Error('Nano Banana 翻译失败');
      }

      const stageTimings = response.metadata.stageTimings;
      const translatedBlob = base64ToBlob(response.base64, response.contentType);
      const translatedUrl = this.urlApi.createObjectURL(translatedBlob);
      if (state.translatedUrl) this.urlApi.revokeObjectURL(state.translatedUrl);
      if (state.debugOriginalUrl) {
        this.urlApi.revokeObjectURL(state.debugOriginalUrl);
        state.debugOriginalUrl = undefined;
      }

      const totalDurationMs = performance.now() - runStartAt;
      if (includeElapsedText && runSettings.showElapsedTime) {
        const showStageTimingCard = runSettings.showStageTimingDetails && stageTimings.length > 0;
        state.elapsedText = formatElapsedText(
          totalDurationMs,
          stageTimings,
          [],
          !showStageTimingCard && runSettings.showStageTimingDetails,
          false,
          null,
        );
        state.stageTimingCard = showStageTimingCard
          ? buildStageTimingCardData(totalDurationMs, stageTimings, [], runSettings.stageTimingCardExpanded, null)
          : undefined;
      } else {
        clearTimingDisplay(state);
      }

      state.debugOriginalUrl = undefined;
      state.debugLogData = undefined;
      state.translatedUrl = translatedUrl;
      state.stageText = '';
      state.errorText = '';
      state.errorDetailCard = undefined;
      state.mode = 'translated';
      state.status = 'translated';
    }

  async runPipelineFromFile(options: PipelineRunFileOptions): Promise<PipelineRunOutcome> {
      const { state, file, runSettings, runStartAt, includeElapsedText, onProgress, jankMonitor } = options;
      const diagnosticRunId = options.diagnosticRunId ?? (runSettings.enableDebugLog ? createDiagnosticRunId('run') : undefined);
      let progressJank: ProgressJankReport | null = null;
      const pipelineConfig = toPipelineConfig(runSettings.settings);
      if (options.translationContext) {
        pipelineConfig.translationContext = options.translationContext;
      }
      if (diagnosticRunId) {
        pipelineConfig.diagnosticRunId = diagnosticRunId;
      }
      if (diagnosticRunId) {
        await emitDiagnosticLogAsync({
          runId: diagnosticRunId,
          level: 'info',
          category: 'app.config',
          source: { context: 'content', module: 'TranslatorCore.ts' },
          message: '开始翻译 run',
          data: {
            runStatus: 'running',
            label: '图片翻译',
            settings: sanitizeExtensionSettings(runSettings.settings),
            pipelineConfig: sanitizePipelineConfig(pipelineConfig),
            pageUrl: sanitizeDiagnosticUrl(window.location.href),
            originalUrl: sanitizeDiagnosticUrl(state.originalUrl),
            file: toFileDiagnosticData(file),
          },
        });
      }
      try {
        if (usesNanoBananaImagePipeline(runSettings.settings)) {
          await this.runNanoBananaImageTranslateFromFile({ ...options, diagnosticRunId });
          progressJank = finishProgressJankMonitor(jankMonitor ?? null, diagnosticRunId);
          if (diagnosticRunId) {
            await emitDiagnosticLogAsync({
              runId: diagnosticRunId,
              level: 'info',
              category: 'pipeline.stage',
              source: { context: 'content', module: 'TranslatorCore.ts' },
              message: 'Nano Banana 全图翻译完成',
              data: {
                runStatus: 'success',
                durationMs: performance.now() - runStartAt,
                progressJank,
              },
            });
          }
          return { translationDebug: null };
        }

        const localResult = await this.runLocalPipeline(file, pipelineConfig, (progress: PipelineProgress) => {
          if (diagnosticRunId) {
            emitDiagnosticLog({
              runId: diagnosticRunId,
              level: 'info',
              category: 'pipeline.stage',
              source: { context: 'content', module: 'orchestrator.ts' },
              message: `进入阶段：${getStageLabel(progress.stage)}`,
              data: {
                stage: progress.stage,
                detail: progress.detail,
              },
            });
          }
          this.updatePipelineProgress(state, progress, onProgress, jankMonitor);
        });

        const artifacts = localResult.summary;
        const translatedUrl = this.urlApi.createObjectURL(localResult.result);
        if (state.translatedUrl) this.urlApi.revokeObjectURL(state.translatedUrl);
        if (state.debugOriginalUrl) {
          this.urlApi.revokeObjectURL(state.debugOriginalUrl);
          state.debugOriginalUrl = undefined;
        }
        if (runSettings.showTypesetDebug && localResult.debug) {
          state.debugOriginalUrl = this.urlApi.createObjectURL(localResult.debug);
        }
        progressJank = finishProgressJankMonitor(jankMonitor ?? null, diagnosticRunId);
        state.debugLogData = undefined;
        if (diagnosticRunId) {
          emitDiagnosticLog({
            runId: diagnosticRunId,
            level: 'info',
            category: 'pipeline.typeset',
            source: { context: 'content', module: 'TranslatorCore.ts' },
            message: '本地 pipeline artifacts 已汇总',
            data: toPipelineArtifactsDiagnosticData(artifacts, progressJank),
          });
          await emitDiagnosticLogAsync({
            runId: diagnosticRunId,
            level: 'info',
            category: 'pipeline.stage',
            source: { context: 'content', module: 'TranslatorCore.ts' },
            message: '翻译 run 完成',
            data: {
              runStatus: 'success',
              durationMs: performance.now() - runStartAt,
            },
          });
        }

        state.translatedUrl = translatedUrl;
        const totalDurationMs = performance.now() - runStartAt;
        if (includeElapsedText && runSettings.showElapsedTime) {
          const showStageTimingCard = runSettings.showStageTimingDetails && artifacts.stageTimings.length > 0;
          state.elapsedText = formatElapsedText(
            totalDurationMs,
            artifacts.stageTimings,
            artifacts.runtimeStages,
            !showStageTimingCard && runSettings.showStageTimingDetails,
            !showStageTimingCard && runSettings.showRuntimeStages,
            artifacts.translationDebug,
          );
          state.stageTimingCard = showStageTimingCard
            ? buildStageTimingCardData(
                totalDurationMs,
                artifacts.stageTimings,
                artifacts.runtimeStages,
                runSettings.stageTimingCardExpanded,
                artifacts.translationDebug,
              )
            : undefined;
        } else {
          clearTimingDisplay(state);
        }
        state.stageText = '';
        state.errorText = '';
        state.errorDetailCard = undefined;
        state.mode = 'translated';
        state.status = 'translated';
        return { translationDebug: artifacts.translationDebug };
      } catch (error) {
        if (!progressJank) {
          progressJank = finishProgressJankMonitor(jankMonitor ?? null, diagnosticRunId);
        }
        if (diagnosticRunId) {
          const artifacts = getPipelineArtifactsFromError(error);
          const diagnosticError = toDiagnosticError(error);
          await emitDiagnosticLogAsync({
            runId: diagnosticRunId,
            level: 'error',
            category: 'error',
            source: { context: 'content', module: 'TranslatorCore.ts' },
            message: `翻译 run 失败：${diagnosticError.message}`,
            data: {
              runStatus: 'failed',
              durationMs: performance.now() - runStartAt,
              progressJank,
              artifacts: artifacts ? toPipelineArtifactsDiagnosticData(artifacts, progressJank) : undefined,
            },
            error: diagnosticError,
          });
        }
        throw error;
      }
    }
}
