import { createDiagnosticRunId } from '../../../shared/diagnosticLogClient';
import type { ImageTarget, PhotoState } from '../types';
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
      const runSettings = await this.translationRunner.loadPipelineRunSettings(state);
      const diagnosticRunId = runSettings.enableDebugLog ? this.runtime.createRunId('run') : undefined;
      const source = await this.translationRunner.downloadImageFile(state.originalUrl, diagnosticRunId);
      await this.translationRunner.runPipelineFromFile({
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
      });
      const currentTarget = this.callbacks.resolveTarget(key) ?? target;
      this.callbacks.applyImage(currentTarget, state);
      this.callbacks.render(key);
    } catch (error) {
      this.runtime.finishJankMonitor(jankMonitor);
      state.status = 'error';
      state.errorText = toErrorMessage(error);
      state.stageText = '';
      clearTimingDisplay(state);
      state.debugLogData = undefined;
      this.callbacks.render(key);
    }
  }
}
