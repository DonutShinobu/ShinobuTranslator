import {
  readingLogicalPageMemberLimit,
  type ReadingModeAdapter,
  type ReadingModeBarUi,
  type ReadingLogicalPagePlan,
  type ReadingLogicalPageTarget,
  type ReadingPageDiscovery,
  type ReadingPageReference,
  type ReadingPageTarget,
} from '../types';
import { createReadingModeBarUi } from '../ui';
import { resolveImageReferrerPolicy } from '../utils';
import { PhotoStateStore } from '../state/photoStateStore';
import { createInitialPhotoState } from '../state/photoStateStore';
import {
  isRuntimeImageTranslationFailure,
} from '../translation/imageTranslationExecution';
import type {
  ImageTranslationExecutionActivity,
  ImageTranslationExecutionArbiter,
} from '../translation/imageTranslationExecutionArbiter';
import {
  createProgressJankMonitor,
  applyImageTranslationResult,
  startPhotoStateImageTranslation,
} from '../translation/photoStateProjection';

type ReadingOperation =
  | { kind: 'idle' }
  | { kind: 'discovering-all' }
  | { kind: 'translating-current' }
  | { kind: 'translating-all'; total: number; pageIndex: number };

type PageTranslationOutcome =
  | { status: 'translated' | 'skipped' }
  | { status: 'image-failed' | 'runtime-failed' }
  | { status: 'cancelled' };

function discoveryErrorText(discovery: ReadingPageDiscovery | undefined): string {
  if (discovery?.status !== 'incomplete') return '无法获取完整页数，请重试';
  if (discovery.reason === 'page-limit-exceeded') {
    return `正文共 ${discovery.pageCount} 页，翻译全部最多支持 ${discovery.maxPages} 页`;
  }
  if (discovery.reason === 'unsupported-format') {
    return `阅读器格式暂不支持：${discovery.detail}`;
  }
  return '无法获取完整页数，请重试';
}

export class ReadingModeController {
  private readingBarUi: ReadingModeBarUi | null = null;
  private operation: ReadingOperation = { kind: 'idle' };
  private allPageUrls: ReadingPageTarget[] = [];
  private globalTranslateMode: 'original' | 'translated' = 'original';
  private activeActivity: ImageTranslationExecutionActivity | null = null;
  private errorText = '';
  private readingContextKey: string | null = null;
  private suspended = false;
  private readonly resumeWaiters = new Set<() => void>();

  constructor(
    private readonly adapter: ReadingModeAdapter,
    private readonly stateStore: PhotoStateStore,
    private readonly executionArbiter: ImageTranslationExecutionArbiter,
    private readonly scheduleCoreSync: () => void,
    private readonly cancelCoreSync: () => void,
    private readonly createBar: () => ReadingModeBarUi = createReadingModeBarUi,
  ) {}

  sync(): void {
      const nextContextKey = this.adapter.getReadingContextKey();
      if (this.readingContextKey !== null && nextContextKey !== this.readingContextKey) {
        if (this.activeActivity) {
          this.suspend();
          return;
        }
        this.operation = { kind: 'idle' };
        this.allPageUrls = [];
        this.globalTranslateMode = 'original';
        this.errorText = '';
      }
      this.readingContextKey = nextContextKey;

      // Create or re-acquire bottom bar anchor
      const anchor = this.adapter.createBottomBarAnchor();
      if (!anchor) {
        // The reading DOM is transient. Detach the bar but keep submitted work.
        this.suspend();
        return;
      }

      this.resume();

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

      // Reconcile every visible page so an untranslated page also clears a stale projection.
      // During translation loops, always show translated; otherwise respect toggle mode.
      const visiblePages = this.adapter.getVisiblePages();
      for (const page of visiblePages) {
        const state = this.stateStore.get(page.key);
        const translatedUrl = state?.translatedUrl;
        const shouldShowTranslation = Boolean(translatedUrl)
          && (this.operation.kind !== 'idle' || this.globalTranslateMode === 'translated');
        this.adapter.applyImageByKey(
          page.key,
          shouldShowTranslation && translatedUrl ? translatedUrl : page.originalUrl,
        );
      }

      this.renderReadingModeBar();
    }

