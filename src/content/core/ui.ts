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
