import type { PhotoState } from './types';
import { downloadJson } from './utils';

const styleId = 'mt-overlay-style';

export type UiElements = {
  host: HTMLElement;
  button: HTMLButtonElement;
  buttonIcon: HTMLSpanElement;
  buttonSpinner: HTMLSpanElement;
  buttonLabel: HTMLSpanElement;
  detailLine: HTMLDivElement;
  debugDownloadButton: HTMLButtonElement;
};

const ICONS = {
  translate: `<svg viewBox="0 0 16 16"><text x="1.5" y="11" font-size="8.5" fill="currentColor" font-family="sans-serif" font-weight="700">文</text><text x="8.5" y="11" font-size="8.5" fill="currentColor" font-family="sans-serif" font-weight="700">A</text></svg>`,
  original: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="3" width="13" height="10" rx="1.5"/><circle cx="5" cy="6" r="1.5" fill="currentColor"/><path d="M1.5 11l4-3 2 2 3-2.5 3.5 2.5"/></svg>`,
  translated: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="3" width="13" height="10" rx="1.5"/><circle cx="5" cy="6" r="1.5" fill="currentColor"/><path d="M1.5 11l4-3 2 2 3-2.5 3.5 2.5"/><rect x="5" y="5.5" width="7.5" height="4" rx="1" fill="currentColor" opacity="0.75"/></svg>`,
  retry: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8A5 5 0 1 1 8 3"/><path d="M8 3l2.5 2.5"/></svg>`,
};

type IconKey = keyof typeof ICONS;

// Transition animation timer tracking
const animTimers: number[] = [];
let widthCleanupTimer: number = 0;
let transitionGen = 0;

function clearTransitionTimers(): void {
  for (const t of animTimers) clearTimeout(t);
  animTimers.length = 0;
  clearTimeout(widthCleanupTimer);
}

