import { createDiagnosticRunId } from '../../../shared/diagnosticLogClient';
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
import { resolveImageReferrerPolicy, toErrorMessage } from '../utils';
import { PhotoStateStore } from '../state/photoStateStore';
import {
  TranslationRunner,
  clearTimingDisplay,
  createProgressJankMonitor,
  finishProgressJankMonitor,
} from '../translation/translationRunner';
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

export class ScreenshotController {
  private screenshotSelectionRunning = false;
  private selectionGeneration = 0;
  private readonly activeCleanups = new Set<() => void>();

  constructor(
    private readonly stateStore: PhotoStateStore,
    private readonly translationRunner: TranslationRunner,
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

      const ensureSourceFile = async (diagnosticRunId?: string): Promise<File> => {
        if (sourceFile) return sourceFile;
        state.stageText = '下载原图中';
        render();
        await waitForNextPaint();
        if (disposed) throw new Error('图片翻译已关闭');

        const source = await this.translationRunner.downloadImageFile({
          originalUrl,
          referrerPolicy: resolveImageReferrerPolicy(imageElement),
          diagnosticRunId,
        });
        if (disposed) throw new Error('图片翻译已关闭');

        sourceFile = source.file;
        if (sourceOriginalUrl) URL.revokeObjectURL(sourceOriginalUrl);
        sourceOriginalUrl = URL.createObjectURL(source.blob);
        state.originalUrl = sourceOriginalUrl;
        render();
        return sourceFile;
      };

      const runImagePipeline = async (): Promise<void> => {
        activeJankMonitor = createProgressJankMonitor('context-image');
        this.translationRunner.resetStateForPipeline(state);
        state.stageText = sourceFile ? '准备中' : '下载原图中';
        render();

        try {
          const runSettings = await this.translationRunner.loadPipelineRunSettings(state);
          const diagnosticRunId = runSettings.enableDebugLog ? createDiagnosticRunId('run') : undefined;
          const file = await ensureSourceFile(diagnosticRunId);
          if (disposed) return;
          await this.translationRunner.runPipelineFromFile({
            state,
            file,
            runSettings,
            runStartAt: performance.now(),
            includeElapsedText: true,
            onProgress: render,
            jankMonitor: activeJankMonitor,
            diagnosticRunId,
          });
          if (disposed) {
            this.stateStore.delete(key);
            return;
          }
          render();
        } catch (error) {
          finishProgressJankMonitor(activeJankMonitor);
          if (disposed) return;
          state.status = 'error';
          state.errorText = toErrorMessage(error);
          state.stageText = '';
          clearTimingDisplay(state);
          state.debugLogData = undefined;
          render();
        } finally {
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

      const ensureScreenshotFile = async (): Promise<File> => {
        if (screenshotFile) return screenshotFile;
        ui.host.style.visibility = '';
        state.stageText = '截图中';
        render();
        await waitForNextPaint();
        if (disposed) throw new Error('截图翻译已关闭');

        ui.host.style.visibility = 'hidden';
        await waitForNextPaint();
        const captureResponse = await sendRuntimeMessage({ type: 'mt:capture-visible-tab' });
        if (!captureResponse.ok || captureResponse.type !== 'mt:capture-visible-tab') {
          throw new Error(captureResponse.ok ? '截图失败' : captureResponse.error);
        }
        if (disposed) throw new Error('截图翻译已关闭');

        ui.host.style.visibility = '';
        state.stageText = '裁剪截图中';
        render();
        const screenshotDataUrl = `data:${captureResponse.contentType};base64,${captureResponse.base64}`;
        screenshotFile = await cropScreenshotToFile(screenshotDataUrl, selection.viewportRect, {
          width: window.innerWidth,
          height: window.innerHeight,
        });
        if (screenshotOriginalUrl) URL.revokeObjectURL(screenshotOriginalUrl);
        screenshotOriginalUrl = URL.createObjectURL(screenshotFile);
        state.originalUrl = screenshotOriginalUrl;
        render();
        return screenshotFile;
      };

      const runScreenshotPipeline = async (): Promise<void> => {
        activeJankMonitor = createProgressJankMonitor('screenshot');
        this.translationRunner.resetStateForPipeline(state);
        state.stageText = screenshotFile ? '准备中' : '截图中';
        render();

        try {
          const file = await ensureScreenshotFile();
          if (disposed) return;

          const runSettings = await this.translationRunner.loadPipelineRunSettings(state);
          if (disposed) return;
          await this.translationRunner.runPipelineFromFile({
            state,
            file,
            runSettings,
            runStartAt: performance.now(),
            includeElapsedText: true,
            onProgress: render,
            jankMonitor: activeJankMonitor,
          });
          if (disposed) {
            this.stateStore.delete(key);
            return;
          }
          ui.host.style.visibility = '';
          render();
        } catch (error) {
          finishProgressJankMonitor(activeJankMonitor);
          if (disposed) return;
          ui.host.style.visibility = '';
          state.status = 'error';
          state.errorText = toErrorMessage(error);
          state.stageText = '';
          clearTimingDisplay(state);
          state.debugLogData = undefined;
          render();
        } finally {
          activeJankMonitor = null;
        }
      };

      await runScreenshotPipeline();
    }
}
