# Pixiv Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the monolithic Twitter-only content script into an adapter-based architecture and add Pixiv artwork page translation support.

**Architecture:** Extract shared logic (state management, pipeline invocation, UI rendering) into a `core/` layer. Each site implements a `SiteAdapter` interface that handles DOM detection, image discovery, and UI mounting. The entry point selects the matching adapter by URL.

**Tech Stack:** TypeScript, Chrome Extension MV3, ONNX Runtime Web, Vite

---

## File Structure

```
src/content/
  index.ts                    -- Entry: select adapter, start TranslatorCore (MODIFY)
  App.tsx                     -- DELETE after refactoring is complete
  core/
    types.ts                  -- CREATE: SiteAdapter, ImageTarget, PhotoState, etc.
    utils.ts                  -- CREATE: utility functions extracted from App.tsx
    ui.ts                     -- CREATE: UI DOM creation and rendering
    TranslatorCore.ts         -- CREATE: shared orchestration logic
  adapters/
    twitter.ts                -- CREATE: Twitter adapter (DOM logic from App.tsx)
    pixiv.ts                  -- CREATE: Pixiv adapter
src/background/index.ts       -- MODIFY: add Referer header for pximg.net
public/manifest.json          -- MODIFY: add Pixiv permissions and content script matches
```

---

### Task 1: Create core types

**Files:**
- Create: `src/content/core/types.ts`

- [ ] **Step 1: Create the types file with all shared interfaces**

```ts
// src/content/core/types.ts
import type {
  OcrRunDebugInfo,
  PipelineArtifacts,
  PipelineProgress,
  PipelineTypesetDebugLog,
  RuntimeStageStatus,
  StageTiming,
  TextRegion,
  TranslationDebugInfo,
} from '../../types';

export interface ImageTarget {
  element: HTMLImageElement;
  key: string;
  originalUrl: string;
}

export interface SiteAdapter {
  match(): boolean;
  findImages(): ImageTarget[];
  createUiAnchor(target: ImageTarget): HTMLElement;
  applyImage(target: ImageTarget, url: string): void;
  observe(onChange: () => void): () => void;
}

export type PhotoViewStatus = 'idle' | 'running' | 'translated' | 'showingOriginal' | 'error';
export type PhotoDisplayMode = 'translated' | 'original';

export type PhotoState = {
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

export type OcrRegionLogItem = {
  regionId: string;
  direction: TextRegion['direction'];
  box: TextRegion['box'];
  quad?: TextRegion['quad'];
  sourceText: string;
};

export type ModelRegionLogItem = {
  regionId: string;
  translatedTextRaw: string;
  translatedColumnsRaw: string[];
};

export type TypesetDebugDownloadData = {
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

export type { PipelineArtifacts, PipelineProgress, RuntimeStageStatus, StageTiming, TextRegion };
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to `src/content/core/types.ts`

- [ ] **Step 3: Commit**

```bash
git add src/content/core/types.ts
git commit -m "refactor: extract shared types to core/types.ts"
```

---

### Task 2: Create core utilities

**Files:**
- Create: `src/content/core/utils.ts`

- [ ] **Step 1: Create utils.ts with functions extracted from App.tsx**

```ts
// src/content/core/utils.ts
import type { RuntimeStageStatus, StageTiming } from './types';

export function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: contentType || 'image/jpeg' });
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
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

export function inferFileExtension(contentType: string, sourceUrl: string): string {
  if (contentType.includes('png')) return 'png';
  if (contentType.includes('webp')) return 'webp';
  if (contentType.includes('gif')) return 'gif';
  try {
    const format = new URL(sourceUrl).searchParams.get('format');
    if (format) return format;
  } catch {
    // ignore
  }
  return 'jpg';
}

