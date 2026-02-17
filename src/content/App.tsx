import type {
  OcrRunDebugInfo,
  PipelineArtifacts,
  PipelineProgress,
  PipelineTypesetDebugLog,
  RuntimeStageStatus,
  StageTiming,
  TextRegion,
  TranslationDebugInfo,
} from '../types';
import type { ExtensionSettings } from '../shared/config';

const llmBaseUrlByProvider = {
  deepseek: 'https://api.deepseek.com',
  glm: 'https://api.z.ai/api/paas/v4',
  kimi: 'https://api.moonshot.ai/v1',
  minimax: 'https://api.minimax.io/v1',
} as const;

function resolveLlmBaseUrl(settings: ExtensionSettings): string {
  const profile = settings.llmProfiles[settings.llmProvider];
  if (settings.llmProvider === 'custom') {
    return profile.customBaseUrl.trim();
  }
  return llmBaseUrlByProvider[settings.llmProvider];
}

function resolveLlmModel(settings: ExtensionSettings): string {
  const profile = settings.llmProfiles[settings.llmProvider];
  if (settings.llmProvider === 'custom') {
    return profile.modelCustom.trim();
  }
  if (!profile.useCustomModel) {
    return profile.modelPreset.trim();
  }
  return profile.modelCustom.trim();
}

function validateSettings(settings: ExtensionSettings): string | null {
  if (settings.translator !== 'llm') {
    return null;
  }
  if (!resolveLlmModel(settings)) {
    return 'LLM 模型不能为空';
  }
  const profile = settings.llmProfiles[settings.llmProvider];
  if (settings.llmProvider === 'custom' && !profile.customBaseUrl.trim()) {
    return '自定义提供商 Base URL 不能为空';
  }
  return null;
}

function toPipelineConfig(settings: ExtensionSettings) {
  const profile = settings.llmProfiles[settings.llmProvider];
  return {
    sourceLang: 'ja',
    targetLang: settings.targetLang,
    translator: settings.translator,
    llmProvider: settings.llmProvider,
    llmBaseUrl: resolveLlmBaseUrl(settings),
    llmApiKey: profile.apiKey,
    llmModel: resolveLlmModel(settings),
    llmTemperature: profile.temperature,
    typesetDebug: settings.showTypesetDebug,
  };
}

function validateActiveSettings(settings: ExtensionSettings): string | null {
  if (settings.translator !== 'llm') {
    return null;
  }

  const baseValidation = validateSettings(settings);
  if (baseValidation) {
    return baseValidation;
  }

  const missingFields: string[] = [];
  const profile = settings.llmProfiles[settings.llmProvider];
  if (!profile.apiKey.trim()) {
    missingFields.push('API Key');
  }
  if (missingFields.length > 0) {
    return `未填写${missingFields.join('、')}，服务暂不可用`;
  }

  return null;
}

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
  debugOriginalUrl?: string;
  debugLogData?: TypesetDebugDownloadData;
  showTypesetDebug: boolean;
  stageText: string;
  elapsedText: string;
  errorText: string;
};

type OcrRegionLogItem = {
  regionId: string;
  direction: TextRegion['direction'];
  box: TextRegion['box'];
  quad?: TextRegion['quad'];
  sourceText: string;
};

type ModelRegionLogItem = {
  regionId: string;
  translatedTextRaw: string;
  translatedColumnsRaw: string[];
};

type TypesetDebugDownloadData = {
  exportedAt: string;
  sourceImageUrl: string;
  stageTimings: StageTiming[];
  runtimeStages: RuntimeStageStatus[];
  translationDebug: TranslationDebugInfo | null;
  ocrDebug: OcrRunDebugInfo | null;
  ocrRegions: OcrRegionLogItem[];
  modelRegions: ModelRegionLogItem[];
  typeset: PipelineTypesetDebugLog;
};

const stageLabelMap: Record<string, string> = {
  load: '加载图片',
  preload: '加载模型',
  detect: '文本检测',
  ocr: '文字识别',
  merge: '合并文本',
  parallel: '\u5e76\u884c\u5904\u7406',
  translate: '翻译文本',
  mask_refine: '细化遮罩',
  inpaint: '去除文字',
  typeset: '文字排版',
  done: '完成',
};

