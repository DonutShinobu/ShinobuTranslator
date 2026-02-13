import type { PipelineConfig, PipelineProgress, RuntimeStageStatus } from '../types';

type ExtensionSettings = {
  sourceLang: string;
  targetLang: string;
  translator: PipelineConfig['translator'];
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
};

type RuntimeMessage =
  | { type: 'mt:get-settings' }
  | { type: 'mt:download-image'; imageUrl: string };

type RuntimeResponse =
  | {
      ok: true;
      type: 'mt:get-settings';
      settings: ExtensionSettings;
    }
  | {
      ok: true;
      type: 'mt:download-image';
      base64: string;
      contentType: string;
      sourceUrl: string;
    }
  | {
      ok: false;
      type: RuntimeMessage['type'];
      error: string;
    };

type PhotoViewStatus = 'idle' | 'running' | 'translated' | 'showingOriginal' | 'error';
type PhotoDisplayMode = 'translated' | 'original';

type PhotoState = {
  status: PhotoViewStatus;
  mode: PhotoDisplayMode;
  originalUrl: string;
  translatedUrl?: string;
  stageText: string;
  fallbackSummary: string;
  errorText: string;
};

const stageLabelMap: Record<string, string> = {
  load: '加载图片',
  preload: '加载模型',
  detect: '文本检测',
  ocr: 'OCR 识别',
  merge: '文本合并',
  translate: '翻译',
  mask_refine: '遮罩细化',
  inpaint: '去字',
  typeset: '排版嵌字',
  done: '完成',
};

const styleId = 'mt-x-overlay-style';
const imageDialogSelector = '[aria-labelledby="modal-header"][role="dialog"]';
const originalSrcAttr = 'data-mt-original-src';

let runPipelineLoader: Promise<typeof import('../pipeline/orchestrator')> | null = null;

async function getRunPipeline(): Promise<typeof import('../pipeline/orchestrator')['runPipeline']> {
  if (!runPipelineLoader) {
    runPipelineLoader = import('../pipeline/orchestrator');
  }
  const module = await runPipelineLoader;
  return module.runPipeline;
}

function getChromeApi(): {
  runtime?: {
    sendMessage?: (message: unknown, callback?: (response: unknown) => void) => void;
    lastError?: { message?: string };
  };
} | null {
  const maybeChrome = (globalThis as typeof globalThis & { chrome?: unknown }).chrome;
  if (!maybeChrome || typeof maybeChrome !== 'object') {
    return null;
  }
  return maybeChrome as {
    runtime?: {
      sendMessage?: (message: unknown, callback?: (response: unknown) => void) => void;
      lastError?: { message?: string };
    };
  };
}

function validateSettings(settings: ExtensionSettings): string | null {
  if (settings.translator !== 'llm') {
    return null;
  }
  if (!settings.llmBaseUrl.trim()) {
    return 'LLM Base URL 不能为空';
  }
  if (!settings.llmModel.trim()) {
    return 'LLM 模型不能为空';
  }
  if (!settings.llmApiKey.trim()) {
    return 'LLM API Key 不能为空';
  }
  return null;
}

function toPipelineConfig(settings: ExtensionSettings): PipelineConfig {
  return {
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    translator: settings.translator,
    llmBaseUrl: settings.llmBaseUrl,
    llmApiKey: settings.llmApiKey,
    llmModel: settings.llmModel,
  };
}

function sendRuntimeMessage(message: RuntimeMessage): Promise<RuntimeResponse> {
  const chromeApi = getChromeApi();
  if (!chromeApi?.runtime?.sendMessage) {
    return Promise.reject(new Error('当前环境不支持 runtime.sendMessage'));
  }
  return new Promise<RuntimeResponse>((resolve, reject) => {
    chromeApi.runtime?.sendMessage?.(message, (response: unknown) => {
      const lastError = chromeApi.runtime?.lastError;
      if (lastError?.message) {
        reject(new Error(lastError.message));
        return;
      }
      if (!response || typeof response !== 'object') {
        reject(new Error('扩展消息返回为空'));
        return;
      }
      resolve(response as RuntimeResponse);
    });
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isVisibleElement(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 32 || rect.height < 32) {
    return false;
  }
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function isMediaImageSource(src: string): boolean {
  if (!src) {
    return false;
  }
  if (src.startsWith('blob:')) {
    return true;
  }
  return src.includes('pbs.twimg.com/media/');
}

function normalizeImageKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== 'pbs.twimg.com') {
      return url.toString();
    }
    const format = url.searchParams.get('format');
    const base = `${url.origin}${url.pathname}`;
    return format ? `${base}?format=${format}` : base;
  } catch {
    return rawUrl;
  }
}