export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0ms';
  if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(2)}s`;
  return `${Math.round(durationMs)}ms`;
}

export function formatRuntimeProvider(stage: RuntimeStageStatus): string {
  if (!stage.enabled) return 'disabled';
  if (!stage.provider) return 'unknown';
  if (stage.provider === 'wasm') return 'cpu(wasm)';
  if (stage.provider === 'webnn') return `webnn/${stage.webnnDeviceType ?? 'default'}`;
  return stage.provider;
}

export function formatRuntimeStagesLine(runtimeStages: RuntimeStageStatus[]): string {
  if (runtimeStages.length === 0) return '';
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
    if (!stage) continue;
    parts.push(`${modelLabels[model]}=${formatRuntimeProvider(stage)}`);
  }
  if (parts.length === 0) return '';
  return `运行时: ${parts.join(' / ')}`;
}

export function formatElapsedText(
  totalDurationMs: number,
  stageTimings: StageTiming[],
  runtimeStages: RuntimeStageStatus[],
  showStageDetails: boolean,
  showRuntimeStages: boolean,
): string {
  const stageLabelMap: Record<string, string> = {
    load: '加载图片',
    preload: '加载模型',
    detect: '文本检测',
    ocr: '文字识别',
    merge: '合并文本',
    parallel: '并行处理',
    translate: '翻译文本',
    mask_refine: '细化遮罩',
    inpaint: '去除文字',
    typeset: '文字排版',
    done: '完成',
  };
  const totalLine = `总耗时：${formatDuration(totalDurationMs)}`;
  const runtimeLine = showRuntimeStages ? formatRuntimeStagesLine(runtimeStages) : '';
  if (!showStageDetails || stageTimings.length === 0) {
    return runtimeLine ? [totalLine, runtimeLine].join('\n') : totalLine;
  }
  const detailLines = stageTimings.map((timing) => {
    const label = stageLabelMap[timing.stage] ?? timing.label ?? timing.stage;
    return `${label}：${formatDuration(timing.durationMs)}`;
  });
  return runtimeLine
    ? [totalLine, runtimeLine, ...detailLines].join('\n')
    : [totalLine, ...detailLines].join('\n');
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function downloadJson(data: unknown, filenamePrefix: string): void {
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
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/content/core/utils.ts
git commit -m "refactor: extract utility functions to core/utils.ts"
```

---

### Task 3: Create core UI module

**Files:**
- Create: `src/content/core/ui.ts`

- [ ] **Step 1: Create ui.ts with UI creation and rendering logic**