function scheduleTimer(fn: () => void, ms: number): void {
  animTimers.push(window.setTimeout(fn, ms));
}

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

    /* Dark theme (Twitter) — default fallback */
    [data-theme='dark'] {
      --mt-bg: oklch(0.14 0.01 250 / 0.72);
      --mt-bg-hover: oklch(0.14 0.01 250 / 0.85);
      --mt-bg-active: oklch(0.14 0.01 250 / 0.92);
      --mt-bg-secondary: oklch(0.16 0.03 175 / 0.72);
      --mt-border: oklch(0.92 0.01 250 / 0.85);
      --mt-border-secondary: oklch(0.85 0.05 175 / 0.7);
      --mt-text: oklch(0.94 0.01 250);
      --mt-text-detail: oklch(0.94 0.01 250 / 0.7);
      --mt-text-shadow: 0 1px 3px oklch(0.1 0 0 / 0.6);
      --mt-focus: oklch(0.6 0.15 250 / 0.8);
      --mt-error-text: oklch(0.82 0.12 25 / 0.85);
      --mt-glow-center: oklch(0.95 0.03 250 / 0.22);
      --mt-glow-mid: oklch(0.95 0.03 250 / 0.04);
    }

    /* Light theme (Pixiv) */
    [data-theme='light'] {
      --mt-bg: oklch(0.97 0.005 250 / 0.82);
      --mt-bg-hover: oklch(0.97 0.005 250 / 0.88);
      --mt-bg-active: oklch(0.97 0.005 250 / 0.92);
      --mt-bg-secondary: oklch(0.92 0.03 175 / 0.82);
      --mt-border: oklch(0.55 0.01 250 / 0.7);
      --mt-border-secondary: oklch(0.4 0.05 175 / 0.7);
      --mt-text: oklch(0.2 0.01 250);
      --mt-text-detail: oklch(0.2 0.01 250 / 0.7);
      --mt-text-shadow: 0 1px 3px oklch(0.97 0.005 250 / 0.5);
      --mt-focus: oklch(0.5 0.15 250 / 0.8);
      --mt-error-text: oklch(0.45 0.12 25 / 0.85);
      --mt-glow-center: oklch(0.35 0.02 250 / 0.18);
      --mt-glow-mid: oklch(0.35 0.02 250 / 0.03);
    }

    .mt-x-overlay-inline {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 4px;
    }
    .mt-x-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .mt-x-control {
      display: inline-flex;
      align-items: center;
      justify-content: flex-start;
      gap: 6px;
      height: 36px;
      position: relative;
      border: 1px solid var(--mt-border, oklch(0.92 0.01 250 / 0.85));
      border-radius: 999px;
      padding: 0 10px;
      cursor: pointer;
      background-color: var(--mt-bg, oklch(0.14 0.01 250 / 0.72));
      backdrop-filter: blur(16px) saturate(1.4);
      -webkit-backdrop-filter: blur(16px) saturate(1.4);
      color: var(--mt-text, oklch(0.94 0.01 250));
      font-size: 13px;
      font-weight: 500;
      line-height: 1;
      letter-spacing: 0.02em;
      transition: background-color 0.2s ease-out;
      outline: none;
      user-select: none;
    }
    .mt-x-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
      transition: opacity 0.15s ease-out;
    }
    .mt-x-icon svg {
      width: 16px;
      height: 16px;
    }
    .mt-x-control[data-status='running'] .mt-x-icon {
      display: none;
    }
    .mt-x-spinner {
      display: none;
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
      will-change: transform;
      animation: mt-x-spin-rotate 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }
    .mt-x-spinner svg {
      width: 16px;
      height: 16px;
    }
    .mt-x-spinner svg circle {
      fill: none;
      stroke: currentColor;
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-dasharray: 1, 37.7;
      animation: mt-x-spin-arc 1.8s ease-in-out infinite;
    }
    .mt-x-control[data-status='running'] .mt-x-spinner {
      display: inline-flex;
    }
    .mt-x-label {
      white-space: nowrap;
      transition: opacity 0.15s ease-out;
    }
    .mt-x-control:hover:not(:disabled) {
      background-color: var(--mt-bg-hover, oklch(0.14 0.01 250 / 0.85));
    }
    .mt-x-control:active:not(:disabled) {
      background-color: var(--mt-bg-active, oklch(0.14 0.01 250 / 0.92));
    }
    .mt-x-control:focus-visible {
      box-shadow: 0 0 0 2px var(--mt-focus, oklch(0.6 0.15 250 / 0.8));
    }
    .mt-x-control:disabled:not([data-status='running']) {
      opacity: 0.5;
      cursor: default;
    }
    .mt-x-control[data-status='running'] {
      pointer-events: none;
      overflow: hidden;
    }
    .mt-x-control[data-status='running']::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: linear-gradient(
        90deg,
        transparent 0%,
        var(--mt-glow-mid, oklch(0.95 0.03 250 / 0.04)) 25%,
        var(--mt-glow-center, oklch(0.95 0.03 250 / 0.22)) 50%,
        var(--mt-glow-mid, oklch(0.95 0.03 250 / 0.04)) 75%,
        transparent 100%
      );
      animation: mt-x-glow-sweep 1.5s linear infinite;
      pointer-events: none;
    }
    .mt-x-control-secondary {
      min-width: 92px;
      justify-content: center;
      padding: 0 14px;
      background-color: var(--mt-bg-secondary, oklch(0.16 0.03 175 / 0.72));
      border-color: var(--mt-border-secondary, oklch(0.85 0.05 175 / 0.7));
    }
    .mt-x-detail {
      max-width: 260px;
      color: var(--mt-text-detail, oklch(0.94 0.01 250 / 0.7));
      text-shadow: var(--mt-text-shadow, 0 1px 3px oklch(0.1 0 0 / 0.6));
      font-size: 12px;
      line-height: 1.4;
      white-space: pre-line;
    }
    .mt-x-detail[data-variant='error'] {
      color: var(--mt-error-text, oklch(0.82 0.12 25 / 0.85));
    }
    @keyframes mt-x-glow-sweep {
      0%, 10% { transform: translateX(-150%); }
      40% { transform: translateX(0%); }
      60% { transform: translateX(150%); }
      90%, 100% { transform: translateX(250%); }
    }
    @keyframes mt-x-spin-rotate {
      to { transform: rotate(360deg); }
    }
    @keyframes mt-x-spin-arc {
      0% {
        stroke-dasharray: 1, 37.7;
        stroke-dashoffset: 0;
      }
      50% {
        stroke-dasharray: 25, 37.7;
        stroke-dashoffset: -12;
      }
      100% {
        stroke-dasharray: 1, 37.7;
        stroke-dashoffset: -37.7;
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
  const buttonIcon = document.createElement('span');
  buttonIcon.className = 'mt-x-icon';
  buttonIcon.innerHTML = ICONS.translate;
  const buttonSpinner = document.createElement('span');
  buttonSpinner.className = 'mt-x-spinner';
  buttonSpinner.innerHTML = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>';
  const buttonLabel = document.createElement('span');
  buttonLabel.className = 'mt-x-label';
  buttonLabel.textContent = '翻译';
  button.appendChild(buttonIcon);
  button.appendChild(buttonSpinner);
  button.appendChild(buttonLabel);
  actions.appendChild(button);

  const debugDownloadButton = document.createElement('button');
  debugDownloadButton.className = 'mt-x-control mt-x-control-secondary';
  debugDownloadButton.type = 'button';
  debugDownloadButton.textContent = '下载日志';
  debugDownloadButton.style.display = 'none';
  actions.appendChild(debugDownloadButton);

  root.appendChild(actions);

  const detailLine = document.createElement('div');
  detailLine.className = 'mt-x-detail';
  root.appendChild(detailLine);

  const host = document.createElement('div');
  host.appendChild(root);

  return { host, button, buttonIcon, buttonSpinner, buttonLabel, detailLine, debugDownloadButton };
}

export function renderUi(ui: UiElements, state: PhotoState | null): void {
  const { button, buttonIcon, buttonLabel, detailLine, debugDownloadButton } = ui;

  const updateStatusLine = (text: string, variant: 'normal' | 'error' = 'normal'): void => {
    detailLine.textContent = text;
    detailLine.dataset.variant = variant;
  };

  if (!state) {
    button.disabled = true;
    button.dataset.status = '';
    buttonIcon.innerHTML = ICONS.translate;
    buttonLabel.textContent = '翻译';
    updateStatusLine('');
    debugDownloadButton.style.display = 'none';
    clearTransitionTimers();
    return;
  }

  const canShowDebugDownload = state.showTypesetDebug && !!state.debugLogData;
  debugDownloadButton.style.display = canShowDebugDownload ? 'inline-flex' : 'none';
  debugDownloadButton.disabled = !canShowDebugDownload || state.status === 'running';

  const prevStatus = button.dataset.status;
  const prevWidth = button.getBoundingClientRect().width;
  const prevText = buttonLabel.textContent || '';
  const prevIconHtml = buttonIcon.innerHTML;

  // Detect transitions: status change OR stageText change during running
  const statusChanged = !!prevStatus && prevStatus !== '' && state.status !== prevStatus;
  const stageTextChanged = prevStatus === 'running' && state.status === 'running'
    && prevText !== (state.stageText || '翻译中...');
  const isTransition = statusChanged || stageTextChanged;
  const iconChange = statusChanged;

  button.dataset.status = state.status;
  button.disabled = state.status === 'running';

  let nextText: string;
  let nextIconKey: IconKey;
  let nextDetailText: string;
  let nextDetailVariant: 'normal' | 'error' = 'normal';

  if (state.status === 'running') {
    nextText = state.stageText || '翻译中...';
    nextIconKey = 'translate';
    nextDetailText = '';
  } else if (state.status === 'translated') {
    nextText = '显示原图';
    nextIconKey = 'original';
    nextDetailText = state.elapsedText ? `翻译完成\n${state.elapsedText}` : '翻译完成';
  } else if (state.status === 'showingOriginal') {
    nextText = '显示译图';
    nextIconKey = 'translated';
    nextDetailText = state.elapsedText ? `当前显示原图\n${state.elapsedText}` : '当前显示原图';
  } else if (state.status === 'error') {
    nextText = '重试';
    nextIconKey = 'retry';
    nextDetailText = state.errorText.includes('未找到文本') ? '未找到文本' : `翻译失败：${state.errorText}`;
    if (!state.errorText.includes('未找到文本')) nextDetailVariant = 'error';
  } else {
    nextText = '翻译';
    nextIconKey = 'translate';
    nextDetailText = '';
  }

  updateStatusLine(nextDetailText, nextDetailVariant);

  if (!isTransition) {
    buttonIcon.innerHTML = ICONS[nextIconKey];
    buttonLabel.textContent = nextText;
    return;
  }

  transitionGen++;
  const myGen = transitionGen;
  clearTransitionTimers();

  const fromRunning = prevStatus === 'running';

  // Pre-measure target width: temporarily render target state, measure, then restore
  buttonLabel.textContent = nextText;
  if (iconChange) buttonIcon.innerHTML = ICONS[nextIconKey];
  button.style.width = '';
  button.style.overflow = '';
  button.style.transition = '';
  const targetWidth = button.getBoundingClientRect().width;

  // Restore pre-animation content
  buttonLabel.textContent = prevText;
  if (iconChange) buttonIcon.innerHTML = prevIconHtml;
  button.style.width = `${prevWidth}px`;
  button.style.overflow = 'hidden';
  button.style.transition = '';

  const eraseDelay = 30;
  const writeDelay = 35;
  const eraseLen = prevText.length;
  const writeLen = nextText.length;
  const eraseTotalMs = eraseLen * eraseDelay;
  const writeTotalMs = writeLen * writeDelay;
  const midGapMs = 40;

  // Phase 1: Erase characters from right, width stays locked at prevWidth
  for (let i = eraseLen - 1; i >= 0; i--) {
    const delay = (eraseLen - 1 - i) * eraseDelay;
    scheduleTimer(() => {
      if (transitionGen !== myGen) return;
      buttonLabel.textContent = prevText.slice(0, i);
    }, delay);
  }

  // After erase: transition width from prevWidth to targetWidth
  const eraseEndDelay = eraseLen === 0 ? 0 : eraseTotalMs + 20;
  const widthTransitionMs = Math.max(150, writeTotalMs);
  scheduleTimer(() => {
    if (transitionGen !== myGen) return;
    button.style.transition = `width ${widthTransitionMs}ms cubic-bezier(0.25, 1, 0.5, 1)`;
    button.style.width = `${targetWidth}px`;
  }, eraseEndDelay);

  // Midpoint: swap icon (only on status change, not stageText change)
  if (iconChange) {
    const midDelay = eraseLen === 0 ? 0 : eraseTotalMs + midGapMs;
    scheduleTimer(() => {
      if (transitionGen !== myGen) return;
      if (fromRunning) {
        buttonIcon.innerHTML = ICONS[nextIconKey];
        buttonIcon.style.opacity = '';
      } else {
        buttonIcon.style.opacity = '0';
        scheduleTimer(() => {
          if (transitionGen !== myGen) return;
          buttonIcon.innerHTML = ICONS[nextIconKey];
          buttonIcon.style.opacity = '';
        }, 40);
      }
    }, midDelay);
  }

  // Phase 2: Write characters from left, width is transitioning alongside
  const writeStart = eraseLen === 0 ? 0 : eraseTotalMs + midGapMs;
  for (let i = 1; i <= writeLen; i++) {
    const delay = writeStart + (i - 1) * writeDelay;
    scheduleTimer(() => {
      if (transitionGen !== myGen) return;
      buttonLabel.textContent = nextText.slice(0, i);
    }, delay);
  }

  // Cleanup: remove inline styles after all animation settles
  const lastWrite = writeStart + Math.max(0, writeLen - 1) * writeDelay;
  const transitionEnd = eraseEndDelay + widthTransitionMs;
  const cleanupDelay = Math.max(lastWrite, transitionEnd) + 50;
  widthCleanupTimer = window.setTimeout(() => {
    if (transitionGen !== myGen) return;
    button.style.width = '';
    button.style.overflow = '';
    button.style.transition = '';
  }, cleanupDelay);
}

export function handleDebugDownload(state: PhotoState): void {
  if (!state.debugLogData) return;
  downloadJson(state.debugLogData, 'typeset-debug-log');
}