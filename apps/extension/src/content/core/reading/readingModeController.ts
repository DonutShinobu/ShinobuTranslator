import type { ReadingModeBarUi, SiteAdapter, UrlTarget } from '../types';
import { createReadingModeBarUi } from '../ui';
import { resolveImageReferrerPolicy } from '../utils';
import { PhotoStateStore } from '../state/photoStateStore';
import {
  isRuntimeImageTranslationFailure,
} from '../translation/imageTranslationExecution';
import type {
  ImageTranslationExecutionActivity,
  ImageTranslationExecutionArbiter,
} from '../translation/imageTranslationExecutionArbiter';
import {
  createProgressJankMonitor,
  startPhotoStateImageTranslation,
} from '../translation/photoStateProjection';

export class ReadingModeController {
  private readingBarUi: ReadingModeBarUi | null = null;
  private translateAllRunning = false;
  private translateCurrentRunning = false;
  private allPageUrls: UrlTarget[] = [];
  private globalTranslateMode: 'original' | 'translated' = 'original';
  private activeActivity: ImageTranslationExecutionActivity | null = null;

  constructor(
    private readonly adapter: SiteAdapter,
    private readonly stateStore: PhotoStateStore,
    private readonly executionArbiter: ImageTranslationExecutionArbiter,
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

      const activity = this.beginActivity();
      if (!activity) return;
      this.translateCurrentRunning = true;
      this.renderReadingModeBar();

      try {
        const total = visiblePages.length;
        for (let i = 0; i < total; i++) {
          if (!this.translateCurrentRunning) break;
          const page = visiblePages[i];
          const label = this.readingBarUi?.translateCurrentBtn.querySelector('.mt-x-label') as HTMLElement;
          if (label) label.textContent = `${i + 1}/${total} 准备中`;

          await this.translatePageByUrl(activity, page.key, page.originalUrl, (stageText) => {
            if (label) label.textContent = `${i + 1}/${total} ${stageText}`;
          });
          if (!this.translateCurrentRunning) break;
          this.scheduleCoreSync();
        }

        if (!this.translateCurrentRunning) return;
        this.translateCurrentRunning = false;
        this.globalTranslateMode = 'translated';
        this.renderReadingModeBar();
      } finally {
        this.finishActivity(activity);
      }
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

      const activity = this.beginActivity();
      if (!activity) return;
      this.translateAllRunning = true;
      this.renderReadingModeBar();

      try {
        const total = urls.length;
        for (let i = 0; i < total; i++) {
          if (!this.translateAllRunning) break;
          const u = urls[i];
          const label = this.readingBarUi?.translateAllBtn.querySelector('.mt-x-label') as HTMLElement;
          if (label) label.textContent = `${i + 1}/${total} 准备中`;

          await this.translatePageByUrl(activity, u.key, u.originalUrl, (stageText) => {
            if (label) label.textContent = `${i + 1}/${total} ${stageText}`;
          });
          if (!this.translateAllRunning) break;
          this.scheduleCoreSync();
        }

        if (!this.translateAllRunning) return;
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
      } finally {
        this.finishActivity(activity);
      }
    }

  private async translatePageByUrl(
      activity: ImageTranslationExecutionActivity,
      key: string,
      originalUrl: string,
      onProgress: (stageText: string) => void,
    ): Promise<void> {
      const state = this.stateStore.ensure(key, originalUrl);

      // Skip if already translated
      if (state.translatedUrl) return;

      const jankMonitor = createProgressJankMonitor('reading-mode');
      const task = startPhotoStateImageTranslation({
        executionModule: activity,
        request: {
          source: {
            kind: 'remote-image',
            url: originalUrl,
            referrerPolicy: resolveImageReferrerPolicy(),
          },
          allowedKinds: ['local-pipeline'],
        },
        state,
        includeElapsedText: false,
        jankMonitor,
        onChange: () => onProgress(state.stageText),
      });
      try {
        await task.result;
        if (state.translatedUrl) this.adapter.applyImageByKey?.(key, state.translatedUrl);
      } catch (error) {
        if (activity.signal.aborted || isRuntimeImageTranslationFailure(error)) {
          this.translateAllRunning = false;
          this.translateCurrentRunning = false;
          this.renderReadingModeBar();
        }
        // Image-local failures are skipped; runtime failures stop further admissions.
      }
    }

  private beginActivity(): ImageTranslationExecutionActivity | null {
      const admission = this.executionArbiter.begin({
        owner: 'reading-mode',
        origin: 'explicit',
      });
      if (admission.status !== 'active') return null;
      this.activeActivity = admission.activity;
      return admission.activity;
    }

  private finishActivity(activity: ImageTranslationExecutionActivity): void {
      if (this.activeActivity === activity) this.activeActivity = null;
      activity.end();
    }

  teardown(): void {
      if (this.readingBarUi?.host) {
        this.readingBarUi.host.remove();
      }
      this.activeActivity?.end('阅读模式已关闭');
      this.activeActivity = null;
      this.readingBarUi = null;
      this.translateAllRunning = false;
      this.translateCurrentRunning = false;
      this.allPageUrls = [];
    }
}