const styleId = 'mt-x-overlay-style';
const imageDialogSelector = '[aria-labelledby="modal-header"][role="dialog"]';
const originalSrcAttr = 'data-mt-original-src';
const photoStateCacheLimit = 20;
const routeChangeResyncDelayMs = 150;
const referenceButtonSelector =
  '#layers > div:nth-child(2) > div > div > div > div > div > div.css-175oi2r.r-1ny4l3l.r-18u37iz.r-1pi2tsx.r-1777fci.r-1xcajam.r-ipm5af.r-g6jmlv.r-1awozwy > div.css-175oi2r.r-1wbh5a2.r-htvplk.r-1udh08x.r-17gur6a.r-1pi2tsx.r-13qz1uu > div.css-175oi2r.r-18u37iz.r-1pi2tsx.r-11yh6sk.r-buy8e9.r-bnwqim.r-13qz1uu > div.css-175oi2r.r-16y2uox.r-1wbh5a2 > div.css-175oi2r.r-1awozwy.r-1loqt21.r-1777fci.r-xyw6el.r-u8s1d.r-ipm5af.r-zchlnj';
const anchoredVerticalGapPx = 8;
const fallbackHostInsetPx = 16;

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
    getURL?: (path: string) => string;
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
      getURL?: (path: string) => string;
    };
  };
}

function resolveRuntimeAssetUrl(path: string): string | null {
  const chromeApi = getChromeApi();
  return chromeApi?.runtime?.getURL ? chromeApi.runtime.getURL(path) : null;
}

