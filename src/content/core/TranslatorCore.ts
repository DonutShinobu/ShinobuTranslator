import {
  validateSettings,
  toPipelineConfig,
} from '../../shared/config';
import type { ExtensionSettings } from '../../shared/config';
import type {
  ImageTarget,
  PhotoState,
  PipelineArtifacts,
  PipelineProgress,
  ReadingModeBarUi,
  SiteAdapter,
  TextRegion,
  TypesetDebugDownloadData,
  UrlTarget,
  OcrRegionLogItem,
  ModelRegionLogItem,
} from './types';
import { sendRuntimeMessage } from '../../shared/messages';
import {
  base64ToBlob,
  canvasToBlob,
  formatElapsedText,
  inferFileExtension,
  toErrorMessage,
} from './utils';
import {
  createUiElements,
  createReadingModeBarUi,
  createScreenshotResultUi,
  handleDebugDownload,
  injectStyles,
  renderScreenshotResultUi,
  renderUi,
  requestScreenshotSelection,
} from './ui';
import type { ScreenshotResultUiElements, UiElements } from './ui';
import { cropScreenshotToFile } from './screenshot';
import type { ScreenshotSelection } from './screenshot';

const photoStateCacheLimit = 200;

const stageLabelMap: Record<string, string> = {
  load: '加载图片',
  preload: '加载模型',
  detect: '文本检测',
  ocr: '文字识别',
  merge: '合并文本',
  order: '文本排序',
  parallel: '并行处理',
  translate: '翻译文本',
  mask_refine: '细化遮罩',
  inpaint: '去除文字',
  bubble: '气泡检测',
  typeset: '文字排版',
  done: '完成',
};

function validateActiveSettings(settings: ExtensionSettings): string | null {
  const baseError = validateSettings(settings);
  if (baseError) return baseError;
  return null;
}

function createInitialState(originalUrl: string): PhotoState {
  return {
    status: 'idle',
    mode: 'original',
    originalUrl,
    translatedUrl: undefined,
    debugOriginalUrl: undefined,
    debugLogData: undefined,
    showTypesetDebug: false,
    showEraseDebug: false,
    stageText: '',
    elapsedText: '',
    errorText: '',
  };
}

function cloneTextRegionBox(region: TextRegion): TextRegion['box'] {
  return { ...region.box };
}

function cloneTextRegionQuad(region: TextRegion): TextRegion['quad'] {
  if (!region.quad) return undefined;
  return region.quad.map((point) => ({ x: point.x, y: point.y })) as TextRegion['quad'];
}

function toTypesetDebugDownloadData(
  pageUrl: string,
  sourceImageUrl: string,
  artifacts: PipelineArtifacts,
): TypesetDebugDownloadData | undefined {
  if (!artifacts.typesetDebugLog) return undefined;
  const ocrRegions: OcrRegionLogItem[] = artifacts.detectedRegions.map((region) => ({
    regionId: region.id,
    direction: region.direction,
    box: cloneTextRegionBox(region),
    quad: cloneTextRegionQuad(region),
    sourceText: region.sourceText,
    fgColor: region.fgColor,
    bgColor: region.bgColor,
  }));
  const modelRegions: ModelRegionLogItem[] = artifacts.detectedRegions.map((region) => ({
    regionId: region.id,
    translatedTextRaw: region.translatedText,
    translatedColumnsRaw: region.translatedColumns ? [...region.translatedColumns] : [],
  }));
  return {
    exportedAt: new Date().toISOString(),
    pageUrl,
    sourceImageUrl,
    stageTimings: artifacts.stageTimings.map((t) => ({ ...t })),
    runtimeStages: artifacts.runtimeStages.map((s) => ({ ...s })),
    translationDebug: artifacts.translationDebug ? { ...artifacts.translationDebug } : null,
    ocrDebug: artifacts.ocrDebug
      ? {
          ...artifacts.ocrDebug,
          preprocessPerRegionMs: artifacts.ocrDebug.preprocessPerRegionMs.map((i) => ({ ...i })),
          chunks: artifacts.ocrDebug.chunks.map((chunk) => ({
            ...chunk,
            regionIds: [...chunk.regionIds],
            decodeSteps: chunk.decodeSteps.map((s) => ({ ...s })),
            fallbackRegions: chunk.fallbackRegions.map((r) => ({ ...r })),
          })),
          colorFallbackRegions: artifacts.ocrDebug.colorFallbackRegions.map((r) => ({ ...r })),
        }
      : null,
    ocrRegions,
    modelRegions,
    typeset: artifacts.typesetDebugLog,
  };
}