```ts
// src/content/core/ui.ts
import type { PhotoState } from './types';
import { downloadJson } from './utils';

const styleId = 'mt-overlay-style';

export type UiElements = {
  host: HTMLElement;
  button: HTMLButtonElement;
  debugDownloadButton: HTMLButtonElement;
  statusLine: HTMLDivElement;
  statusSpinner: HTMLSpanElement;
};

export function resolveRuntimeAssetUrl(path: string): string | null {
  const chromeApi = (globalThis as typeof globalThis & { chrome?: { runtime?: { getURL?: (p: string) => string } } }).chrome;
  return chromeApi?.runtime?.getURL ? chromeApi.runtime.getURL(path) : null;
}

export function injectStyles(): void {
  if (document.getElementById(styleId)) return;
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

export function createUiElements(): UiElements {
  const root = document.createElement('div');
  root.className = 'mt-x-overlay-inline';

  const actions = document.createElement('div');
  actions.className = 'mt-x-actions';

  const button = document.createElement('button');
  button.className = 'mt-x-control';
  button.type = 'button';
  button.textContent = '翻译';
  actions.appendChild(button);

  const debugDownloadButton = document.createElement('button');
  debugDownloadButton.className = 'mt-x-control mt-x-control-secondary';
  debugDownloadButton.type = 'button';
  debugDownloadButton.textContent = '下载日志';
  debugDownloadButton.style.display = 'none';
  actions.appendChild(debugDownloadButton);

  root.appendChild(actions);

  const statusWrap = document.createElement('div');
  statusWrap.className = 'mt-x-status';
  const statusSpinner = document.createElement('span');
  statusSpinner.className = 'mt-x-status-spinner';
  statusSpinner.dataset.running = 'false';
  const statusLine = document.createElement('div');
  statusLine.className = 'mt-x-status-text';
  statusWrap.appendChild(statusSpinner);
  statusWrap.appendChild(statusLine);
  root.appendChild(statusWrap);

  const host = document.createElement('div');
  host.appendChild(root);

  return { host, button, debugDownloadButton, statusLine, statusSpinner };
}

export function renderUi(ui: UiElements, state: PhotoState | null): void {
  const { button, debugDownloadButton, statusLine, statusSpinner } = ui;

  const updateStatusLine = (text: string, variant: 'normal' | 'error', running: boolean): void => {
    statusLine.textContent = text;
    statusLine.dataset.variant = variant;
    statusSpinner.dataset.running = running ? 'true' : 'false';
  };

  if (!state) {
    button.disabled = true;
    button.textContent = '翻译';
    debugDownloadButton.style.display = 'none';
    updateStatusLine('', 'normal', false);
    return;
  }

  const canShowDebugDownload = state.showTypesetDebug && !!state.debugLogData;
  debugDownloadButton.style.display = canShowDebugDownload ? 'inline-flex' : 'none';
  debugDownloadButton.disabled = !canShowDebugDownload || state.status === 'running';

  button.disabled = state.status === 'running';
  if (state.status === 'running') {
    button.textContent = '翻译中...';
    updateStatusLine(state.stageText || '准备中', 'normal', true);
    return;
  }

  if (state.status === 'translated') {
    button.textContent = '显示原图';
    const detail = state.elapsedText ? `翻译完成\n${state.elapsedText}` : '翻译完成';
    updateStatusLine(detail, 'normal', false);
    return;
  }

  if (state.status === 'showingOriginal') {
    button.textContent = '显示译图';
    const detail = state.elapsedText ? `当前显示原图\n${state.elapsedText}` : '当前显示原图';
    updateStatusLine(detail, 'normal', false);
    return;
  }

  if (state.status === 'error') {
    if (state.errorText.includes('未找到文本')) {
      button.textContent = '重试';
      updateStatusLine('未找到文本', 'normal', false);
      return;
    }
    button.textContent = '重试';
    updateStatusLine(`翻译失败：${state.errorText}`, 'error', false);
    return;
  }

  button.textContent = '翻译';
  updateStatusLine('', 'normal', false);
}

export function handleDebugDownload(state: PhotoState): void {
  if (!state.debugLogData) return;
  downloadJson(state.debugLogData, 'typeset-debug-log');
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/content/core/ui.ts
git commit -m "refactor: extract UI rendering to core/ui.ts"
```

---

### Task 4: Create TranslatorCore

**Files:**
- Create: `src/content/core/TranslatorCore.ts`

- [ ] **Step 1: Create TranslatorCore with shared orchestration logic**

```ts
// src/content/core/TranslatorCore.ts
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
  parallel: '并行处理',
  translate: '翻译文本',
  mask_refine: '细化遮罩',
  inpaint: '去除文字',
  typeset: '文字排版',
  done: '完成',
};

const llmBaseUrlByProvider = {
  deepseek: 'https://api.deepseek.com',
  glm: 'https://api.z.ai/api/paas/v4',
  kimi: 'https://api.moonshot.ai/v1',
  minimax: 'https://api.minimax.io/v1',
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

    // Remove mounted UIs for images no longer present
    for (const [key, mounted] of this.mounted) {
      if (!currentKeys.has(key)) {
        mounted.ui.host.remove();
        this.mounted.delete(key);
      }
    }

    // Mount UI for new images
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

    // Toggle between translated/original if already translated
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

    // Start translation
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
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/content/core/TranslatorCore.ts
git commit -m "refactor: create TranslatorCore with shared orchestration logic"
```