function updateImageCompanionBackground(image: HTMLImageElement, targetUrl: string): void {
  const previous = image.previousElementSibling;
  if (!previous || !(previous instanceof HTMLElement)) {
    return;
  }
  if (!previous.style.backgroundImage) {
    return;
  }
  previous.style.backgroundImage = `url("${targetUrl}")`;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('导出译图失败'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

function inferFileExtension(contentType: string, sourceUrl: string): string {
  if (contentType.includes('png')) {
    return 'png';
  }
  if (contentType.includes('webp')) {
    return 'webp';
  }
  if (contentType.includes('gif')) {
    return 'gif';
  }
  try {
    const format = new URL(sourceUrl).searchParams.get('format');
    if (format) {
      return format;
    }
  } catch {
    // ignore URL parse error
  }
  return 'jpg';
}

function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: contentType || 'image/jpeg' });
}

function createFallbackSummary(runtimeStages: RuntimeStageStatus[]): string {
  const fallbackStages = Array.from(
    new Set(runtimeStages.filter((stage) => stage.provider === 'wasm').map((stage) => stage.model))
  );
  if (fallbackStages.length === 0) {
    return 'WASM回退: 否';
  }
  return `WASM回退: 是（${fallbackStages.join(', ')}）`;
}

function createInitialState(originalUrl: string): PhotoState {
  return {
    status: 'idle',
    mode: 'original',
    originalUrl,
    translatedUrl: undefined,
    stageText: '',
    fallbackSummary: '',
    errorText: '',
  };
}

class XOverlayTranslator {
  private observer: MutationObserver | null = null;
  private observedRoot: Element | null = null;
  private syncTimer: number | null = null;
  private activeDialog: HTMLElement | null = null;
  private uiHost: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private stageLine: HTMLDivElement | null = null;
  private fallbackLine: HTMLDivElement | null = null;
  private currentImageKey: string | null = null;
  private states = new Map<string, PhotoState>();
  private hadDialog = false;

  start(): void {
    this.injectStyle();
    this.bindObserver();
    window.addEventListener('beforeunload', this.handleBeforeUnload);
    window.addEventListener('popstate', this.handleRouteChange);
    window.addEventListener('hashchange', this.handleRouteChange);
    this.scheduleSync(0);
  }

  private handleBeforeUnload = (): void => {
    if (this.syncTimer !== null) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.observer?.disconnect();
    this.observer = null;
    this.observedRoot = null;
    window.removeEventListener('beforeunload', this.handleBeforeUnload);
    window.removeEventListener('popstate', this.handleRouteChange);
    window.removeEventListener('hashchange', this.handleRouteChange);
    this.clearSessionCache();
  };

  private handleRouteChange = (): void => {
    this.scheduleSync(0);
  };

  private bindObserver(): void {
    const nextRoot = document.querySelector('#layers') ?? document.body;
    if (this.observedRoot === nextRoot && this.observer) {
      return;
    }
    this.observer?.disconnect();
    this.observedRoot = nextRoot;
    this.observer = new MutationObserver((mutations) => {
      if (mutations.some((mutation) => mutation.type === 'childList')) {
        this.scheduleSync(180);
      }
    });
    this.observer.observe(nextRoot, { childList: true, subtree: true });
  }