type MountedImage = {
  key: string;
  target: ImageTarget;
  ui: UiElements;
};

type PipelineRunSettings = {
  settings: ExtensionSettings;
  showElapsedTime: boolean;
  showStageTimingDetails: boolean;
  showRuntimeStages: boolean;
  showTypesetDebug: boolean;
  enableDebugLog: boolean;
};

let runPipelineLoader: Promise<typeof import('../../pipeline/orchestrator')> | null = null;

async function getRunPipeline(): Promise<typeof import('../../pipeline/orchestrator')['runPipeline']> {
  if (!runPipelineLoader) {
    runPipelineLoader = import('../../pipeline/orchestrator');
  }
  const module = await runPipelineLoader;
  return module.runPipeline;
}

function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

export class TranslatorCore {
  private adapter: SiteAdapter;
  private states = new Map<string, PhotoState>();
  private mounted = new Map<string, MountedImage>();
  private disposeObserver: (() => void) | null = null;
  private syncTimer: number | null = null;
  private screenshotSelectionRunning = false;

  // Reading mode state
  private readingBarUi: ReadingModeBarUi | null = null;
  private translateAllRunning = false;
  private translateCurrentRunning = false;
  private allPageUrls: UrlTarget[] = [];
  private globalTranslateMode: 'original' | 'translated' = 'original';

  constructor(adapter: SiteAdapter) {
    this.adapter = adapter;
  }

  stop(): void {
    if (this.disposeObserver) {
      this.disposeObserver();
      this.disposeObserver = null;
    }
    if (this.syncTimer !== null) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.teardownReadingBar();
  }

  start(): void {
    injectStyles();
    this.disposeObserver = this.adapter.observe(() => this.scheduleSync());
    this.sync();
  }