---

### Task 5: Create Twitter adapter

**Files:**
- Create: `src/content/adapters/twitter.ts`

- [ ] **Step 1: Create twitter.ts with Twitter-specific DOM logic**

This adapter preserves the existing Twitter behavior: detect the photo dialog, find the visible media image, and position the UI anchored to a reference button (with fallback to top-right corner).

```ts
// src/content/adapters/twitter.ts
import type { ImageTarget, SiteAdapter } from '../core/types';

const imageDialogSelector = '[aria-labelledby="modal-header"][role="dialog"]';
const originalSrcAttr = 'data-mt-original-src';

function isVisibleElement(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 32 || rect.height < 32) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

function isMediaImageSource(src: string): boolean {
  if (!src) return false;
  if (src.startsWith('blob:')) return true;
  return src.includes('pbs.twimg.com/media/');
}

function isDialogMediaImage(image: HTMLImageElement): boolean {
  if (!isVisibleElement(image)) return false;
  const src = image.currentSrc || image.src;
  if (!isMediaImageSource(src)) return false;
  if (src.startsWith('blob:') && !image.hasAttribute(originalSrcAttr)) return false;
  return true;
}

function normalizeImageKey(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== 'pbs.twimg.com') return url.toString();
    const format = url.searchParams.get('format');
    const base = `${url.origin}${url.pathname}`;
    return format ? `${base}?format=${format}` : base;
  } catch {
    return rawUrl;
  }
}

function findPhotoDialog(): HTMLElement | null {
  const dialogs = Array.from(document.querySelectorAll<HTMLElement>(imageDialogSelector));
  for (const dialog of dialogs) {
    if (!isVisibleElement(dialog)) continue;
    if (findCurrentImage(dialog)) return dialog;
  }
  return null;
}

function findCurrentImage(dialog: HTMLElement): HTMLImageElement | null {
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
    if (!isDialogMediaImage(image)) continue;
    const rect = image.getBoundingClientRect();
    const area = rect.width * rect.height;
    if (area > bestArea) {
      bestArea = area;
      best = image;
    }
  }
  return best;
}

function readImageOriginalUrl(image: HTMLImageElement): string {
  const src = image.currentSrc || image.src;
  const attrOriginal = image.getAttribute(originalSrcAttr);
  if (attrOriginal) {
    if (!src || src.startsWith('blob:')) return attrOriginal;
    const leftId = getTwitterMediaIdentity(attrOriginal);
    const rightId = getTwitterMediaIdentity(src);
    if (leftId && rightId && leftId === rightId) return attrOriginal;
    image.removeAttribute(originalSrcAttr);
  }
  if (!src || src.startsWith('blob:')) return '';
  return src;
}

function getTwitterMediaIdentity(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.hostname !== 'pbs.twimg.com' || !url.pathname.startsWith('/media/')) return null;
    const format = url.searchParams.get('format');
    return format ? `${url.pathname}?format=${format}` : url.pathname;
  } catch {
    return null;
  }
}

function updateImageCompanionBackground(image: HTMLImageElement, targetUrl: string): void {
  const previous = image.previousElementSibling;
  if (!previous || !(previous instanceof HTMLElement)) return;
  if (!previous.style.backgroundImage) return;
  previous.style.backgroundImage = `url("${targetUrl}")`;
}

const referenceButtonSelector =
  '#layers > div:nth-child(2) > div > div > div > div > div > div.css-175oi2r.r-1ny4l3l.r-18u37iz.r-1pi2tsx.r-1777fci.r-1xcajam.r-ipm5af.r-g6jmlv.r-1awozwy > div.css-175oi2r.r-1wbh5a2.r-htvplk.r-1udh08x.r-17gur6a.r-1pi2tsx.r-13qz1uu > div.css-175oi2r.r-18u37iz.r-1pi2tsx.r-11yh6sk.r-buy8e9.r-bnwqim.r-13qz1uu > div.css-175oi2r.r-16y2uox.r-1wbh5a2 > div.css-175oi2r.r-1awozwy.r-1loqt21.r-1777fci.r-xyw6el.r-u8s1d.r-ipm5af.r-zchlnj';
const anchoredVerticalGapPx = 8;
const fallbackHostInsetPx = 16;

export const twitterAdapter: SiteAdapter = {
  match() {
    const host = location.hostname;
    return host === 'x.com' || host === 'twitter.com';
  },

  findImages() {
    const dialog = findPhotoDialog();
    if (!dialog) return [];
    const image = findCurrentImage(dialog);
    if (!image) return [];
    const originalUrl = readImageOriginalUrl(image);
    if (!originalUrl) return [];
    const key = normalizeImageKey(originalUrl);
    image.setAttribute(originalSrcAttr, originalUrl);
    return [{ element: image, key, originalUrl }];
  },

  createUiAnchor(target) {
    const dialog = target.element.closest(imageDialogSelector) as HTMLElement | null;
    const anchor = document.createElement('div');
    anchor.style.cssText = `position:absolute; right:${fallbackHostInsetPx}px; top:${fallbackHostInsetPx}px; z-index:1000;`;

    // Try to position relative to reference button
    const refButton = document.querySelector(referenceButtonSelector) as HTMLElement | null;
    if (dialog && refButton && isVisibleElement(refButton) && dialog.contains(refButton)) {
      const anchorRect = refButton.getBoundingClientRect();
      const dialogRect = dialog.getBoundingClientRect();
      const left = anchorRect.right - dialogRect.left - 200;
      const top = anchorRect.bottom - dialogRect.top + anchoredVerticalGapPx;
      anchor.style.cssText = `position:absolute; left:${Math.max(0, Math.round(left))}px; top:${Math.max(0, Math.round(top))}px; z-index:1000;`;
    }

    if (dialog) {
      dialog.appendChild(anchor);
    } else {
      document.body.appendChild(anchor);
    }
    return anchor;
  },

  applyImage(target, url) {
    target.element.src = url;
    target.element.setAttribute(originalSrcAttr, target.originalUrl);
    updateImageCompanionBackground(target.element, url);
  },

  observe(onChange) {
    const root = document.querySelector('#layers') ?? document.body;
    const observer = new MutationObserver((mutations) => {
      if (!mutations.some((m) => m.type === 'childList')) return;
      onChange();
    });
    observer.observe(root, { childList: true, subtree: true });

    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = (...args) => { origPush.apply(history, args); onChange(); };
    history.replaceState = (...args) => { origReplace.apply(history, args); onChange(); };
    window.addEventListener('popstate', onChange);

    return () => {
      observer.disconnect();
      history.pushState = origPush;
      history.replaceState = origReplace;
      window.removeEventListener('popstate', onChange);
    };
  },
};
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/content/adapters/twitter.ts
git commit -m "refactor: create Twitter adapter from XOverlayTranslator"
```