function sendRuntimeMessage(message: RuntimeMessage): Promise<RuntimeResponse> {
  const chromeApi = getChromeApi();
  if (!chromeApi?.runtime?.sendMessage) {
    return Promise.reject(new Error('当前环境不支持 runtime.sendMessage'));
  }

  const sendOnce = () =>
    new Promise<RuntimeResponse>((resolve, reject) => {
      chromeApi.runtime?.sendMessage?.(message, (response: unknown) => {
        const lastError = chromeApi.runtime?.lastError;
        if (lastError?.message) {
          reject(new Error(lastError.message));
          return;
        }
        if (!response || typeof response !== 'object') {
          reject(new Error('扩展消息响应为空'));
          return;
        }
        resolve(response as RuntimeResponse);
      });
    });

  return sendOnce().catch(async (error: unknown) => {
    if (!isNoReceivingEndError(error)) {
      throw error;
    }
    await wait(120);
    return sendOnce();
  });
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isNoReceivingEndError(error: unknown): boolean {
  const message = toErrorMessage(error);
  return message.includes('Could not establish connection') || message.includes('Receiving end does not exist');
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
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

function isDialogMediaImage(image: HTMLImageElement): boolean {
  if (!isVisibleElement(image)) {
    return false;
  }
  const src = image.currentSrc || image.src;
  if (!isMediaImageSource(src)) {
    return false;
  }
  if (src.startsWith('blob:') && !image.hasAttribute(originalSrcAttr)) {
    return false;
  }
  return true;
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

function getTwitterMediaIdentity(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== 'pbs.twimg.com' || !url.pathname.startsWith('/media/')) {
      return null;
    }
    const format = url.searchParams.get('format');
    return format ? `${url.pathname}?format=${format}` : url.pathname;
  } catch {
    return null;
  }
}

function isSameTwitterMedia(leftUrl: string, rightUrl: string): boolean {
  const left = getTwitterMediaIdentity(leftUrl);
  const right = getTwitterMediaIdentity(rightUrl);
  if (!left || !right) {
    return false;
  }
  return left === right;
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

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return '0ms';
  }
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(2)}s`;
  }
  return `${Math.round(durationMs)}ms`;
}

function formatRuntimeProvider(stage: RuntimeStageStatus): string {
  if (!stage.enabled) {
    return 'disabled';
  }
  if (!stage.provider) {
    return 'unknown';
  }
  if (stage.provider === 'wasm') {
    return 'cpu(wasm)';
  }
  if (stage.provider === 'webnn') {
    return `webnn/${stage.webnnDeviceType ?? 'default'}`;
  }
  return stage.provider;
}

function formatRuntimeStagesLine(runtimeStages: RuntimeStageStatus[]): string {
  if (runtimeStages.length === 0) {
    return '';
  }
  const orderedModels: RuntimeStageStatus['model'][] = ['detector', 'ocr', 'inpaint'];
  const modelLabels: Record<RuntimeStageStatus['model'], string> = {
    detector: '检测',
    ocr: 'OCR',
    inpaint: '去字',
  };
  const stageByModel = new Map(runtimeStages.map((stage) => [stage.model, stage]));
  const parts: string[] = [];
  for (const model of orderedModels) {
    const stage = stageByModel.get(model);
    if (!stage) {
      continue;
    }
    parts.push(`${modelLabels[model]}=${formatRuntimeProvider(stage)}`);
  }
  if (parts.length === 0) {
    return '';
  }
  return `运行时: ${parts.join(' / ')}`;
}

function formatElapsedText(
  totalDurationMs: number,
  stageTimings: StageTiming[],
  runtimeStages: RuntimeStageStatus[],
  showStageDetails: boolean,
  showRuntimeStages: boolean
): string {
  const totalLine = `总耗时：${formatDuration(totalDurationMs)}`;
  const runtimeLine = showRuntimeStages ? formatRuntimeStagesLine(runtimeStages) : '';
  if (!showStageDetails || stageTimings.length === 0) {
    return runtimeLine ? [totalLine, runtimeLine].join('\n') : totalLine;
  }
  const detailLines = stageTimings.map((timing) => {
    const label = stageLabelMap[timing.stage] ?? timing.label ?? timing.stage;
    return `${label}：${formatDuration(timing.durationMs)}`;
  });
  return runtimeLine ? [totalLine, runtimeLine, ...detailLines].join('\n') : [totalLine, ...detailLines].join('\n');
}

function appendStatusDetail(baseText: string, detailText: string): string {
  if (!detailText) {
    return baseText;
  }
  return `${baseText}\n${detailText}`;
}

function cloneTextRegionBox(region: TextRegion): TextRegion['box'] {
  return { ...region.box };
}

function cloneTextRegionQuad(region: TextRegion): TextRegion['quad'] {
  if (!region.quad) {
    return undefined;
  }
  return region.quad.map((point) => ({ x: point.x, y: point.y })) as TextRegion['quad'];
}

function toTypesetDebugDownloadData(
  sourceImageUrl: string,
  artifacts: PipelineArtifacts,
): TypesetDebugDownloadData | undefined {
  if (!artifacts.typesetDebugLog) {
    return undefined;
  }
  const ocrRegions: OcrRegionLogItem[] = artifacts.detectedRegions.map((region) => ({
    regionId: region.id,
    direction: region.direction,
    box: cloneTextRegionBox(region),
    quad: cloneTextRegionQuad(region),
    sourceText: region.sourceText,
  }));
  const modelRegions: ModelRegionLogItem[] = artifacts.detectedRegions.map((region) => ({
    regionId: region.id,
    translatedTextRaw: region.translatedText,
    translatedColumnsRaw: region.translatedColumns ? [...region.translatedColumns] : [],
  }));
  return {
    exportedAt: new Date().toISOString(),
    sourceImageUrl,
    stageTimings: artifacts.stageTimings.map((timing) => ({ ...timing })),
    runtimeStages: artifacts.runtimeStages.map((stage) => ({ ...stage })),
    translationDebug: artifacts.translationDebug
      ? { ...artifacts.translationDebug }
      : null,
    ocrDebug: artifacts.ocrDebug
      ? {
          ...artifacts.ocrDebug,
          preprocessPerRegionMs: artifacts.ocrDebug.preprocessPerRegionMs.map((item) => ({ ...item })),
          chunks: artifacts.ocrDebug.chunks.map((chunk) => ({
            ...chunk,
            regionIds: [...chunk.regionIds],
            decodeSteps: chunk.decodeSteps.map((step) => ({ ...step })),
            fallbackRegions: chunk.fallbackRegions.map((region) => ({ ...region })),
          })),
          colorFallbackRegions: artifacts.ocrDebug.colorFallbackRegions.map((region) => ({ ...region })),
        }
      : null,
    ocrRegions,
    modelRegions,
    typeset: artifacts.typesetDebugLog,
  };
}

function downloadJson(data: unknown, filenamePrefix: string): void {
  const json = JSON.stringify(data, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${filenamePrefix}-${timestamp}.json`;
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
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

class XOverlayTranslator {
  private observer: MutationObserver | null = null;
  private observedRoot: Element | null = null;
  private syncTimer: number | null = null;
  private syncDueTime = 0;
  private positionRafId: number | null = null;
  private hasPendingRenderPositionSync = false;
  private routeResyncTimer: number | null = null;
  private originalPushState: History['pushState'] | null = null;
  private originalReplaceState: History['replaceState'] | null = null;
  private historyPatched = false;
  private lastHostLeft: number | null = null;
  private lastHostTop: number | null = null;
  private activeDialog: HTMLElement | null = null;
  private uiHost: HTMLElement | null = null;
  private button: HTMLButtonElement | null = null;
  private debugDownloadButton: HTMLButtonElement | null = null;
  private statusLine: HTMLDivElement | null = null;
  private statusSpinner: HTMLSpanElement | null = null;
  private currentImageKey: string | null = null;
  private states = new Map<string, PhotoState>();
  private hadDialog = false;

