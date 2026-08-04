import type {
  ImageTarget,
  ImageTranslationContextResolution,
  PhotoState,
} from '../types';
import type { ProgressJankMonitor } from '../progressJank';
import { resolveImageReferrerPolicy } from '../utils';
import { PhotoStateStore } from '../state/photoStateStore';
import type { ImageTranslationExecutionModule } from './imageTranslationExecution';
import {
  createProgressJankMonitor,
  finishProgressJankMonitor,
  startPhotoStateImageTranslation,
} from './photoStateProjection';

export type ImageTranslationCallbacks = {
  resolveTarget(key: string): ImageTarget | undefined;
  resolveTranslationContext?(target: ImageTarget): ImageTranslationContextResolution;
  applyImage(target: ImageTarget, state: PhotoState): void;
  render(key: string): void;
};

export type ImageTranslationRuntime = {
  createJankMonitor(entry: 'image'): ProgressJankMonitor;
  finishJankMonitor(monitor: ProgressJankMonitor, diagnosticRunId?: string): void;
};

const defaultRuntime: ImageTranslationRuntime = {
  createJankMonitor: createProgressJankMonitor,
  finishJankMonitor: (monitor, diagnosticRunId) => {
    finishProgressJankMonitor(monitor, diagnosticRunId);
  },
};

type CancellableTask = {
  cancel(reason?: unknown): void;
};

export class ImageTranslationController {
  private readonly activeTasks = new Map<string, CancellableTask>();

  constructor(
    private readonly stateStore: PhotoStateStore,
    private readonly executionModule: ImageTranslationExecutionModule,
    private readonly callbacks: ImageTranslationCallbacks,
    private readonly runtime: ImageTranslationRuntime = defaultRuntime,
  ) {}

  dispose(): void {
    for (const task of this.activeTasks.values()) {
      task.cancel('图片翻译控制器已停止');
    }
    this.activeTasks.clear();
  }

  cancel(key: string): void {
    this.activeTasks.get(key)?.cancel('图片已离开页面');
    this.activeTasks.delete(key);
  }

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

    const clickTarget = this.callbacks.resolveTarget(key) ?? target;
    let contextResolution: ImageTranslationContextResolution | undefined;
    try {
      contextResolution = this.callbacks.resolveTranslationContext?.(clickTarget);
    } catch {
      contextResolution = { status: 'unavailable' };
    }

    const jankMonitor = this.runtime.createJankMonitor('image');
    const task = startPhotoStateImageTranslation({
      executionModule: this.executionModule,
      request: {
        source: {
          kind: 'remote-image',
          url: state.originalUrl,
          referrerPolicy: resolveImageReferrerPolicy(clickTarget.element),
        },
        translationContext: contextResolution?.status === 'available'
          ? contextResolution.context
          : undefined,
      },
      state,
      includeElapsedText: true,
      jankMonitor,
      finishJankMonitor: this.runtime.finishJankMonitor,
      onChange: () => this.callbacks.render(key),
    });
    this.activeTasks.set(key, task);

    try {
      const outcome = await task.result;
      if (outcome.translationDebug?.tweetContextLengthFallback) {
        state.contextNoticeText = '推文上下文过长，已改为无上下文翻译';
      } else if (outcome.translationDebug && contextResolution?.status === 'unavailable') {
        state.contextNoticeText = '未找到推文作为上下文';
      }
      const latestTarget = this.callbacks.resolveTarget(key) ?? target;
      this.callbacks.applyImage(latestTarget, state);
      this.callbacks.render(key);
    } catch {
      // The PhotoState projection already exposes the actionable error.
    } finally {
      if (this.activeTasks.get(key) === task) {
        this.activeTasks.delete(key);
      }
    }
  }
}