---

### Task 6: Create Pixiv adapter

**Files:**
- Create: `src/content/adapters/pixiv.ts`

- [ ] **Step 1: Create pixiv.ts**

```ts
// src/content/adapters/pixiv.ts
import type { ImageTarget, SiteAdapter } from '../core/types';

function extractPixivImageKey(url: string): string {
  // Extract "144443654_p0" from URL like .../144443654_p0.png
  const match = url.match(/(\d+_p\d+)/);
  return match ? match[1] : url;
}

export const pixivAdapter: SiteAdapter = {
  match() {
    return location.hostname === 'www.pixiv.net'
      && location.pathname.startsWith('/artworks/');
  },

  findImages() {
    const links = document.querySelectorAll<HTMLAnchorElement>('a.gtm-expand-full-size-illust');
    const targets: ImageTarget[] = [];
    for (const link of links) {
      const img = link.querySelector('img');
      if (!img || !link.href.includes('i.pximg.net')) continue;
      const key = extractPixivImageKey(link.href);
      targets.push({ element: img, key, originalUrl: link.href });
    }
    return targets;
  },

  createUiAnchor(target) {
    const existingAnchor = target.element.closest('.sc-fddeba56-0')?.querySelector('[data-mt-pixiv-anchor]');
    if (existingAnchor instanceof HTMLElement) return existingAnchor;

    const wrapper = target.element.closest('.sc-fddeba56-0') as HTMLElement | null;
    if (wrapper) {
      wrapper.style.position = 'relative';
    }
    const anchor = document.createElement('div');
    anchor.setAttribute('data-mt-pixiv-anchor', '');
    anchor.style.cssText = 'position:absolute; right:12px; top:12px; z-index:10;';
    (wrapper || target.element.parentElement!).appendChild(anchor);
    return anchor;
  },

  applyImage(target, url) {
    target.element.src = url;
  },

  observe(onChange) {
    const observer = new MutationObserver(() => onChange());
    const root = document.querySelector('#root') || document.body;
    observer.observe(root, { childList: true, subtree: true });

    const origPush = history.pushState;
    const origReplace = history.replaceState;
    history.pushState = (...args) => { origPush.apply(history, args); onChange(); };
    history.replaceState = (...args) => { origReplace.apply(history, args); onChange(); };
    window.addEventListener('popstate', onChange);

    return () => {
      observer.disconnect();
      history.pushState = origPush;
      history.replaceState = origReplace;
      window.removeEventListener('popstate', onChange);
    };
  },
};
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/content/adapters/pixiv.ts
git commit -m "feat: add Pixiv site adapter"
```