  private renderReadingModeBar(): void {
      const bar = this.readingBarUi;
      if (!bar) return;

      const totalPages = this.allPageUrls.length;
      bar.errorLine.textContent = this.errorText;
      if (this.errorText) {
        bar.errorLine.dataset.variant = 'error';
      } else {
        delete bar.errorLine.dataset.variant;
      }

      if (this.operation.kind === 'translating-all') {
        // Hide current-page button during translate-all
        bar.translateCurrentBtn.style.display = 'none';
      } else {
        bar.translateCurrentBtn.style.display = '';
      }

      // --- Translate Current Page button state ---
      if (this.operation.kind === 'translating-current') {
        bar.translateCurrentBtn.dataset.status = 'running';
        bar.translateCurrentBtn.disabled = true;
      } else {
        bar.translateCurrentBtn.dataset.status = '';
        bar.translateCurrentBtn.disabled = false;

        // After individual translation, button becomes toggle
        const visiblePages = this.adapter.getVisiblePages();
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
      if (this.operation.kind === 'discovering-all' || this.operation.kind === 'translating-all') {
        bar.translateAllBtn.dataset.status = 'running';
        bar.translateAllBtn.disabled = true;
        if (this.operation.kind === 'discovering-all') {
          (bar.translateAllBtn.querySelector('.mt-x-label') as HTMLElement).textContent = '正在获取页数…';
        }
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
          (bar.translateAllBtn.querySelector('.mt-x-label') as HTMLElement).textContent = this.errorText
            ? '重试翻译全部'
            : '翻译全部';
        }
      }
    }