  private scheduleSync(): void {
    if (this.syncTimer !== null) return;
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      this.sync();
    }, 100);
  }

  private sync(): void {
    if (this.adapter.isReadingMode?.()) {
      this.syncReadingMode();
      return;
    }

    // Not in reading mode — clean up reading bar if it was previously shown.
    this.teardownReadingBar();

    const targets = this.adapter.findImages();
    const currentKeys = new Set(targets.map((t) => t.key));

    for (const [key, mounted] of this.mounted) {
      if (!currentKeys.has(key)) {
        mounted.ui.host.remove();
        this.mounted.delete(key);
      }
    }

    for (const target of targets) {
      if (this.mounted.has(target.key)) continue;
      const anchor = this.adapter.createUiAnchor(target);
      const ui = createUiElements();
      anchor.appendChild(ui.host);

      ui.button.addEventListener('click', () => {
        void this.handleTranslateClick(target);
      });
      ui.debugDownloadButton.addEventListener('click', () => {
        const state = this.states.get(target.key);
        if (state) handleDebugDownload(state);
      });

      this.mounted.set(target.key, { key: target.key, target, ui });
      const state = this.ensureState(target.key, target.originalUrl);
      renderUi(ui, state);
    }
  }

  private ensureState(key: string, originalUrl: string): PhotoState {
    const existing = this.states.get(key);
    if (existing) return existing;
    const state = createInitialState(originalUrl);
    this.states.set(key, state);
    this.trimStateCache(key);
    return state;
  }

  private trimStateCache(protectedKey: string): void {
    while (this.states.size > photoStateCacheLimit) {
      const oldestKey = this.states.keys().next().value as string | undefined;
      if (!oldestKey || oldestKey === protectedKey) break;
      const state = this.states.get(oldestKey);
      if (state) this.disposeState(state);
      this.states.delete(oldestKey);
    }
  }

  private disposeState(state: PhotoState): void {
    if (state.translatedUrl) {
      URL.revokeObjectURL(state.translatedUrl);
      state.translatedUrl = undefined;
    }
    if (state.debugOriginalUrl) {
      URL.revokeObjectURL(state.debugOriginalUrl);
      state.debugOriginalUrl = undefined;
    }
    state.debugLogData = undefined;
  }

  private renderForKey(key: string): void {
    const mounted = this.mounted.get(key);
    if (!mounted) return;
    const state = this.states.get(key) ?? null;
    renderUi(mounted.ui, state);
  }

  private resetStateForPipeline(state: PhotoState): void {
    state.status = 'running';
    state.mode = 'original';
    state.errorText = '';
    state.elapsedText = '';
    state.debugLogData = undefined;
    state.stageText = '准备中';
  }

  private async loadPipelineRunSettings(state: PhotoState): Promise<PipelineRunSettings> {
    const settingsResponse = await sendRuntimeMessage({ type: 'mt:get-settings' });
    if (!settingsResponse.ok || settingsResponse.type !== 'mt:get-settings') {
      throw new Error(settingsResponse.ok ? '读取配置失败' : settingsResponse.error);
    }
    const validationError = validateActiveSettings(settingsResponse.settings);
    if (validationError) throw new Error(validationError);

    const settings = settingsResponse.settings;
    const showElapsedTime = settings.showElapsedTime === true;
    const showStageTimingDetails = showElapsedTime && settings.showStageTimingDetails === true;
    const showRuntimeStages = showStageTimingDetails;
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
      showTypesetDebug,
      enableDebugLog,
    };
  }

  private async downloadImageFile(originalUrl: string): Promise<{
    file: File;
    blob: Blob;
  }> {
    const downloadResponse = await sendRuntimeMessage({
      type: 'mt:download-image',
      imageUrl: originalUrl,
    });
    if (!downloadResponse.ok || downloadResponse.type !== 'mt:download-image') {
      throw new Error(downloadResponse.ok ? '下载图片失败' : downloadResponse.error);
    }

    const blob = base64ToBlob(downloadResponse.base64, downloadResponse.contentType);
    const suffix = inferFileExtension(downloadResponse.contentType, downloadResponse.sourceUrl);
    const file = new File([blob], `source.${suffix}`, { type: blob.type || 'image/jpeg' });
    return {
      file,
      blob,
    };
  }

  private updatePipelineProgress(
    state: PhotoState,
    progress: PipelineProgress,
    onProgress: (stageText: string) => void,
  ): void {
    const stageLabel = stageLabelMap[progress.stage] ?? progress.stage;
    if (progress.stage === 'parallel') {
      state.stageText = progress.detail;
    } else if (progress.stage === 'done') {
      state.stageText = '完成';
    } else {
      state.stageText = `${stageLabel}中`;
    }
    onProgress(state.stageText);
  }

  private async runPipelineFromFile(options: {
    state: PhotoState;
    file: File;
    runSettings: PipelineRunSettings;
    runStartAt: number;
    includeElapsedText: boolean;
    onProgress: (stageText: string) => void;
  }): Promise<void> {
    const { state, file, runSettings, runStartAt, includeElapsedText, onProgress } = options;
    const runPipeline = await getRunPipeline();
    const artifacts = await runPipeline(file, toPipelineConfig(runSettings.settings), (progress: PipelineProgress) => {
      this.updatePipelineProgress(state, progress, onProgress);
    });

    const translatedBlob = await canvasToBlob(artifacts.resultCanvas as HTMLCanvasElement);
    const translatedUrl = URL.createObjectURL(translatedBlob);
    if (state.translatedUrl) URL.revokeObjectURL(state.translatedUrl);
    if (state.debugOriginalUrl) {
      URL.revokeObjectURL(state.debugOriginalUrl);
      state.debugOriginalUrl = undefined;
    }
    if (runSettings.showTypesetDebug && artifacts.debugOriginalCanvas) {
      const debugBlob = await canvasToBlob(artifacts.debugOriginalCanvas as HTMLCanvasElement);
      state.debugOriginalUrl = URL.createObjectURL(debugBlob);
    }
    const sourceImageDataUrl = runSettings.enableDebugLog
      ? (() => {
          const c = document.createElement('canvas');
          c.width = artifacts.original.naturalWidth;
          c.height = artifacts.original.naturalHeight;
          const ctx = c.getContext('2d');
          if (ctx) ctx.drawImage(artifacts.original as CanvasImageSource, 0, 0);
          return c.toDataURL('image/png');
        })()
      : state.originalUrl;
    state.debugLogData = runSettings.enableDebugLog
      ? toTypesetDebugDownloadData(window.location.href, sourceImageDataUrl, artifacts)
      : undefined;

    state.translatedUrl = translatedUrl;
    const totalDurationMs = performance.now() - runStartAt;
    state.elapsedText = includeElapsedText && runSettings.showElapsedTime
      ? formatElapsedText(
          totalDurationMs,
          artifacts.stageTimings,
          artifacts.runtimeStages,
          runSettings.showStageTimingDetails,
          runSettings.showRuntimeStages,
          artifacts.translationDebug,
        )
      : '';
    state.stageText = '';
    state.errorText = '';
    state.mode = 'translated';
    state.status = 'translated';
  }

  private async handleTranslateClick(target: ImageTarget): Promise<void> {
    const { key } = target;
    const state = this.ensureState(key, target.originalUrl);

    if (state.status === 'running') return;

    if (state.translatedUrl) {
      if (state.mode === 'translated') {
        state.mode = 'original';
        state.status = 'showingOriginal';
        this.adapter.applyImage(target, state.originalUrl);
      } else {
        state.mode = 'translated';
        state.status = 'translated';
        this.adapter.applyImage(target, state.translatedUrl);
      }
      this.renderForKey(key);
      return;
    }

    this.resetStateForPipeline(state);
    const runStartAt = performance.now();
    this.renderForKey(key);

    try {
      const runSettings = await this.loadPipelineRunSettings(state);
      const source = await this.downloadImageFile(state.originalUrl);
      await this.runPipelineFromFile({
        state,
        file: source.file,
        runSettings,
        runStartAt,
        includeElapsedText: true,
        onProgress: () => {
          this.renderForKey(key);
        },
      });
      if (state.translatedUrl) this.adapter.applyImage(target, state.translatedUrl);
      this.renderForKey(key);
    } catch (error) {
      state.status = 'error';
      state.errorText = toErrorMessage(error);
      state.stageText = '';
      state.elapsedText = '';
      state.debugLogData = undefined;
      this.renderForKey(key);
    }
  }

  // --- Reading mode ------------------------------------------------------------

  private syncReadingMode(): void {
    // Create or re-acquire bottom bar anchor
    const anchor = this.adapter.createBottomBarAnchor?.();
    if (!anchor) {
      // Bottom bar not yet available — tear down and wait for next sync.
      this.teardownReadingBar();
      return;
    }

    // Create bar UI if not yet mounted
    if (!this.readingBarUi || !this.readingBarUi.host.isConnected) {
      this.readingBarUi = createReadingModeBarUi();
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
      const state = this.states.get(pageUrl.key);
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
        const s = this.states.get(p.key);
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
        const s = this.states.get(u.key);
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
      const s = this.states.get(p.key);
      return s?.translatedUrl;
    });
    if (allTranslated) {
      this.globalTranslateMode = this.globalTranslateMode === 'translated' ? 'original' : 'translated';
      for (const page of visiblePages) {
        const state = this.states.get(page.key);
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
      this.scheduleSync();
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
      const s = this.states.get(u.key);
      return s?.translatedUrl;
    });
    if (allHaveTranslation) {
      this.globalTranslateMode = this.globalTranslateMode === 'translated' ? 'original' : 'translated';
      for (const u of urls) {
        const state = this.states.get(u.key);
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
      this.scheduleSync();
    }

    // Cancel the deferred scheduleSync from the last iteration — it would
    // call syncReadingMode which overwrites allPageUrls via findAllPageUrls().
    // If the DOM is in a transitional state, findAllPageUrls() may return empty
    // or inconsistent results, reverting the button to "翻译全部".
    if (this.syncTimer !== null) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    // Use the URLs we actually translated so allHaveTranslation check is consistent.
    this.allPageUrls = urls;
    this.translateAllRunning = false;
    this.globalTranslateMode = 'translated';
    this.renderReadingModeBar();
  }

  /** Shared translation pipeline — downloads image, runs pipeline, stores state. */
  private async translatePageByUrl(
    key: string,
    originalUrl: string,
    onProgress: (stageText: string) => void,
  ): Promise<void> {
    const state = this.ensureState(key, originalUrl);

    // Skip if already translated
    if (state.translatedUrl) return;

    this.resetStateForPipeline(state);

    let downloadedBlob: Blob | null = null;

    try {
      const runSettings = await this.loadPipelineRunSettings(state);
      const source = await this.downloadImageFile(originalUrl);
      downloadedBlob = source.blob;
      await this.runPipelineFromFile({
        state,
        file: source.file,
        runSettings,
        runStartAt: performance.now(),
        includeElapsedText: false,
        onProgress,
      });
      if (state.translatedUrl) this.adapter.applyImageByKey?.(key, state.translatedUrl);
    } catch (error) {
      const errorMsg = toErrorMessage(error);
      if (downloadedBlob && (errorMsg.includes('未找到文本') || errorMsg.includes('未返回有效识别结果'))) {
        state.translatedUrl = URL.createObjectURL(downloadedBlob);
        state.stageText = '';
        state.errorText = '';
        state.mode = 'translated';
        state.status = 'translated';
      } else {
        state.status = 'error';
        state.errorText = toErrorMessage(error);
        state.stageText = '';
        state.elapsedText = '';
        state.debugLogData = undefined;
      }
      // Don't throw — continue with next page in translate-all loop
    }
  }

  async startScreenshotTranslate(): Promise<void> {
    if (this.screenshotSelectionRunning) return;
    this.screenshotSelectionRunning = true;
    let selection: ScreenshotSelection | null;
    try {
      selection = await requestScreenshotSelection();
    } finally {
      this.screenshotSelectionRunning = false;
    }
    if (!selection) return;
    await this.translateScreenshotSelection(selection);
  }

  async translateScreenshotSelection(selection: ScreenshotSelection): Promise<void> {
    const key = `screenshot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const state = this.ensureState(key, `screenshot:${key}`);
    const ui = createScreenshotResultUi(selection.documentRect);
    document.body.appendChild(ui.host);

    let disposed = false;
    let detachDrag: (() => void) | null = null;
    let screenshotFile: File | null = null;
    let screenshotOriginalUrl: string | null = null;
    const render = (): void => {
      if (!disposed) renderScreenshotResultUi(ui, state);
    };
    const cleanup = (): void => {
      if (disposed) return;
      disposed = true;
      detachDrag?.();
      this.disposeState(state);
      if (screenshotOriginalUrl) {
        URL.revokeObjectURL(screenshotOriginalUrl);
        screenshotOriginalUrl = null;
      }
      this.states.delete(key);
      ui.host.remove();
    };

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
    detachDrag = this.attachScreenshotResultDrag(ui);

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
      this.resetStateForPipeline(state);
      state.stageText = screenshotFile ? '准备中' : '截图中';
      render();

      try {
        const file = await ensureScreenshotFile();
        if (disposed) return;

        const runSettings = await this.loadPipelineRunSettings(state);
        if (disposed) return;
        await this.runPipelineFromFile({
          state,
          file,
          runSettings,
          runStartAt: performance.now(),
          includeElapsedText: true,
          onProgress: render,
        });
        if (disposed) {
          this.disposeState(state);
          return;
        }
        ui.host.style.visibility = '';
        render();
      } catch (error) {
        if (disposed) return;
        ui.host.style.visibility = '';
        state.status = 'error';
        state.errorText = toErrorMessage(error);
        state.stageText = '';
        state.elapsedText = '';
        state.debugLogData = undefined;
        render();
      }
    };

    await runScreenshotPipeline();
  }

  private attachScreenshotResultDrag(ui: ScreenshotResultUiElements): () => void {
    let dragging = false;
    let pointerId: number | null = null;
    let startClientX = 0;
    let startClientY = 0;
    let startLeft = 0;
    let startTop = 0;

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (
        event.button !== 0 ||
        (target instanceof Element && target.closest('button'))
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      dragging = true;
      pointerId = event.pointerId;
      startClientX = event.clientX;
      startClientY = event.clientY;
      startLeft = Number.parseFloat(ui.host.style.left || '0');
      startTop = Number.parseFloat(ui.host.style.top || '0');
      ui.host.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging || pointerId !== event.pointerId) return;
      event.preventDefault();
      const nextLeft = startLeft + event.clientX - startClientX;
      const nextTop = startTop + event.clientY - startClientY;
      ui.host.style.left = `${Math.max(0, nextLeft)}px`;
      ui.host.style.top = `${Math.max(0, nextTop)}px`;
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (!dragging || pointerId !== event.pointerId) return;
      event.preventDefault();
      dragging = false;
      pointerId = null;
      if (ui.host.hasPointerCapture(event.pointerId)) {
        ui.host.releasePointerCapture(event.pointerId);
      }
    };

    ui.host.addEventListener('pointerdown', onPointerDown);
    ui.host.addEventListener('pointermove', onPointerMove);
    ui.host.addEventListener('pointerup', onPointerUp);
    return () => {
      ui.host.removeEventListener('pointerdown', onPointerDown);
      ui.host.removeEventListener('pointermove', onPointerMove);
      ui.host.removeEventListener('pointerup', onPointerUp);
    };
  }

  private teardownReadingBar(): void {
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
