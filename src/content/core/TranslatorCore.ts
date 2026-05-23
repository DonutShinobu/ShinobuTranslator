import {
  validateSettings,
  toPipelineConfig,
  type ExtensionSettings,
} from '../../shared/config';
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
import { setOrtDebugConfig } from '../../runtime/onnxWorkerBridge';
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
  handleDebugDownload,
  injectStyles,
  renderUi,
  type UiElements,
} from './ui';

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
  const profile = settings.llmProfiles[settings.llmProvider];
  if (settings.translator === 'llm' && !profile.apiKey.trim()) return '未填写API Key，服务暂不可用';
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

let runPipelineLoader: Promise<typeof import('../../pipeline/orchestrator')> | null = null;

async function getRunPipeline(): Promise<typeof import('../../pipeline/orchestrator')['runPipeline']> {
  if (!runPipelineLoader) {
    runPipelineLoader = import('../../pipeline/orchestrator');
  }
  const module = await runPipelineLoader;
  return module.runPipeline;
}

export class TranslatorCore {
  private adapter: SiteAdapter;
  private states = new Map<string, PhotoState>();
  private mounted = new Map<string, MountedImage>();
  private disposeObserver: (() => void) | null = null;
  private syncTimer: number | null = null;

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

    state.status = 'running';
    state.mode = 'original';
    state.errorText = '';
    state.elapsedText = '';
    state.debugLogData = undefined;
    state.stageText = '准备中';
    const runStartAt = performance.now();
    this.renderForKey(key);

