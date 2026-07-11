import { usesNanoBananaImagePipeline } from '../../../shared/config';
import { createDiagnosticRunId } from '../../../shared/diagnosticLogClient';
import type { ReadingModeBarUi, SiteAdapter, UrlTarget } from '../types';
import { createReadingModeBarUi } from '../ui';
import { toErrorMessage } from '../utils';
import { PhotoStateStore } from '../state/photoStateStore';
import {
  TranslationRunner,
  clearTimingDisplay,
  createProgressJankMonitor,
  finishProgressJankMonitor,
} from '../translation/translationRunner';

export class ReadingModeController {
  private readingBarUi: ReadingModeBarUi | null = null;
  private translateAllRunning = false;
  private translateCurrentRunning = false;
  private allPageUrls: UrlTarget[] = [];
  private globalTranslateMode: 'original' | 'translated' = 'original';

  constructor(
    private readonly adapter: SiteAdapter,
    private readonly stateStore: PhotoStateStore,
    private readonly translationRunner: TranslationRunner,
    private readonly scheduleCoreSync: () => void,
    private readonly cancelCoreSync: () => void,
    private readonly createBar: () => ReadingModeBarUi = createReadingModeBarUi,
  ) {}

  sync(): void {
      // Create or re-acquire bottom bar anchor
      const anchor = this.adapter.createBottomBarAnchor?.();
      if (!anchor) {
        // Bottom bar not yet available — tear down and wait for next sync.
        this.teardown();
        return;
      }

      // Create bar UI if not yet mounted
      if (!this.readingBarUi || !this.readingBarUi.host.isConnected) {
        this.readingBarUi = this.createBar();
        anchor.appendChild(this.readingBarUi.host);
        this.readingBarUi.translateCurrentBtn.addEventListener('click', () => {
          void this.handleTranslateCurrentClick();
        });
        this.readingBarUi.translateAllBtn.addEventListener('click', () => {
          void this.handleTranslateAllClick();
        });
      }

      // Refresh page URL list (in case totalPages changed between syncs)
      this.allPageUrls = this.adapter.findAllPageUrls?.() ?? [];

      // Apply stored translated images to any newly-visible pages.
      // During translation loops, always show translated; otherwise respect toggle mode.
      for (const pageUrl of this.allPageUrls) {
        const state = this.stateStore.get(pageUrl.key);
        if (state?.translatedUrl) {
          const isRunning = this.translateAllRunning || this.translateCurrentRunning;
          const url = isRunning
            ? state.translatedUrl
            : this.globalTranslateMode === 'translated'
              ? state.translatedUrl
              : pageUrl.originalUrl;
          this.adapter.applyImageByKey?.(pageUrl.key, url);
        }
      }

      this.renderReadingModeBar();
    }

  private renderReadingModeBar(): void {
      const bar = this.readingBarUi;
      if (!bar) return;

      const totalPages = this.allPageUrls.length;

      if (this.translateAllRunning) {
        // Hide current-page button during translate-all
        bar.translateCurrentBtn.style.display = 'none';
      } else {
        bar.translateCurrentBtn.style.display = '';
      }

      // --- Translate Current Page button state ---
      if (this.translateCurrentRunning) {
        bar.translateCurrentBtn.dataset.status = 'running';
        bar.translateCurrentBtn.disabled = true;
      } else {
        bar.translateCurrentBtn.dataset.status = '';
        bar.translateCurrentBtn.disabled = false;

        // After individual translation, button becomes toggle
        const visiblePages = this.adapter.getVisiblePages?.() ?? [];
        const allTranslated = visiblePages.length > 0 && visiblePages.every((p) => {
          const s = this.stateStore.get(p.key);
          return s?.translatedUrl;
        });
        if (allTranslated && this.globalTranslateMode === 'translated') {
          (bar.translateCurrentBtn.querySelector('.mt-x-label') as HTMLElement).textContent = '显示原图';
        } else if (allTranslated && this.globalTranslateMode === 'original') {
          (bar.translateCurrentBtn.querySelector('.mt-x-label') as HTMLElement).textContent = '显示译图';
        } else {
          (bar.translateCurrentBtn.querySelector('.mt-x-label') as HTMLElement).textContent = '翻译当前页';
        }
      }

      // --- Translate All button state ---
      if (this.translateAllRunning) {
        bar.translateAllBtn.dataset.status = 'running';
        bar.translateAllBtn.disabled = true;
      } else {
        bar.translateAllBtn.dataset.status = '';
        bar.translateAllBtn.disabled = false;

        // After translate-all, button becomes toggle
        const allHaveTranslation = totalPages > 0 && this.allPageUrls.every((u) => {
          const s = this.stateStore.get(u.key);
          return s?.translatedUrl;
        });
        if (allHaveTranslation) {
          // After translate-all completes, hide current-page button permanently
          bar.translateCurrentBtn.style.display = 'none';
        }
        if (allHaveTranslation && this.globalTranslateMode === 'translated') {
          (bar.translateAllBtn.querySelector('.mt-x-label') as HTMLElement).textContent = '显示原图';
        } else if (allHaveTranslation && this.globalTranslateMode === 'original') {
          (bar.translateAllBtn.querySelector('.mt-x-label') as HTMLElement).textContent = '显示译图';
        } else {
          (bar.translateAllBtn.querySelector('.mt-x-label') as HTMLElement).textContent = '翻译全部';
        }
      }
    }