  private async handleTranslateCurrentClick(): Promise<void> {
      if (this.operation.kind !== 'idle') return;

      const visiblePages = this.adapter.getVisiblePages();
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
          this.adapter.applyImageByKey(page.key, url);
        }
        this.renderReadingModeBar();
        return;
      }

      const activity = this.beginActivity();
      if (!activity) return;
      this.operation = { kind: 'translating-current' };
      this.renderReadingModeBar();

      try {
        const total = visiblePages.length;
        for (let i = 0; i < total; i++) {
          if (this.operation.kind !== 'translating-current') break;
          if (!await this.waitUntilResumed(activity)) return;
          const page = visiblePages[i];
          const label = this.readingBarUi?.translateCurrentBtn.querySelector('.mt-x-label') as HTMLElement;
          if (label) label.textContent = `${i + 1}/${total} 准备中`;

          const outcome = await this.translatePage(activity, page, (stageText) => {
            if (label) label.textContent = `${i + 1}/${total} ${stageText}`;
          });
          if (outcome.status === 'cancelled' || outcome.status === 'runtime-failed') {
            this.operation = { kind: 'idle' };
            this.renderReadingModeBar();
            return;
          }
          if (this.operation.kind !== 'translating-current') break;
          this.scheduleCoreSync();
        }

        if (this.operation.kind !== 'translating-current') return;
        this.operation = { kind: 'idle' };
        this.globalTranslateMode = 'translated';
        this.renderReadingModeBar();
      } finally {
        this.finishActivity(activity);
      }
    }

  private async handleTranslateAllClick(): Promise<void> {
      if (this.operation.kind !== 'idle') return;

      const activity = this.beginActivity();
      if (!activity) return;
      this.errorText = '';
      this.operation = { kind: 'discovering-all' };
      this.renderReadingModeBar();

      let discovery;
      try {
        discovery = await this.adapter.discoverReadingPages(activity.signal);
      } catch {
        discovery = undefined;
      }
      if (activity.signal.aborted || this.operation.kind !== 'discovering-all') {
        this.finishActivity(activity);
        return;
      }
      if (!discovery || discovery.status !== 'complete') {
        this.operation = { kind: 'idle' };
        this.errorText = discoveryErrorText(discovery);
        this.renderReadingModeBar();
        this.finishActivity(activity);
        return;
      }
      const urls = [...discovery.pages];
      this.allPageUrls = urls;
      if (!await this.waitUntilResumed(activity)) {
        this.finishActivity(activity);
        return;
      }

      // If all pages already translated, toggle mode
      const allHaveTranslation = urls.every((page) => {
        const s = this.stateStore.get(page.key);
        return s?.translatedUrl;
      });
      if (allHaveTranslation) {
        this.operation = { kind: 'idle' };
        this.globalTranslateMode = this.globalTranslateMode === 'translated' ? 'original' : 'translated';
        for (const page of urls) {
          const state = this.stateStore.get(page.key);
          if (!state) continue;
          const url = this.globalTranslateMode === 'translated'
            ? state.translatedUrl!
            : page.originalUrl;
          this.adapter.applyImageByKey(page.key, url);
        }
        this.renderReadingModeBar();
        this.finishActivity(activity);
        return;
      }

      let logicalPagePlan: ReadingLogicalPagePlan = {
        pages: urls.map((page) => ({ ...page, members: [page] })),
      };
      if (this.adapter.planReadingLogicalPages) {
        try {
          const label = this.readingBarUi?.translateAllBtn.querySelector('.mt-x-label') as HTMLElement;
          if (label) label.textContent = '正在检测分页…';
          logicalPagePlan = await this.adapter.planReadingLogicalPages(urls, activity.signal);
          this.assertLogicalPagePlan(urls, logicalPagePlan);
        } catch (error) {
          if (activity.signal.aborted) {
            this.finishActivity(activity);
            return;
          }
          this.operation = { kind: 'idle' };
          this.errorText = error instanceof Error ? error.message : String(error);
          this.renderReadingModeBar();
          this.finishActivity(activity);
          return;
        }
      }

      this.operation = { kind: 'translating-all', total: urls.length, pageIndex: 0 };
      this.renderReadingModeBar();

      try {
        const total = urls.length;
        const pendingUrls = logicalPagePlan.pages.filter((page) => page.members.some(
          (member) => !this.stateStore.get(member.key)?.translatedUrl,
        ));
        const imageFailures: Array<{ pageIndex: number }> = [];
        for (const page of pendingUrls) {
          if (this.operation.kind !== 'translating-all') break;
          if (!await this.waitUntilResumed(activity)) return;
          this.operation = { kind: 'translating-all', total, pageIndex: page.pageIndex };
          const label = this.readingBarUi?.translateAllBtn.querySelector('.mt-x-label') as HTMLElement;
          if (label) label.textContent = `${page.pageIndex + 1}/${total} 准备中`;

          const outcome = await this.translatePage(activity, page, (stageText) => {
            if (label) label.textContent = `${page.pageIndex + 1}/${total} ${stageText}`;
          });
          if (outcome.status === 'cancelled') {
            this.operation = { kind: 'idle' };
            this.renderReadingModeBar();
            return;
          }
          if (outcome.status === 'runtime-failed') {
            const completed = this.countCompletedPages(urls);
            this.operation = { kind: 'idle' };
            this.globalTranslateMode = completed > 0 ? 'translated' : this.globalTranslateMode;
            this.errorText = `已完成 ${completed}/${total}：流水线运行环境不可用，请检查设置后重试`;
            this.renderReadingModeBar();
            return;
          }
          if (outcome.status === 'image-failed') {
            imageFailures.push({ pageIndex: page.pageIndex });
            continue;
          }
          if (this.operation.kind !== 'translating-all') break;
          this.scheduleCoreSync();
        }

        if (this.operation.kind !== 'translating-all') return;
        if (imageFailures.length > 0) {
          const completed = this.countCompletedPages(urls);
          const failedPages = imageFailures.map(({ pageIndex }) => pageIndex + 1).join('、');
          this.operation = { kind: 'idle' };
          this.globalTranslateMode = completed > 0 ? 'translated' : this.globalTranslateMode;
          this.errorText = `已完成 ${completed}/${total}；第 ${failedPages} 页失败：图片翻译失败，请重试`;
          this.renderReadingModeBar();
          return;
        }

        // The last translated page may have queued a controller-wide sync. Cancel
        // that stale callback before committing the final all-pages UI state.
        this.cancelCoreSync();
        this.allPageUrls = urls;
        this.operation = { kind: 'idle' };
        this.globalTranslateMode = 'translated';
        this.errorText = '';
        this.renderReadingModeBar();
      } finally {
        this.finishActivity(activity);
      }
    }

  private async translatePage(
      activity: ImageTranslationExecutionActivity,
      page: ReadingPageReference | ReadingLogicalPageTarget,
      onProgress: (stageText: string) => void,
    ): Promise<PageTranslationOutcome> {
      const members = 'members' in page ? page.members : [page];
      const primary = members[0];
      const state = this.stateStore.ensure(primary.key, primary.originalUrl);

      // Skip if already translated
      if (members.every((member) => this.stateStore.get(member.key)?.translatedUrl)) {
        return { status: 'skipped' };
      }

      const releaseStates = members.map((member) => this.stateStore.protect(member.key));

      let request;
      try {
        request = this.adapter.prepareReadingPage
          ? await this.adapter.prepareReadingPage(page, activity.signal)
          : {
              source: {
                kind: 'remote-image' as const,
                url: primary.originalUrl,
                referrerPolicy: resolveImageReferrerPolicy(),
              },
            };
      } catch {
        for (const release of releaseStates) release();
        return activity.signal.aborted
          ? { status: 'cancelled' }
          : { status: 'image-failed' };
      }
      const grouped = members.length > 1;
      const projectionState = grouped
        ? createInitialPhotoState(page.originalUrl)
        : state;
      const jankMonitor = createProgressJankMonitor('reading-mode');
      const task = startPhotoStateImageTranslation({
        executionModule: activity,
        request: {
          ...request,
          allowedKinds: ['local-pipeline'],
        },
        state: projectionState,
        includeElapsedText: false,
        jankMonitor,
        onChange: () => onProgress(projectionState.stageText),
      });
      try {
        const outcome = await task.result;
        if (grouped) {
          if (!this.adapter.splitReadingLogicalPageResult) {
            throw new Error('阅读器未提供逻辑页结果裁切能力');
          }
          const slices = await this.adapter.splitReadingLogicalPageResult(
            page as ReadingLogicalPageTarget,
            outcome.execution.image,
            outcome.execution.kind === 'local-pipeline' ? outcome.execution.debug : undefined,
            activity.signal,
          );
          this.assertLogicalPageSlices(page as ReadingLogicalPageTarget, slices);
          if (outcome.execution.kind !== 'local-pipeline') {
            throw new Error('逻辑页结果必须来自本地图片流水线');
          }
          for (const slice of slices) {
            const memberState = this.stateStore.ensure(slice.page.key, slice.page.originalUrl);
            applyImageTranslationResult(memberState, {
              ...outcome.execution,
              image: slice.image,
              debug: slice.debug,
            }, { includeElapsedText: false });
            if (memberState.translatedUrl) {
              this.adapter.applyImageByKey(slice.page.key, memberState.translatedUrl);
            }
          }
        } else if (state.translatedUrl) {
          this.adapter.applyImageByKey(primary.key, state.translatedUrl);
        }
        return { status: 'translated' };
      } catch (error) {
        if (activity.signal.aborted) return { status: 'cancelled' };
        return {
          status: isRuntimeImageTranslationFailure(error) ? 'runtime-failed' : 'image-failed',
        };
      } finally {
        if (grouped) {
          if (projectionState.translatedUrl) URL.revokeObjectURL(projectionState.translatedUrl);
          if (projectionState.debugOriginalUrl) URL.revokeObjectURL(projectionState.debugOriginalUrl);
        }
        for (const release of releaseStates) release();
      }
    }

  private assertLogicalPagePlan(
    sourcePages: readonly ReadingPageTarget[],
    plan: ReadingLogicalPagePlan,
  ): void {
    const plannedMembers = plan.pages.flatMap((page) => page.members);
    if (
      plannedMembers.length !== sourcePages.length
      || plannedMembers.some((page, index) => page.key !== sourcePages[index].key)
      || plan.pages.some((page) => (
        page.members.length < 1 || page.members.length > readingLogicalPageMemberLimit
      ))
    ) {
      throw new Error('阅读器返回了无效的逻辑分页计划');
    }
  }

  private assertLogicalPageSlices(
    page: ReadingLogicalPageTarget,
    slices: readonly { page: ReadingPageTarget }[],
  ): void {
    if (
      slices.length !== page.members.length
      || slices.some((slice, index) => slice.page.key !== page.members[index].key)
    ) {
      throw new Error('阅读器返回了无效的逻辑页裁切结果');
    }
  }

  private countCompletedPages(pages: readonly ReadingPageTarget[]): number {
      return pages.reduce((count, page) => (
        this.stateStore.get(page.key)?.translatedUrl ? count + 1 : count
      ), 0);
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
      if (this.suspended) this.scheduleCoreSync();
    }

  suspend(): void {
      if (this.readingBarUi?.host) this.readingBarUi.host.remove();
      this.readingBarUi = null;
      this.suspended = true;
    }

  private resume(): void {
      if (!this.suspended) return;
      this.suspended = false;
      for (const resume of [...this.resumeWaiters]) resume();
      this.resumeWaiters.clear();
    }

  private waitUntilResumed(
    activity: ImageTranslationExecutionActivity,
  ): Promise<boolean> {
    if (!this.suspended) return Promise.resolve(!activity.signal.aborted);
    if (activity.signal.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const finish = (): void => {
        this.resumeWaiters.delete(onResume);
        activity.signal.removeEventListener('abort', onAbort);
      };
      const onResume = (): void => {
        finish();
        resolve(true);
      };
      const onAbort = (): void => {
        finish();
        resolve(false);
      };
      this.resumeWaiters.add(onResume);
      activity.signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  teardown(): void {
      if (this.readingBarUi?.host) {
        this.readingBarUi.host.remove();
      }
      this.activeActivity?.end('阅读模式已关闭');
      this.activeActivity = null;
      this.readingBarUi = null;
      this.operation = { kind: 'idle' };
      this.allPageUrls = [];
      this.errorText = '';
      this.readingContextKey = null;
      this.suspended = false;
      for (const resume of [...this.resumeWaiters]) resume();
      this.resumeWaiters.clear();
    }
}
