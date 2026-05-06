import type { ExtensionSettings } from '../../shared/config';
import type {
  ImageTarget,
  PhotoState,
  PipelineArtifacts,
  PipelineProgress,
  SiteAdapter,
  TextRegion,
  TypesetDebugDownloadData,
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
  handleDebugDownload,
  injectStyles,
  renderUi,
  type UiElements,
} from './ui';

const photoStateCacheLimit = 20;

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

const llmBaseUrlByProvider = {
  deepseek: 'https://api.deepseek.com',
  glm: 'https://api.z.ai/api/paas/v4',
  kimi: 'https://api.moonshot.ai/v1',
  minimax: 'https://api.minimax.io/v1',
  mimo: 'https://api.mimo-v2.com/v1',
} as const;

function resolveLlmBaseUrl(settings: ExtensionSettings): string {
  const profile = settings.llmProfiles[settings.llmProvider];
  if (settings.llmProvider === 'custom') return profile.customBaseUrl.trim();
  return llmBaseUrlByProvider[settings.llmProvider];
}

function resolveLlmModel(settings: ExtensionSettings): string {
  const profile = settings.llmProfiles[settings.llmProvider];
  if (settings.llmProvider === 'custom') return profile.modelCustom.trim();
  if (!profile.useCustomModel) return profile.modelPreset.trim();
  return profile.modelCustom.trim();
}

function validateActiveSettings(settings: ExtensionSettings): string | null {
  if (settings.translator !== 'llm') return null;
  if (!resolveLlmModel(settings)) return 'LLM 模型不能为空';
  const profile = settings.llmProfiles[settings.llmProvider];
  if (settings.llmProvider === 'custom' && !profile.customBaseUrl.trim()) {
    return '自定义提供商 Base URL 不能为空';
  }
  if (!profile.apiKey.trim()) return '未填写API Key，服务暂不可用';
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
      state.debugLogData = showTypesetDebug
        ? toTypesetDebugDownloadData(state.originalUrl, artifacts)
        : undefined;

      state.translatedUrl = translatedUrl;
      const totalDurationMs = performance.now() - runStartAt;
      state.elapsedText = showElapsedTime
        ? formatElapsedText(totalDurationMs, artifacts.stageTimings, artifacts.runtimeStages, showStageTimingDetails, showRuntimeStages)
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
}
