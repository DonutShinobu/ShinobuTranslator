import { createDiagnosticRunId } from '../../../shared/diagnosticLogClient';
import { usesNanoBananaImagePipeline } from '../../../shared/config';
import type {
  ImageTarget,
  ImageTranslationContextResolution,
  PhotoState,
} from '../types';
import type { ProgressJankMonitor } from '../progressJank';
import { toErrorMessage } from '../utils';
import { PhotoStateStore } from '../state/photoStateStore';
import {
  TranslationRunner,
  clearTimingDisplay,
  createProgressJankMonitor,
  finishProgressJankMonitor,
} from './translationRunner';

export type ImageTranslationCallbacks = {
  resolveTarget(key: string): ImageTarget | undefined;
  resolveTranslationContext?(target: ImageTarget): ImageTranslationContextResolution;
  applyImage(target: ImageTarget, state: PhotoState): void;
  render(key: string): void;
};

export type ImageTranslationRuntime = {
  createJankMonitor(entry: 'image'): ProgressJankMonitor;
  finishJankMonitor(monitor: ProgressJankMonitor): void;
  createRunId(prefix: string): string;
  now(): number;
};

const defaultRuntime: ImageTranslationRuntime = {
  createJankMonitor: createProgressJankMonitor,
  finishJankMonitor: (monitor) => {
    finishProgressJankMonitor(monitor);
  },
  createRunId: createDiagnosticRunId,
  now: () => performance.now(),
};

export class ImageTranslationController {
  constructor(
    private readonly stateStore: PhotoStateStore,
    private readonly translationRunner: TranslationRunner,
    private readonly callbacks: ImageTranslationCallbacks,
    private readonly runtime: ImageTranslationRuntime = defaultRuntime,
  ) {}

  async handleTranslateClick(target: ImageTarget): Promise<void> {
    const { key } = target;
    const state = this.stateStore.ensure(key, target.originalUrl);

    if (state.status === 'running') return;

    if (state.translatedUrl) {
      if (state.mode === 'translated') {
        state.mode = 'original';
        state.status = 'showingOriginal';
      } else {
        state.mode = 'translated';
        state.status = 'translated';
      }
      const currentTarget = this.callbacks.resolveTarget(key) ?? target;
      this.callbacks.applyImage(currentTarget, state);
      this.callbacks.render(key);
      return;
    }

    const jankMonitor = this.runtime.createJankMonitor('image');
    this.translationRunner.resetStateForPipeline(state);
    const runStartAt = this.runtime.now();
    jankMonitor.measureUiRender(() => this.callbacks.render(key));

    try {
      const runSettingsPromise = this.translationRunner.loadPipelineRunSettings(state);
      const clickTarget = this.callbacks.resolveTarget(key) ?? target;
      let capturedContextResolution: ImageTranslationContextResolution | undefined;
      try {
        capturedContextResolution = this.callbacks.resolveTranslationContext?.(clickTarget);
      } catch {
        capturedContextResolution = { status: 'unavailable' };
      }
      const runSettings = await runSettingsPromise;
      const translationContextResolution = (
        runSettings.settings.translator === 'llm'
        && !usesNanoBananaImagePipeline(runSettings.settings)
      )
        ? capturedContextResolution
        : undefined;
      const diagnosticRunId = runSettings.enableDebugLog ? this.runtime.createRunId('run') : undefined;
      const source = await this.translationRunner.downloadImageFile(state.originalUrl, diagnosticRunId);
      const pipelineOutcome = await this.translationRunner.runPipelineFromFile({
        state,
        file: source.file,
        runSettings,
        runStartAt,
        includeElapsedText: true,
        onProgress: () => {
          jankMonitor.measureUiRender(() => this.callbacks.render(key));
        },
        jankMonitor,
        diagnosticRunId,
        translationContext: translationContextResolution?.status === 'available'
          ? translationContextResolution.context
          : undefined,
      });
      if (pipelineOutcome.translationDebug?.tweetContextLengthFallback) {
        state.contextNoticeText = '推文上下文过长，已改为无上下文翻译';
      } else if (
        pipelineOutcome.translationDebug
        && translationContextResolution?.status === 'unavailable'
      ) {
        state.contextNoticeText = '未找到推文作为上下文';
      }
      const latestTarget = this.callbacks.resolveTarget(key) ?? target;
      this.callbacks.applyImage(latestTarget, state);
      this.callbacks.render(key);
    } catch (error) {
      this.runtime.finishJankMonitor(jankMonitor);
      state.status = 'error';
      state.errorText = toErrorMessage(error);
      state.stageText = '';
      clearTimingDisplay(state);
      state.debugLogData = undefined;
      state.contextNoticeText = undefined;
      this.callbacks.render(key);
    }
  }
}