  private async handleTranslateCurrentClick(): Promise<void> {
      if (this.translateCurrentRunning || this.translateAllRunning) return;

      const visiblePages = this.adapter.getVisiblePages?.() ?? [];
      if (visiblePages.length === 0) return;

      // If all visible pages already translated, toggle mode
      const allTranslated = visiblePages.every((p) => {
        const s = this.stateStore.get(p.key);
        return s?.translatedUrl;
      });
      if (allTranslated) {
        this.globalTranslateMode = this.globalTranslateMode === 'translated' ? 'original' : 'translated';
        for (const page of visiblePages) {
          const state = this.stateStore.get(page.key);
          if (!state) continue;
          const url = this.globalTranslateMode === 'translated' ? state.translatedUrl! : state.originalUrl;
          this.adapter.applyImageByKey?.(page.key, url);
        }
        this.renderReadingModeBar();
        return;
      }

      this.translateCurrentRunning = true;
      this.renderReadingModeBar();

      const total = visiblePages.length;
      for (let i = 0; i < total; i++) {
        const page = visiblePages[i];
        const label = this.readingBarUi?.translateCurrentBtn.querySelector('.mt-x-label') as HTMLElement;
        if (label) label.textContent = `${i + 1}/${total} 准备中`;

        await this.translatePageByUrl(page.key, page.originalUrl, (stageText) => {
          if (label) label.textContent = `${i + 1}/${total} ${stageText}`;
        });
        this.scheduleCoreSync();
      }

      this.translateCurrentRunning = false;
      this.globalTranslateMode = 'translated';
      this.renderReadingModeBar();
    }

  private async handleTranslateAllClick(): Promise<void> {
      if (this.translateAllRunning || this.translateCurrentRunning) return;

      const urls = this.adapter.findAllPageUrls?.() ?? [];
      if (urls.length === 0) return;

      // If all pages already translated, toggle mode
      const allHaveTranslation = urls.every((u) => {
        const s = this.stateStore.get(u.key);
        return s?.translatedUrl;
      });
      if (allHaveTranslation) {
        this.globalTranslateMode = this.globalTranslateMode === 'translated' ? 'original' : 'translated';
        for (const u of urls) {
          const state = this.stateStore.get(u.key);
          if (!state) continue;
          const url = this.globalTranslateMode === 'translated' ? state.translatedUrl! : u.originalUrl;
          this.adapter.applyImageByKey?.(u.key, url);
        }
        this.renderReadingModeBar();
        return;
      }

      this.translateAllRunning = true;
      this.renderReadingModeBar();

      const total = urls.length;
      for (let i = 0; i < total; i++) {
        const u = urls[i];
        const label = this.readingBarUi?.translateAllBtn.querySelector('.mt-x-label') as HTMLElement;
        if (label) label.textContent = `${i + 1}/${total} 准备中`;

        await this.translatePageByUrl(u.key, u.originalUrl, (stageText) => {
          if (label) label.textContent = `${i + 1}/${total} ${stageText}`;
        });
        this.scheduleCoreSync();
      }

      // Cancel the deferred scheduleSync from the last iteration — it would
      // call syncReadingMode which overwrites allPageUrls via findAllPageUrls().
      // If the DOM is in a transitional state, findAllPageUrls() may return empty
      // or inconsistent results, reverting the button to "翻译全部".
      this.cancelCoreSync();
      // Use the URLs we actually translated so allHaveTranslation check is consistent.
      this.allPageUrls = urls;
      this.translateAllRunning = false;
      this.globalTranslateMode = 'translated';
      this.renderReadingModeBar();
    }

  private async translatePageByUrl(
      key: string,
      originalUrl: string,
      onProgress: (stageText: string) => void,
    ): Promise<void> {
      const state = this.stateStore.ensure(key, originalUrl);

      // Skip if already translated
      if (state.translatedUrl) return;

      const jankMonitor = createProgressJankMonitor('reading-mode');
      this.translationRunner.resetStateForPipeline(state);

      let downloadedBlob: Blob | null = null;

      try {
        const runSettings = await this.translationRunner.loadPipelineRunSettings(state);
        if (usesNanoBananaImagePipeline(runSettings.settings)) {
          throw new Error('阅读模式批量暂不支持 Nano Banana，请使用单张图片翻译或切回其他大模型供应商');
        }
        const diagnosticRunId = runSettings.enableDebugLog ? createDiagnosticRunId('run') : undefined;
        const source = await this.translationRunner.downloadImageFile(originalUrl, diagnosticRunId);
        downloadedBlob = source.blob;
        await this.translationRunner.runPipelineFromFile({
          state,
          file: source.file,
          runSettings,
          runStartAt: performance.now(),
          includeElapsedText: false,
          onProgress: (stageText) => {
            jankMonitor.measureUiRender(() => onProgress(stageText));
          },
          jankMonitor,
          diagnosticRunId,
        });
        if (state.translatedUrl) this.adapter.applyImageByKey?.(key, state.translatedUrl);
      } catch (error) {
        finishProgressJankMonitor(jankMonitor);
        const errorMsg = toErrorMessage(error);
        if (downloadedBlob && (errorMsg.includes('未找到文本') || errorMsg.includes('未返回有效识别结果'))) {
          state.translatedUrl = URL.createObjectURL(downloadedBlob);
          state.stageText = '';
          state.errorText = '';
          state.errorDetailCard = undefined;
          state.mode = 'translated';
          state.status = 'translated';
        } else {
          state.status = 'error';
          state.errorText = toErrorMessage(error);
          state.stageText = '';
          clearTimingDisplay(state);
          state.debugLogData = undefined;
        }
        // Don't throw — continue with next page in translate-all loop
      }
    }

  teardown(): void {
      if (this.readingBarUi?.host) {
        this.readingBarUi.host.remove();
      }
      this.readingBarUi = null;
      // Do NOT reset translateAllRunning here — the async translate-all loop
      // continues in the background even after the reading mode bar closes.
      this.translateCurrentRunning = false;
      this.allPageUrls = [];
    }
}