---

### Task 7: Update entry point and remove old App.tsx

**Files:**
- Modify: `src/content/index.ts`
- Delete: `src/content/App.tsx`

- [ ] **Step 1: Replace src/content/index.ts with new entry point**

```ts
// src/content/index.ts
import { shinobuBake, shinobuRender } from '../pipeline/bake';
import { twitterAdapter } from './adapters/twitter';
import { pixivAdapter } from './adapters/pixiv';
import { TranslatorCore } from './core/TranslatorCore';

(window as any).__shinobu_bake__ = shinobuBake;

// Bridge for benchmark baking: listen for postMessage from main world
window.addEventListener("message", async (event) => {
  if (event.data?.type === "__shinobu_bake_request__") {
    try {
      const result = await shinobuBake(event.data.dataUrl);
      window.postMessage({ type: "__shinobu_bake_response__", result }, "*");
    } catch (e: any) {
      window.postMessage({ type: "__shinobu_bake_response__", error: e.message }, "*");
    }
  } else if (event.data?.type === "__shinobu_render_request__") {
    try {
      const result = await shinobuRender(event.data.dataUrl);
      window.postMessage({ type: "__shinobu_render_response__", result }, "*");
    } catch (e: any) {
      window.postMessage({ type: "__shinobu_render_response__", error: e.message }, "*");
    }
  }
});
// Signal that the bake bridge is ready
window.postMessage({ type: "__shinobu_bake_ready__" }, "*");

const adapters = [twitterAdapter, pixivAdapter];
const adapter = adapters.find(a => a.match());
if (adapter) {
  const core = new TranslatorCore(adapter);
  core.start();
}
```

- [ ] **Step 2: Delete src/content/App.tsx**

```bash
rm src/content/App.tsx
```

- [ ] **Step 3: Verify TypeScript compiles and build succeeds**