    try {
      const settingsResponse = await sendRuntimeMessage({ type: 'mt:get-settings' });
      if (!settingsResponse.ok || settingsResponse.type !== 'mt:get-settings') {
        throw new Error(settingsResponse.ok ? '读取配置失败' : settingsResponse.error);
      }
      const validationError = validateActiveSettings(settingsResponse.settings);
      if (validationError) throw new Error(validationError);

      const settings = settingsResponse.settings;
      if (settings.ortDebugMode) {
        setOrtDebugConfig({ logLevel: 'verbose', debug: true, profiling: true });
      } else {
        setOrtDebugConfig(undefined);
      }
      const showElapsedTime = settings.showElapsedTime === true;
      const showStageTimingDetails = showElapsedTime && settings.showStageTimingDetails === true;
      const showRuntimeStages = showStageTimingDetails;
      const showTypesetDebug = settings.showTypesetDebug === true;
      state.showTypesetDebug = showTypesetDebug;

      const downloadResponse = await sendRuntimeMessage({
        type: 'mt:download-image',
        imageUrl: state.originalUrl,
      });
      if (!downloadResponse.ok || downloadResponse.type !== 'mt:download-image') {
        throw new Error(downloadResponse.ok ? '下载图片失败' : downloadResponse.error);
      }

      const blob = base64ToBlob(downloadResponse.base64, downloadResponse.contentType);
      const suffix = inferFileExtension(downloadResponse.contentType, downloadResponse.sourceUrl);
      const file = new File([blob], `source.${suffix}`, { type: blob.type || 'image/jpeg' });

      const runPipeline = await getRunPipeline();
      const artifacts = await runPipeline(file, toPipelineConfig(settings), (progress: PipelineProgress) => {
        const stageLabel = stageLabelMap[progress.stage] ?? progress.stage;
        if (progress.stage === 'parallel') {
          state.stageText = progress.detail;
        } else if (progress.stage === 'done') {
          state.stageText = '完成';
        } else {
          state.stageText = `${stageLabel}中`;
        }
        this.renderForKey(key);
      });

      const translatedBlob = await canvasToBlob(artifacts.resultCanvas);
      const translatedUrl = URL.createObjectURL(translatedBlob);
      if (state.translatedUrl) URL.revokeObjectURL(state.translatedUrl);
      if (state.debugOriginalUrl) {
        URL.revokeObjectURL(state.debugOriginalUrl);
        state.debugOriginalUrl = undefined;
      }
      if (showTypesetDebug && artifacts.debugOriginalCanvas) {
        const debugBlob = await canvasToBlob(artifacts.debugOriginalCanvas);
        state.debugOriginalUrl = URL.createObjectURL(debugBlob);
      }
      const sourceImageDataUrl = showTypesetDebug
        ? (() => {
            const c = document.createElement('canvas');
            c.width = artifacts.original.naturalWidth;
            c.height = artifacts.original.naturalHeight;
            const ctx = c.getContext('2d');
            if (ctx) ctx.drawImage(artifacts.original, 0, 0);
            return c.toDataURL('image/png');
          })()
        : state.originalUrl;
      state.debugLogData = showTypesetDebug
        ? toTypesetDebugDownloadData(sourceImageDataUrl, artifacts)
        : undefined;

      state.translatedUrl = translatedUrl;
      const totalDurationMs = performance.now() - runStartAt;
      state.elapsedText = showElapsedTime
        ? formatElapsedText(totalDurationMs, artifacts.stageTimings, artifacts.runtimeStages, showStageTimingDetails, showRuntimeStages, artifacts.translationDebug)
        : '';
      state.stageText = '';
      state.errorText = '';
      state.mode = 'translated';
      state.status = 'translated';

      this.adapter.applyImage(target, translatedUrl);
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

    state.status = 'running';
    state.mode = 'original';
    state.errorText = '';
    state.elapsedText = '';
    state.debugLogData = undefined;
    state.stageText = '准备中';

    try {
      const settingsResponse = await sendRuntimeMessage({ type: 'mt:get-settings' });
      if (!settingsResponse.ok || settingsResponse.type !== 'mt:get-settings') {
        throw new Error(settingsResponse.ok ? '读取配置失败' : settingsResponse.error);
      }
      const validationError = validateActiveSettings(settingsResponse.settings);
      if (validationError) throw new Error(validationError);

      const settings = settingsResponse.settings;
      if (settings.ortDebugMode) {
        setOrtDebugConfig({ logLevel: 'verbose', debug: true, profiling: true });
      } else {
        setOrtDebugConfig(undefined);
      }
      const showTypesetDebug = settings.showTypesetDebug === true;
      state.showTypesetDebug = showTypesetDebug;

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

      const runPipeline = await getRunPipeline();
      const artifacts = await runPipeline(file, toPipelineConfig(settings), (progress: PipelineProgress) => {
        const stageLabel = stageLabelMap[progress.stage] ?? progress.stage;
        if (progress.stage === 'parallel') {
          state.stageText = progress.detail;
          onProgress(progress.detail);
        } else if (progress.stage === 'done') {
          state.stageText = '完成';
          onProgress('完成');
        } else {
          state.stageText = `${stageLabel}中`;
          onProgress(`${stageLabel}中`);
        }
      });

      const translatedBlob = await canvasToBlob(artifacts.resultCanvas);
      const translatedUrl = URL.createObjectURL(translatedBlob);
      if (state.translatedUrl) URL.revokeObjectURL(state.translatedUrl);
      if (state.debugOriginalUrl) {
        URL.revokeObjectURL(state.debugOriginalUrl);
        state.debugOriginalUrl = undefined;
      }
      if (showTypesetDebug && artifacts.debugOriginalCanvas) {
        const debugBlob = await canvasToBlob(artifacts.debugOriginalCanvas);
        state.debugOriginalUrl = URL.createObjectURL(debugBlob);
      }
      const sourceImageDataUrl = showTypesetDebug
        ? (() => {
            const c = document.createElement('canvas');
            c.width = artifacts.original.naturalWidth;
            c.height = artifacts.original.naturalHeight;
            const ctx = c.getContext('2d');
            if (ctx) ctx.drawImage(artifacts.original, 0, 0);
            return c.toDataURL('image/png');
          })()
        : state.originalUrl;
      state.debugLogData = showTypesetDebug
        ? toTypesetDebugDownloadData(sourceImageDataUrl, artifacts)
        : undefined;

      state.translatedUrl = translatedUrl;
      state.stageText = '';
      state.errorText = '';
      state.mode = 'translated';
      state.status = 'translated';

      this.adapter.applyImageByKey?.(key, translatedUrl);
    } catch (error) {
      state.status = 'error';
      state.errorText = toErrorMessage(error);
      state.stageText = '';
      state.elapsedText = '';
      state.debugLogData = undefined;
      // Don't throw — continue with next page in translate-all loop
    }
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