  private scheduleSync(delayMs: number): void {
    if (this.syncTimer !== null) {
      return;
    }
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      this.sync();
    }, delayMs);
  }

  private injectStyle(): void {
    if (document.getElementById(styleId)) {
      return;
    }
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .mt-x-overlay-fallback {
        position: absolute;
        right: 16px;
        top: 16px;
        z-index: 1000;
      }
      .mt-x-overlay-inline {
        display: flex;
        align-items: flex-start;
        gap: 8px;
      }
      .mt-x-control {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 84px;
        height: 34px;
        border: 0;
        border-radius: 999px;
        padding: 0 12px;
        cursor: pointer;
        background: rgba(17, 24, 39, 0.78);
        color: #ffffff;
        font-size: 13px;
        line-height: 1;
      }
      .mt-x-control:disabled {
        opacity: 0.62;
        cursor: default;
      }
      .mt-x-info-wrap {
        margin-top: 2px;
      }
      .mt-x-info {
        max-width: 260px;
        color: #ffffff;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
        font-size: 12px;
        line-height: 1.35;
      }
      .mt-x-info + .mt-x-info {
        margin-top: 2px;
      }
      .mt-x-info[data-variant='error'] {
        color: #fecaca;
      }
    `;
    document.documentElement.appendChild(style);
  }

  private sync(): void {
    this.bindObserver();
    const dialog = this.findPhotoDialog();
    if (!dialog) {
      if (this.hadDialog) {
        this.detachUi();
        this.clearSessionCache();
      }
      this.hadDialog = false;
      return;
    }

    this.hadDialog = true;
    if (this.activeDialog !== dialog || !this.uiHost?.isConnected) {
      this.detachUi();
      this.activeDialog = dialog;
      this.mountUi(dialog);
    }

    const currentImage = this.findCurrentImage(dialog);
    if (!currentImage) {
      this.currentImageKey = null;
      this.render(null);
      return;
    }

    const originalUrl = this.readImageOriginalUrl(currentImage);
    if (!originalUrl) {
      this.currentImageKey = null;
      this.render(null);
      return;
    }

    const key = normalizeImageKey(originalUrl);
    this.currentImageKey = key;
    const state = this.ensureState(key, originalUrl);
    if (!state.translatedUrl && state.status !== 'running') {
      state.originalUrl = originalUrl;
    }
    this.applyImageFromState(currentImage, state);
    this.render(state);
  }

  private readImageOriginalUrl(image: HTMLImageElement): string {
    const attrOriginal = image.getAttribute(originalSrcAttr);
    if (attrOriginal) {
      return attrOriginal;
    }
    const src = image.currentSrc || image.src;
    if (!src || src.startsWith('blob:')) {
      return '';
    }
    return src;
  }

  private findPhotoDialog(): HTMLElement | null {
    const dialogs = Array.from(document.querySelectorAll<HTMLElement>(imageDialogSelector));
    for (const dialog of dialogs) {
      if (!isVisibleElement(dialog)) {
        continue;
      }
      if (this.findCurrentImage(dialog)) {
        return dialog;
      }
    }
    return null;
  }

  private findCurrentImage(dialog: HTMLElement): HTMLImageElement | null {
    let best: HTMLImageElement | null = null;
    let bestArea = 0;
    const images = dialog.querySelectorAll<HTMLImageElement>('img');
    for (const image of images) {
      if (!isVisibleElement(image)) {
        continue;
      }
      const src = image.currentSrc || image.src;
      if (!isMediaImageSource(src)) {
        continue;
      }
      if (src.startsWith('blob:') && !image.hasAttribute(originalSrcAttr)) {
        continue;
      }
      const rect = image.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        best = image;
      }
    }
    return best;
  }

  private ensureState(key: string, originalUrl: string): PhotoState {
    const existing = this.states.get(key);
    if (existing) {
      return existing;
    }
    const created = createInitialState(originalUrl);
    this.states.set(key, created);
    return created;
  }

  private mountUi(dialog: HTMLElement): void {
    const root = document.createElement('div');
    root.className = 'mt-x-overlay-inline';

    this.button = document.createElement('button');
    this.button.className = 'mt-x-control';
    this.button.type = 'button';
    this.button.textContent = '翻译';
    this.button.addEventListener('click', () => {
      void this.handleButtonClick();
    });
    root.appendChild(this.button);

    const infoWrap = document.createElement('div');
    infoWrap.className = 'mt-x-info-wrap';
    this.stageLine = document.createElement('div');
    this.stageLine.className = 'mt-x-info';
    this.fallbackLine = document.createElement('div');
    this.fallbackLine.className = 'mt-x-info';
    infoWrap.appendChild(this.stageLine);
    infoWrap.appendChild(this.fallbackLine);
    root.appendChild(infoWrap);

    const host = document.createElement('div');
    host.className = 'mt-x-overlay-fallback';
    host.appendChild(root);

    dialog.appendChild(host);
    this.uiHost = host;
  }

  private detachUi(): void {
    if (this.uiHost?.parentElement) {
      this.uiHost.parentElement.removeChild(this.uiHost);
    }
    this.uiHost = null;
    this.button = null;
    this.stageLine = null;
    this.fallbackLine = null;
    this.currentImageKey = null;
    this.activeDialog = null;
  }

  private clearSessionCache(): void {
    for (const state of this.states.values()) {
      if (state.translatedUrl) {
        URL.revokeObjectURL(state.translatedUrl);
      }
    }
    this.states.clear();
  }

  private render(state: PhotoState | null): void {
    if (!this.button || !this.stageLine || !this.fallbackLine) {
      return;
    }
    if (!state) {
      this.button.disabled = true;
      this.button.textContent = '翻译';
      this.stageLine.textContent = '';
      this.stageLine.dataset.variant = 'normal';
      this.fallbackLine.textContent = '';
      return;
    }

    this.button.disabled = state.status === 'running';
    if (state.status === 'running') {
      this.button.textContent = state.stageText ? `翻译中: ${state.stageText}` : '翻译中...';
      this.stageLine.textContent = state.stageText ? `阶段: ${state.stageText}` : '';
      this.stageLine.dataset.variant = 'normal';
      this.fallbackLine.textContent = '';
      return;
    }

    if (state.status === 'translated') {
      this.button.textContent = '显示原图';
      this.stageLine.textContent = '';
      this.stageLine.dataset.variant = 'normal';
      this.fallbackLine.textContent = state.fallbackSummary;
      return;
    }

    if (state.status === 'showingOriginal') {
      this.button.textContent = '显示译图';
      this.stageLine.textContent = '';
      this.stageLine.dataset.variant = 'normal';
      this.fallbackLine.textContent = state.fallbackSummary;
      return;
    }

    if (state.status === 'error') {
      this.button.textContent = '重试翻译';
      this.stageLine.textContent = `错误: ${state.errorText}`;
      this.stageLine.dataset.variant = 'error';
      this.fallbackLine.textContent = state.fallbackSummary;
      return;
    }

    this.button.textContent = '翻译';
    this.stageLine.textContent = '';
    this.stageLine.dataset.variant = 'normal';
    this.fallbackLine.textContent = state.fallbackSummary;
  }

  private applyImageFromState(image: HTMLImageElement, state: PhotoState): void {
    const currentSrc = image.currentSrc || image.src;
    if (state.originalUrl) {
      image.setAttribute(originalSrcAttr, state.originalUrl);
    }

    if (!state.translatedUrl) {
      return;
    }

    if (state.mode === 'translated') {
      if (currentSrc !== state.translatedUrl) {
        image.src = state.translatedUrl;
        updateImageCompanionBackground(image, state.translatedUrl);
      }
      return;
    }

    if (state.originalUrl && currentSrc !== state.originalUrl) {
      image.src = state.originalUrl;
      updateImageCompanionBackground(image, state.originalUrl);
    }
  }

  private getCurrentImageAndState(): { image: HTMLImageElement; key: string; state: PhotoState } {
    if (!this.activeDialog || !this.currentImageKey) {
      throw new Error('当前未处于图片大图模式');
    }
    const image = this.findCurrentImage(this.activeDialog);
    if (!image) {
      throw new Error('未找到当前图片');
    }
    const state = this.states.get(this.currentImageKey);
    if (!state) {
      throw new Error('图片状态不存在');
    }
    return {
      image,
      key: this.currentImageKey,
      state,
    };
  }

  private async handleButtonClick(): Promise<void> {
    let current: { image: HTMLImageElement; key: string; state: PhotoState };
    try {
      current = this.getCurrentImageAndState();
    } catch {
      return;
    }
    const { image, key, state } = current;

    if (state.status === 'running') {
      return;
    }

    if (state.translatedUrl) {
      if (state.mode === 'translated') {
        state.mode = 'original';
        state.status = 'showingOriginal';
      } else {
        state.mode = 'translated';
        state.status = 'translated';
      }
      state.errorText = '';
      state.stageText = '';
      this.applyImageFromState(image, state);
      this.render(state);
      return;
    }

    state.status = 'running';
    state.mode = 'original';
    state.errorText = '';
    state.stageText = '准备下载图片';
    const imageOriginal = this.readImageOriginalUrl(image);
    if (imageOriginal) {
      state.originalUrl = imageOriginal;
      image.setAttribute(originalSrcAttr, imageOriginal);
    }
    this.render(state);

    try {
      const settingsResponse = await sendRuntimeMessage({ type: 'mt:get-settings' });
      if (!settingsResponse.ok || settingsResponse.type !== 'mt:get-settings') {
        throw new Error(settingsResponse.ok ? '读取配置失败' : settingsResponse.error);
      }
      const validationError = validateSettings(settingsResponse.settings);
      if (validationError) {
        throw new Error(validationError);
      }

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
      const artifacts = await runPipeline(file, toPipelineConfig(settingsResponse.settings), (progress: PipelineProgress) => {
        state.stageText = stageLabelMap[progress.stage] ?? progress.stage;
        this.render(state);
      });

      const translatedBlob = await canvasToBlob(artifacts.resultCanvas);
      const translatedUrl = URL.createObjectURL(translatedBlob);
      if (state.translatedUrl) {
        URL.revokeObjectURL(state.translatedUrl);
      }

      state.translatedUrl = translatedUrl;
      state.fallbackSummary = createFallbackSummary(artifacts.runtimeStages);
      state.stageText = '';
      state.errorText = '';
      state.mode = 'translated';
      state.status = 'translated';
      this.states.set(key, state);

      this.applyImageFromState(image, state);
      this.render(state);
    } catch (error) {
      state.status = 'error';
      state.errorText = toErrorMessage(error);
      state.stageText = '';
      this.render(state);
    }
  }
}

export function mountContentApp(): void {
  const app = new XOverlayTranslator();
  app.start();
}