Run: `npx tsc --noEmit --pretty 2>&1 | head -30`
Run: `npm run build 2>&1 | tail -10`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/content/index.ts
git rm src/content/App.tsx
git commit -m "refactor: replace monolithic App.tsx with adapter-based architecture"
```

---

### Task 8: Add Referer support in background script

**Files:**
- Modify: `src/background/index.ts:78-107`

- [ ] **Step 1: Add getRefererForUrl function and use it in downloadImage**

Add above `downloadImage`:

```ts
function getRefererForUrl(url: string): string | undefined {
  try {
    const hostname = new URL(url).hostname;
    if (hostname === 'i.pximg.net' || hostname.endsWith('.pximg.net')) {
      return 'https://www.pixiv.net/';
    }
  } catch {
    // ignore
  }
  return undefined;
}
```

Then modify the `fetch` call inside `downloadImage` to include the Referer header:

```ts
// In the for loop, change:
const response = await fetch(url, { method: 'GET', cache: 'no-store' });
// To:
const headers: Record<string, string> = {};
const referer = getRefererForUrl(url);
if (referer) headers['Referer'] = referer;
const response = await fetch(url, { method: 'GET', cache: 'no-store', headers });
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/background/index.ts
git commit -m "feat: add Referer header for pximg.net image downloads"
```

---

### Task 9: Update manifest.json

**Files:**
- Modify: `public/manifest.json`

- [ ] **Step 1: Add Pixiv URLs to host_permissions, content_scripts, and web_accessible_resources**

Add `"https://www.pixiv.net/*"` and `"https://i.pximg.net/*"` to `host_permissions`.

Add `"https://www.pixiv.net/*"` to `content_scripts[0].matches`.

Add `"https://www.pixiv.net/*"` to `web_accessible_resources[0].matches`.

The full updated manifest:

```json
{
  "manifest_version": 3,
  "name": "ShinobuTranslator",
  "version": "0.1.0",
  "description": "在 X/Twitter 图片大图中执行漫画翻译，并支持原图/译图切换。",
  "action": {
    "default_title": "ShinobuTranslator",
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "32": "icons/icon32.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "32": "icons/icon32.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
  },
  "permissions": [
    "storage"
  ],
  "host_permissions": [
    "https://x.com/*",
    "https://twitter.com/*",
    "https://pbs.twimg.com/*",
    "https://www.pixiv.net/*",
    "https://i.pximg.net/*",
    "https://translate.googleapis.com/*",
    "https://api.deepseek.com/*",
    "https://api.z.ai/*",
    "https://api.moonshot.ai/*",
    "https://api.minimax.io/*"
  ],
  "content_scripts": [
    {
      "matches": [
        "https://x.com/*",
        "https://twitter.com/*",
        "https://www.pixiv.net/*"
      ],
      "js": [
        "content.js"
      ],
      "run_at": "document_idle"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": [
        "chunks/*",
        "fonts/*",
        "models/*",
        "ort/*"
      ],
      "matches": [
        "https://x.com/*",
        "https://twitter.com/*",
        "https://www.pixiv.net/*"
      ]
    }
  ]
}
```

- [ ] **Step 2: Verify build succeeds**

Run: `npm run build 2>&1 | tail -10`
Expected: Build completes successfully

- [ ] **Step 3: Commit**

```bash
git add public/manifest.json
git commit -m "feat: add Pixiv to manifest permissions and content scripts"
```

---

### Task 10: End-to-end verification on Pixiv

**Files:** None (manual testing)

- [ ] **Step 1: Build the extension**

Run: `npm run build`
Expected: Clean build, no errors

- [ ] **Step 2: Load the extension in Chrome and test on Pixiv**

1. Open `chrome://extensions` → Load unpacked → select `dist/` folder
2. Navigate to `https://www.pixiv.net/artworks/144443654`
3. Verify: translation button appears at top-right of artwork image
4. Click "翻译" → verify pipeline runs and image is replaced with translated version
5. Click "显示原图" → verify original image is restored
6. Navigate to a different artwork via SPA navigation → verify button re-mounts

- [ ] **Step 3: Test on Twitter to verify no regression**

1. Navigate to `https://x.com`
2. Open a tweet with an image → click to open the photo dialog
3. Verify: translation button appears in the dialog
4. Click "翻译" → verify pipeline runs successfully
