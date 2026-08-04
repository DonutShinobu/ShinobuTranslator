import { sendRuntimeMessage } from '../../../shared/messages';
import {
  createScreenshotResultUi,
  repositionScreenshotResultOverlay,
  renderScreenshotResultUi,
  requestScreenshotSelection,
  setScreenshotResultRect,
} from '../ui';
import {
  cropScreenshotToFile,
  toViewportScreenshotRect,
} from '../screenshot';
import type { ScreenshotRect, ScreenshotSelection } from '../screenshot';
import { ProgressJankMonitor } from '../progressJank';
import { resolveImageReferrerPolicy } from '../utils';
import { PhotoStateStore } from '../state/photoStateStore';
import type {
  ImageTranslationExecutionActivity,
  ImageTranslationExecutionArbiter,
} from '../translation/imageTranslationExecutionArbiter';
import {
  applyImageTranslationCancellation,
  applyImageTranslationFailure,
  createProgressJankMonitor,
  finishProgressJankMonitor,
  resetPhotoStateForImageTranslation,
  startPhotoStateImageTranslation,
} from '../translation/photoStateProjection';
import { CardStateController } from '../ui/cardState';
import {
  attachScreenshotResultDrag,
  attachScreenshotResultZoom,
  resolveContextImageAnchorRects,
} from './overlayInteraction';

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function throwIfActivityAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new Error('图片翻译活动已取消');
}

export class ScreenshotController {
  private screenshotSelectionRunning = false;
  private selectionGeneration = 0;
  private readonly activeCleanups = new Set<() => void>();

  constructor(
    private readonly stateStore: PhotoStateStore,
    private readonly executionArbiter: ImageTranslationExecutionArbiter,
    private readonly cardStateController: CardStateController,
    private readonly requestSelection: () => Promise<ScreenshotSelection | null> = requestScreenshotSelection,
  ) {}

  async startScreenshotTranslate(): Promise<void> {
      if (this.screenshotSelectionRunning) return;
      this.screenshotSelectionRunning = true;
      const generation = this.selectionGeneration;
      let selection: ScreenshotSelection | null;
      try {
        selection = await this.requestSelection();
      } finally {
        this.screenshotSelectionRunning = false;
      }
      if (!selection || generation !== this.selectionGeneration) return;
      await this.translateScreenshotSelection(selection);
    }

  dispose(): void {
    this.selectionGeneration += 1;
    this.screenshotSelectionRunning = false;
    for (const cleanup of [...this.activeCleanups]) cleanup();
    this.activeCleanups.clear();
  }