  start(): void {
    this.injectStyle();
    this.bindObserver();
    this.installHistoryHooks();
    window.addEventListener('beforeunload', this.handleBeforeUnload);
    window.addEventListener('popstate', this.handleRouteChange);
    window.addEventListener('hashchange', this.handleRouteChange);
    this.scheduleSync(0);
  }

  private handleBeforeUnload = (): void => {
    if (this.syncTimer !== null) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
      this.syncDueTime = 0;
    }
    if (this.routeResyncTimer !== null) {
      window.clearTimeout(this.routeResyncTimer);
      this.routeResyncTimer = null;
    }
    this.stopPositionTracking();
    this.observer?.disconnect();
    this.observer = null;
    this.observedRoot = null;
    this.restoreHistoryHooks();
    window.removeEventListener('beforeunload', this.handleBeforeUnload);
    window.removeEventListener('popstate', this.handleRouteChange);
    window.removeEventListener('hashchange', this.handleRouteChange);
    this.clearSessionCache();
  };

  private handleRouteChange = (): void => {
    this.scheduleSync(0);
    if (this.routeResyncTimer !== null) {
      window.clearTimeout(this.routeResyncTimer);
    }
    this.routeResyncTimer = window.setTimeout(() => {
      this.routeResyncTimer = null;
      this.scheduleSync(0);
    }, routeChangeResyncDelayMs);
  };

  private installHistoryHooks(): void {
    if (this.historyPatched) {
      return;
    }
    this.originalPushState = history.pushState;
    this.originalReplaceState = history.replaceState;

    history.pushState = ((data: unknown, unused: string, url?: string | URL | null): void => {
      this.originalPushState?.call(history, data, unused, url);
      this.handleRouteChange();
    }) as History['pushState'];

    history.replaceState = ((data: unknown, unused: string, url?: string | URL | null): void => {
      this.originalReplaceState?.call(history, data, unused, url);
      this.handleRouteChange();
    }) as History['replaceState'];

    this.historyPatched = true;
  }

  private restoreHistoryHooks(): void {
    if (!this.historyPatched) {
      return;
    }
    if (this.originalPushState) {
      history.pushState = this.originalPushState;
    }
    if (this.originalReplaceState) {
      history.replaceState = this.originalReplaceState;
    }
    this.originalPushState = null;
    this.originalReplaceState = null;
    this.historyPatched = false;
  }

  private bindObserver(): void {
    const nextRoot = document.querySelector('#layers') ?? document.body;
    if (this.observedRoot === nextRoot && this.observer) {
      return;
    }
    this.observer?.disconnect();
    this.observedRoot = nextRoot;
    this.observer = new MutationObserver((mutations) => {
      if (!mutations.some((mutation) => mutation.type === 'childList')) {
        return;
      }
      const delayMs = this.hasDialogNodeMutation(mutations) ? 0 : 180;
      this.scheduleSync(delayMs);
    });
    this.observer.observe(nextRoot, { childList: true, subtree: true });
  }

  private hasDialogNodeMutation(mutations: MutationRecord[]): boolean {
    for (const mutation of mutations) {
      const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes];
      for (const node of changedNodes) {
        if (!(node instanceof HTMLElement)) {
          continue;
        }
        if (node.matches(imageDialogSelector) || node.querySelector(imageDialogSelector)) {
          return true;
        }
      }
    }
    return false;
  }

  private scheduleSync(delayMs: number): void {
    const now = performance.now();
    const dueTime = now + Math.max(0, delayMs);
    if (this.syncTimer !== null) {
      if (dueTime >= this.syncDueTime) {
        return;
      }
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    const timeoutMs = Math.max(0, Math.ceil(dueTime - now));
    this.syncDueTime = now + timeoutMs;
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      this.syncDueTime = 0;
      this.sync();
    }, timeoutMs);
  }

  private injectStyle(): void {
    if (document.getElementById(styleId)) {
      return;
    }
    const style = document.createElement('style');
    style.id = styleId;
    const fontCnUrl = resolveRuntimeAssetUrl('fonts/SourceHanSansCN-VF.ttf.woff2');
    const fontTwUrl = resolveRuntimeAssetUrl('fonts/SourceHanSansTW-VF.ttf.woff2');
    const fontFaces = [
      fontCnUrl
        ? `@font-face {
            font-family: "MTX-SourceHanSans-CN";
            src: url("${fontCnUrl}") format("woff2");
            font-style: normal;
            font-weight: 200 900;
            font-display: swap;
          }`
        : '',
      fontTwUrl
        ? `@font-face {
            font-family: "MTX-SourceHanSans-TW";
            src: url("${fontTwUrl}") format("woff2");
            font-style: normal;
            font-weight: 200 900;
            font-display: swap;
          }`
        : '',
    ].filter(Boolean).join('\n');

    style.textContent = `
      ${fontFaces}
      .mt-x-overlay-fallback {
        position: absolute;
        right: ${fallbackHostInsetPx}px;
        top: ${fallbackHostInsetPx}px;
        z-index: 1000;
      }
      .mt-x-overlay-inline {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
      }
      .mt-x-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .mt-x-control {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 84px;
        height: 34px;
        border: 1px solid rgba(255, 255, 255, 0.9);
        border-radius: 999px;
        padding: 0 12px;
        cursor: pointer;
        background: rgba(17, 24, 39, 0.78);
        color: #ffffff;
        font-size: 13px;
        line-height: 1;
      }
      .mt-x-control-secondary {
        min-width: 92px;
        background: rgba(15, 118, 110, 0.82);
      }
      .mt-x-control:disabled {
        opacity: 0.62;
        cursor: default;
      }
      .mt-x-status {
        display: flex;
        align-items: flex-start;
        gap: 6px;
      }
      .mt-x-status-spinner {
        width: 12px;
        height: 12px;
        margin-top: 2px;
        border: 2px solid rgba(255, 255, 255, 0.9);
        border-right-color: transparent;
        border-bottom-color: transparent;
        border-radius: 50%;
        animation: mt-x-spin 0.8s linear infinite;
        flex: 0 0 auto;
      }
      .mt-x-status-spinner[data-running='false'] {
        display: none;
      }
      .mt-x-status-text {
        max-width: 260px;
        color: #ffffff;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.65);
        font-size: 12px;
        line-height: 1.35;
        white-space: pre-line;
      }
      .mt-x-status-text[data-variant='error'] {
        color: #fecaca;
      }
      @keyframes mt-x-spin {
        to {
          transform: rotate(360deg);
        }
      }
    `;
    document.documentElement.appendChild(style);
  }

  private startPositionTracking(): void {
    if (this.positionRafId !== null) {
      return;
    }
    const tick = (): void => {
      if (!this.activeDialog || !this.uiHost?.isConnected) {
        this.positionRafId = null;
        return;
      }
      this.positionUiHost(this.activeDialog);
      this.positionRafId = window.requestAnimationFrame(tick);
    };
    this.positionRafId = window.requestAnimationFrame(tick);
  }

  private stopPositionTracking(): void {
    if (this.positionRafId !== null) {
      window.cancelAnimationFrame(this.positionRafId);
      this.positionRafId = null;
    }
    this.hasPendingRenderPositionSync = false;
  }

  private queuePositionSyncAfterRender(): void {
    if (this.hasPendingRenderPositionSync) {
      return;
    }
    this.hasPendingRenderPositionSync = true;
    queueMicrotask(() => {
      this.hasPendingRenderPositionSync = false;
      if (!this.activeDialog || !this.uiHost?.isConnected) {
        return;
      }
      this.positionUiHost(this.activeDialog);
    });
  }

  private findReferenceButton(): HTMLElement | null {
    const element = document.querySelector(referenceButtonSelector);
    return element instanceof HTMLElement ? element : null;
  }

  private applyFallbackPosition(host: HTMLElement): void {
    const fallbackInset = `${fallbackHostInsetPx}px`;
    if (host.style.left !== 'auto') {
      host.style.left = 'auto';
    }
    if (host.style.right !== fallbackInset) {
      host.style.right = fallbackInset;
    }
    if (host.style.top !== fallbackInset) {
      host.style.top = fallbackInset;
    }
    this.lastHostLeft = null;
    this.lastHostTop = null;
  }

  private applyAnchoredPosition(dialog: HTMLElement, host: HTMLElement, anchor: HTMLElement): void {
    const anchorRect = anchor.getBoundingClientRect();
    const dialogRect = dialog.getBoundingClientRect();
    const hostWidth = host.offsetWidth;
    const hostHeight = host.offsetHeight;

    const unclampedLeft = anchorRect.right - dialogRect.left - hostWidth;
    const unclampedTop = anchorRect.bottom - dialogRect.top + anchoredVerticalGapPx;
    const maxLeft = Math.max(0, dialogRect.width - hostWidth);
    const maxTop = Math.max(0, dialogRect.height - hostHeight);

    const left = Math.min(maxLeft, Math.max(0, unclampedLeft));
    const top = Math.min(maxTop, Math.max(0, unclampedTop));
    const roundedLeft = Math.round(left);
    const roundedTop = Math.round(top);

    if (host.style.right !== 'auto') {
      host.style.right = 'auto';
    }
    if (this.lastHostLeft !== roundedLeft) {
      host.style.left = `${roundedLeft}px`;
      this.lastHostLeft = roundedLeft;
    }
    if (this.lastHostTop !== roundedTop) {
      host.style.top = `${roundedTop}px`;
      this.lastHostTop = roundedTop;
    }
  }

  private positionUiHost(dialog: HTMLElement): void {
    if (!this.uiHost) {
      return;
    }
    const anchor = this.findReferenceButton();
    if (!anchor || !isVisibleElement(anchor) || !dialog.contains(anchor)) {
      this.applyFallbackPosition(this.uiHost);
      return;
    }
    this.applyAnchoredPosition(dialog, this.uiHost, anchor);
  }

  private sync(): void {
    this.bindObserver();
    const dialog = this.findPhotoDialog();
    if (!dialog) {
      if (this.hadDialog) {
        this.detachUi();
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
    this.positionUiHost(dialog);

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
    const src = image.currentSrc || image.src;
    const attrOriginal = image.getAttribute(originalSrcAttr);
    if (attrOriginal) {
      if (!src || src.startsWith('blob:')) {
        return attrOriginal;
      }
      if (isSameTwitterMedia(attrOriginal, src)) {
        return attrOriginal;
      }
      image.removeAttribute(originalSrcAttr);
    }
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
    const centerElement = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    const centerImage =
      centerElement instanceof HTMLImageElement
        ? centerElement
        : centerElement?.closest?.('img') instanceof HTMLImageElement
          ? (centerElement.closest('img') as HTMLImageElement)
          : null;
    if (centerImage && dialog.contains(centerImage) && isDialogMediaImage(centerImage)) {
      return centerImage;
    }

    let best: HTMLImageElement | null = null;
    let bestArea = 0;
    const images = dialog.querySelectorAll<HTMLImageElement>('img');
    for (const image of images) {
      if (!isDialogMediaImage(image)) {
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
      this.touchStateKey(key);
      return existing;
    }
    const created = createInitialState(originalUrl);
    this.states.set(key, created);
    this.trimStateCache(this.currentImageKey ?? key);
    return created;
  }

  private mountUi(dialog: HTMLElement): void {
    const root = document.createElement('div');
    root.className = 'mt-x-overlay-inline';

    const actions = document.createElement('div');
    actions.className = 'mt-x-actions';

    this.button = document.createElement('button');
    this.button.className = 'mt-x-control';
    this.button.type = 'button';
    this.button.textContent = '翻译';
    this.button.addEventListener('click', () => {
      void this.handleButtonClick();
    });
    actions.appendChild(this.button);

    this.debugDownloadButton = document.createElement('button');
    this.debugDownloadButton.className = 'mt-x-control mt-x-control-secondary';
    this.debugDownloadButton.type = 'button';
    this.debugDownloadButton.textContent = '下载日志';
    this.debugDownloadButton.addEventListener('click', () => {
      this.handleDownloadDebugLog();
    });
    actions.appendChild(this.debugDownloadButton);

    root.appendChild(actions);

    const statusWrap = document.createElement('div');
    statusWrap.className = 'mt-x-status';
    this.statusSpinner = document.createElement('span');
    this.statusSpinner.className = 'mt-x-status-spinner';
    this.statusSpinner.dataset.running = 'false';
    this.statusLine = document.createElement('div');
    this.statusLine.className = 'mt-x-status-text';
    statusWrap.appendChild(this.statusSpinner);
    statusWrap.appendChild(this.statusLine);
    root.appendChild(statusWrap);

    const host = document.createElement('div');
    host.className = 'mt-x-overlay-fallback';
    host.appendChild(root);

    dialog.appendChild(host);
    this.uiHost = host;
    this.positionUiHost(dialog);
    this.startPositionTracking();
  }

  private detachUi(): void {
    this.stopPositionTracking();
    if (this.uiHost?.parentElement) {
      this.uiHost.parentElement.removeChild(this.uiHost);
    }
    this.lastHostLeft = null;
    this.lastHostTop = null;
    this.uiHost = null;
    this.button = null;
    this.debugDownloadButton = null;
    this.statusLine = null;
    this.statusSpinner = null;
    this.currentImageKey = null;
    this.activeDialog = null;
  }

  private clearSessionCache(): void {
    for (const state of this.states.values()) {
      this.disposeState(state);
    }
    this.states.clear();
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

  private touchStateKey(key: string): void {
    const state = this.states.get(key);
    if (!state) {
      return;
    }
    this.states.delete(key);
    this.states.set(key, state);
  }

  private trimStateCache(protectedKey?: string): void {
    while (this.states.size > photoStateCacheLimit) {
      const oldestKey = this.states.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      if (protectedKey && oldestKey === protectedKey) {
        const protectedState = this.states.get(oldestKey);
        if (!protectedState) {
          break;
        }
        this.states.delete(oldestKey);
        this.states.set(oldestKey, protectedState);
        continue;
      }
      const state = this.states.get(oldestKey);
      if (state) {
        this.disposeState(state);
      }
      this.states.delete(oldestKey);
    }
  }

  private render(state: PhotoState | null): void {
    if (!this.button || !this.debugDownloadButton || !this.statusLine || !this.statusSpinner) {
      return;
    }
    const button = this.button;
    const debugDownloadButton = this.debugDownloadButton;
    const statusLine = this.statusLine;
    const statusSpinner = this.statusSpinner;
    const finalizeRender = (): void => {
      this.queuePositionSyncAfterRender();
    };
    const updateStatusLine = (text: string, variant: 'normal' | 'error', running: boolean): void => {
      statusLine.textContent = text;
      statusLine.dataset.variant = variant;
      statusSpinner.dataset.running = running ? 'true' : 'false';
    };

    if (!state) {
      button.disabled = true;
      button.textContent = '翻译';
      debugDownloadButton.style.display = 'none';
      debugDownloadButton.disabled = true;
      updateStatusLine('', 'normal', false);
      finalizeRender();
      return;
    }

    const canShowDebugDownload = state.showTypesetDebug && !!state.debugLogData;
    debugDownloadButton.style.display = canShowDebugDownload ? 'inline-flex' : 'none';
    debugDownloadButton.disabled = !canShowDebugDownload || state.status === 'running';

    button.disabled = state.status === 'running';
    if (state.status === 'running') {
      button.textContent = '翻译中...';
      updateStatusLine(state.stageText || '准备中', 'normal', true);
      finalizeRender();
      return;
    }

    if (state.status === 'translated') {
      button.textContent = '显示原图';
      updateStatusLine(appendStatusDetail('翻译完成', state.elapsedText), 'normal', false);
      finalizeRender();
      return;
    }

    if (state.status === 'showingOriginal') {
      button.textContent = '显示译图';
      updateStatusLine(appendStatusDetail('当前显示原图', state.elapsedText), 'normal', false);
      finalizeRender();
      return;
    }

    if (state.status === 'error') {
      if (state.errorText.includes('\u672a\u627e\u5230\u6587\u672c')) {
        button.textContent = '\u91cd\u8bd5';
        updateStatusLine('\u672a\u627e\u5230\u6587\u672c', 'normal', false);
        finalizeRender();
        return;
      }
      button.textContent = '重试';
      updateStatusLine(`翻译失败：${state.errorText}`, 'error', false);
      finalizeRender();
      return;
    }

    button.textContent = '翻译';
    updateStatusLine('', 'normal', false);
    finalizeRender();
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

    const originalDisplayUrl = state.showTypesetDebug && state.debugOriginalUrl
      ? state.debugOriginalUrl
      : state.originalUrl;
    if (originalDisplayUrl && currentSrc !== originalDisplayUrl) {
      image.src = originalDisplayUrl;
      updateImageCompanionBackground(image, originalDisplayUrl);
    }
  }

  private getCurrentImageAndState(): { image: HTMLImageElement; key: string; state: PhotoState } {
    if (!this.activeDialog || !this.currentImageKey) {
      throw new Error('当前图片弹窗未激活');
    }
    const image = this.findCurrentImage(this.activeDialog);
    if (!image) {
      throw new Error('未找到当前图片');
    }
    const state = this.states.get(this.currentImageKey);
    if (!state) {
      throw new Error('未找到图片状态');
    }
    return {
      image,
      key: this.currentImageKey,
      state,
    };
  }

  private handleDownloadDebugLog(): void {
    let current: { state: PhotoState };
    try {
      current = this.getCurrentImageAndState();
    } catch {
      return;
    }
    if (!current.state.debugLogData) {
      return;
    }
    downloadJson(current.state.debugLogData, 'typeset-debug-log');
  }

  private async handleButtonClick(): Promise<void> {
    let current: { image: HTMLImageElement; key: string; state: PhotoState };
    try {
      current = this.getCurrentImageAndState();
    } catch {
      return;
    }
    const liveOriginalUrl = this.readImageOriginalUrl(current.image);
    if (liveOriginalUrl) {
      const liveKey = normalizeImageKey(liveOriginalUrl);
      if (liveKey !== current.key) {
        const liveState = this.ensureState(liveKey, liveOriginalUrl);
        if (!liveState.translatedUrl && liveState.status !== 'running') {
          liveState.originalUrl = liveOriginalUrl;
        }
        this.currentImageKey = liveKey;
        current = {
          image: current.image,
          key: liveKey,
          state: liveState,
        };
        this.render(liveState);
      }
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
      this.touchStateKey(key);
      state.errorText = '';
      state.stageText = '';
      this.applyImageFromState(image, state);
      this.render(state);
      return;
    }

    state.status = 'running';
    state.mode = 'original';
    state.errorText = '';
    state.elapsedText = '';
    state.debugLogData = undefined;
    state.stageText = '准备中';
    const runStartAt = performance.now();
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
      const validationError = validateActiveSettings(settingsResponse.settings);
      if (validationError) {
        throw new Error(validationError);
      }
      const showElapsedTime = settingsResponse.settings.showElapsedTime === true;
      const showStageTimingDetails =
        showElapsedTime && settingsResponse.settings.showStageTimingDetails === true;
      const showRuntimeStages = showStageTimingDetails;
      const showTypesetDebug = settingsResponse.settings.showTypesetDebug === true;
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
      const artifacts = await runPipeline(file, toPipelineConfig(settingsResponse.settings), (progress: PipelineProgress) => {
        const stageLabel = stageLabelMap[progress.stage] ?? progress.stage;
        if (progress.stage === 'parallel') {
          state.stageText = progress.detail;
        } else if (progress.stage === 'done') {
          state.stageText = '完成';
        } else {
          state.stageText = `${stageLabel}中`;
        }
        this.render(state);
      });

      const translatedBlob = await canvasToBlob(artifacts.resultCanvas);
      const translatedUrl = URL.createObjectURL(translatedBlob);
      if (state.translatedUrl) {
        URL.revokeObjectURL(state.translatedUrl);
      }
      if (state.debugOriginalUrl) {
        URL.revokeObjectURL(state.debugOriginalUrl);
        state.debugOriginalUrl = undefined;
      }
      if (showTypesetDebug && artifacts.debugOriginalCanvas) {
        const debugOriginalBlob = await canvasToBlob(artifacts.debugOriginalCanvas);
        state.debugOriginalUrl = URL.createObjectURL(debugOriginalBlob);
      }
      state.debugLogData = showTypesetDebug
        ? toTypesetDebugDownloadData(state.originalUrl, artifacts)
        : undefined;

      state.translatedUrl = translatedUrl;
      const totalDurationMs = performance.now() - runStartAt;
      state.elapsedText = showElapsedTime
        ? formatElapsedText(
            totalDurationMs,
            artifacts.stageTimings,
            artifacts.runtimeStages,
            showStageTimingDetails,
            showRuntimeStages
          )
        : '';
      state.stageText = '';
      state.errorText = '';
      state.mode = 'translated';
      state.status = 'translated';
      this.touchStateKey(key);
      this.trimStateCache(key);

      this.applyImageFromState(image, state);
      this.render(state);
    } catch (error) {
      state.status = 'error';
      state.errorText = toErrorMessage(error);
      state.stageText = '';
      state.elapsedText = '';
      state.debugLogData = undefined;
      this.render(state);
    }
  }
}

export function mountContentApp(): void {
  const app = new XOverlayTranslator();
  app.start();
}