  async translateImageInFloatingOverlay(
      originalUrl: string,
      imageElement: HTMLImageElement,
      fallbackDocumentRect: ScreenshotRect,
    ): Promise<void> {
      const key = `context-image-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const state = this.stateStore.ensure(key, originalUrl);
      const ui = createScreenshotResultUi(fallbackDocumentRect);
      document.body.appendChild(ui.host);

      let disposed = false;
      let imageAnchorDetached = false;
      let anchorFrame: number | null = null;
      let manualResultAnchorTracking = false;
      let detachDrag: (() => void) | null = null;
      let detachZoom: (() => void) | null = null;
      let sourceFile: File | null = null;
      let sourceOriginalUrl: string | null = null;
      let activeJankMonitor: ProgressJankMonitor | null = null;
      let activeActivity: ImageTranslationExecutionActivity | null = null;
      let lastImageAnchorKey = '';
      const toAnchorRectKey = (rect: ScreenshotRect): string => [
        Math.round(rect.left * 10),
        Math.round(rect.top * 10),
        Math.round(rect.width * 10),
        Math.round(rect.height * 10),
      ].join(':');
      const syncImageAnchor = (force = false): void => {
        if (disposed || imageAnchorDetached) return;
        const anchorRects = resolveContextImageAnchorRects(imageElement, fallbackDocumentRect);
        const anchorKey = [
          toAnchorRectKey(anchorRects.documentRect),
          toAnchorRectKey(anchorRects.visibleViewportRect),
          window.innerWidth,
          window.innerHeight,
        ].join('|');
        if (!force && anchorKey === lastImageAnchorKey) return;
        lastImageAnchorKey = anchorKey;
        setScreenshotResultRect(ui, anchorRects.documentRect);
        repositionScreenshotResultOverlay(ui, anchorRects.visibleViewportRect, { placement: 'contextImage' });
      };
      const syncManualResultAnchor = (force = false): void => {
        if (disposed || !manualResultAnchorTracking) return;
        const hostRect = ui.host.getBoundingClientRect();
        if (hostRect.width <= 0 || hostRect.height <= 0) return;
        const viewportRect: ScreenshotRect = {
          left: hostRect.left,
          top: hostRect.top,
          width: hostRect.width,
          height: hostRect.height,
        };
        const visibleViewportRect = toViewportScreenshotRect(
          viewportRect,
          window.innerWidth,
          window.innerHeight,
        );
        const anchorKey = [
          toAnchorRectKey(viewportRect),
          toAnchorRectKey(visibleViewportRect),
          window.innerWidth,
          window.innerHeight,
        ].join('|');
        if (!force && anchorKey === lastImageAnchorKey) return;
        lastImageAnchorKey = anchorKey;
        repositionScreenshotResultOverlay(ui, visibleViewportRect, {
          placement: 'contextImage',
          lockNormalWhenReachable: true,
          preferOutsideFallback: true,
        });
      };
      const syncActiveAnchor = (force = false): void => {
        if (manualResultAnchorTracking) {
          syncManualResultAnchor(force);
          return;
        }
        syncImageAnchor(force);
      };
      const scheduleAnchorSync = (): void => {
        if (disposed || anchorFrame !== null) return;
        anchorFrame = window.requestAnimationFrame(() => {
          anchorFrame = null;
          syncActiveAnchor();
          scheduleAnchorSync();
        });
      };
      const stopAnchorTracking = (): void => {
        if (anchorFrame !== null) {
          window.cancelAnimationFrame(anchorFrame);
          anchorFrame = null;
        }
      };
      const switchToManualResultAnchor = (): void => {
        if (disposed || manualResultAnchorTracking) return;
        syncImageAnchor(true);
        imageAnchorDetached = true;
        manualResultAnchorTracking = true;
        lastImageAnchorKey = '';
        syncManualResultAnchor(true);
      };
      const render = (): void => {
        if (disposed) return;
        if (activeJankMonitor) {
          activeJankMonitor.measureUiRender(() => renderScreenshotResultUi(ui, state));
        } else {
          renderScreenshotResultUi(ui, state);
        }
        syncActiveAnchor(true);
      };
      const cleanup = (): void => {
        if (disposed) return;
        disposed = true;
        activeActivity?.end('图片翻译浮层已关闭');
        activeActivity = null;
        this.activeCleanups.delete(cleanup);
        stopAnchorTracking();
        detachDrag?.();
        detachZoom?.();
        this.stateStore.delete(key);
        if (sourceOriginalUrl) {
          URL.revokeObjectURL(sourceOriginalUrl);
          sourceOriginalUrl = null;
        }
        ui.host.remove();
      };
      this.activeCleanups.add(cleanup);

      ui.closeButton.addEventListener('click', cleanup);
      ui.button.addEventListener('click', () => {
        if (state.status === 'running') return;
        if (state.status === 'error') {
          void runImagePipeline();
          return;
        }
        if (!state.translatedUrl || !sourceOriginalUrl) return;
        if (state.mode === 'translated') {
          state.mode = 'original';
          state.status = 'showingOriginal';
        } else {
          state.mode = 'translated';
          state.status = 'translated';
        }
        render();
      });
      ui.stageTimingCardToggleButton.addEventListener('click', () => {
        this.cardStateController.toggleStageTimingCard(state, render);
      });
      ui.errorDetailCardToggleButton.addEventListener('click', () => {
        this.cardStateController.toggleErrorDetailCard(state, render);
      });
      detachDrag = attachScreenshotResultDrag(ui, switchToManualResultAnchor);
      detachZoom = attachScreenshotResultZoom(ui, render, switchToManualResultAnchor);
      syncActiveAnchor(true);
      scheduleAnchorSync();

      const runImagePipeline = async (): Promise<void> => {
        const admission = this.executionArbiter.begin({
          owner: 'screenshot',
          origin: 'explicit',
        });
        if (admission.status !== 'active') return;
        const activity = admission.activity;
        activeActivity = activity;
        activeJankMonitor = createProgressJankMonitor('context-image');
        const task = startPhotoStateImageTranslation({
          executionModule: activity,
          request: {
            source: sourceFile
              ? { kind: 'prepared-file', file: sourceFile }
              : {
                  kind: 'remote-image',
                  url: originalUrl,
                  referrerPolicy: resolveImageReferrerPolicy(imageElement),
                },
          },
          state,
          includeElapsedText: true,
          jankMonitor: activeJankMonitor,
          onSourceReady: (source) => {
            if (disposed) return;
            sourceFile = source.file;
            if (!sourceOriginalUrl) {
              sourceOriginalUrl = URL.createObjectURL(source.blob);
            }
            state.originalUrl = sourceOriginalUrl;
          },
          onChange: render,
        });
        try {
          const outcome = await task.result;
          if (disposed) {
            this.stateStore.delete(key);
            return;
          }
          if (!sourceOriginalUrl) {
            sourceOriginalUrl = URL.createObjectURL(outcome.execution.source.blob);
            state.originalUrl = sourceOriginalUrl;
          }
          render();
        } catch {
          // The PhotoState projection already exposes the actionable error.
        } finally {
          if (activeActivity === activity) activeActivity = null;
          activity.end();
          activeJankMonitor = null;
        }
      };

      await runImagePipeline();
    }

  async translateScreenshotSelection(selection: ScreenshotSelection): Promise<void> {
      const key = `screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const state = this.stateStore.ensure(key, `screenshot:${key}`);
      const ui = createScreenshotResultUi(selection.documentRect);
      document.body.appendChild(ui.host);

      let disposed = false;
      let detachDrag: (() => void) | null = null;
      let detachZoom: (() => void) | null = null;
      let screenshotFile: File | null = null;
      let screenshotOriginalUrl: string | null = null;
      let activeJankMonitor: ProgressJankMonitor | null = null;
      let activeActivity: ImageTranslationExecutionActivity | null = null;
      const render = (): void => {
        if (disposed) return;
        if (activeJankMonitor) {
          activeJankMonitor.measureUiRender(() => renderScreenshotResultUi(ui, state));
        } else {
          renderScreenshotResultUi(ui, state);
        }
      };
      const cleanup = (): void => {
        if (disposed) return;
        disposed = true;
        activeActivity?.end('截图翻译浮层已关闭');
        activeActivity = null;
        this.activeCleanups.delete(cleanup);
        detachDrag?.();
        detachZoom?.();
        this.stateStore.delete(key);
        if (screenshotOriginalUrl) {
          URL.revokeObjectURL(screenshotOriginalUrl);
          screenshotOriginalUrl = null;
        }
        ui.host.remove();
      };
      this.activeCleanups.add(cleanup);

      ui.closeButton.addEventListener('click', cleanup);
      ui.button.addEventListener('click', () => {
        if (state.status === 'running') return;
        if (state.status === 'error') {
          void runScreenshotPipeline();
          return;
        }
        if (!state.translatedUrl || !screenshotOriginalUrl) return;
        if (state.mode === 'translated') {
          state.mode = 'original';
          state.status = 'showingOriginal';
        } else {
          state.mode = 'translated';
          state.status = 'translated';
        }
        render();
      });
      ui.stageTimingCardToggleButton.addEventListener('click', () => {
        this.cardStateController.toggleStageTimingCard(state, render);
      });
      ui.errorDetailCardToggleButton.addEventListener('click', () => {
        this.cardStateController.toggleErrorDetailCard(state, render);
      });
      detachDrag = attachScreenshotResultDrag(ui);
      detachZoom = attachScreenshotResultZoom(ui, render);

      const ensureScreenshotFile = async (activitySignal: AbortSignal): Promise<File> => {
        if (screenshotFile) return screenshotFile;
        ui.host.style.visibility = '';
        state.stageText = '截图中';
        render();
        await waitForNextPaint();
        if (disposed) throw new Error('截图翻译已关闭');
        throwIfActivityAborted(activitySignal);

        ui.host.style.visibility = 'hidden';
        await waitForNextPaint();
        throwIfActivityAborted(activitySignal);
        const captureResponse = await sendRuntimeMessage({ type: 'mt:capture-visible-tab' });
        if (!captureResponse.ok || captureResponse.type !== 'mt:capture-visible-tab') {
          throw new Error(captureResponse.ok ? '截图失败' : captureResponse.error);
        }
        if (disposed) throw new Error('截图翻译已关闭');
        throwIfActivityAborted(activitySignal);

        ui.host.style.visibility = '';
        state.stageText = '裁剪截图中';
        render();
        const screenshotDataUrl = `data:${captureResponse.contentType};base64,${captureResponse.base64}`;
        const capturedFile = await cropScreenshotToFile(screenshotDataUrl, selection.viewportRect, {
          width: window.innerWidth,
          height: window.innerHeight,
        });
        throwIfActivityAborted(activitySignal);
        screenshotFile = capturedFile;
        if (screenshotOriginalUrl) URL.revokeObjectURL(screenshotOriginalUrl);
        screenshotOriginalUrl = URL.createObjectURL(screenshotFile);
        state.originalUrl = screenshotOriginalUrl;
        render();
        return screenshotFile;
      };

      const runScreenshotPipeline = async (): Promise<void> => {
        const admission = this.executionArbiter.begin({
          owner: 'screenshot',
          origin: 'explicit',
        });
        if (admission.status !== 'active') return;
        const activity = admission.activity;
        activeActivity = activity;
        let executionTaskStarted = false;
        activeJankMonitor = createProgressJankMonitor('screenshot');
        resetPhotoStateForImageTranslation(state);
        state.stageText = screenshotFile ? '准备中' : '截图中';
        render();

        try {
          const file = await ensureScreenshotFile(activity.signal);
          if (disposed) return;

          const task = startPhotoStateImageTranslation({
            executionModule: activity,
            request: {
              source: { kind: 'prepared-file', file },
            },
            state,
            includeElapsedText: true,
            jankMonitor: activeJankMonitor,
            onChange: render,
          });
          executionTaskStarted = true;
          await task.result;
          if (disposed) {
            this.stateStore.delete(key);
            return;
          }
          ui.host.style.visibility = '';
          render();
        } catch (error) {
          if (disposed) return;
          ui.host.style.visibility = '';
          if (!executionTaskStarted) {
            finishProgressJankMonitor(activeJankMonitor);
            if (activity.signal.aborted) {
              applyImageTranslationCancellation(state);
            } else {
              applyImageTranslationFailure(state, error);
            }
          }
          render();
        } finally {
          if (activeActivity === activity) activeActivity = null;
          activity.end();
          activeJankMonitor = null;
        }
      };

      await runScreenshotPipeline();
    }
}
