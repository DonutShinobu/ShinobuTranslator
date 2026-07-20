import type { PhotoState } from '../types';
import { ICONS } from './icons';
import type { IconKey } from './icons';
import { renderErrorDetailCard, renderStageTimingCard } from './cards';

export type UiElements = {
  host: HTMLElement;
  overlay: HTMLDivElement;
  primaryAction: HTMLDivElement;
  button: HTMLButtonElement;
  buttonIcon: HTMLSpanElement;
  buttonSpinner: HTMLSpanElement;
  buttonLabel: HTMLSpanElement;
  detailLine: HTMLDivElement;
  contextNoticeLine: HTMLDivElement;
  errorDetailCard: HTMLDivElement;
  errorDetailCardToggleButton: HTMLButtonElement;
  errorDetailCardHeading: HTMLSpanElement;
  errorDetailCardMeta: HTMLSpanElement;
  errorDetailCardTotal: HTMLSpanElement;
  errorDetailCardChevron: HTMLSpanElement;
  errorDetailCardBody: HTMLDivElement;
  errorDetailContent: HTMLPreElement;
  stageTimingCard: HTMLDivElement;
  stageTimingCardToggleButton: HTMLButtonElement;
  stageTimingCardTotal: HTMLSpanElement;
  stageTimingCardMeta: HTMLSpanElement;
  stageTimingCardChevron: HTMLSpanElement;
  stageTimingCardBody: HTMLDivElement;
  stageTimingStageList: HTMLDivElement;
  stageTimingParallelList: HTMLDivElement;
  stageTimingRuntimeList: HTMLDivElement;
  debugDownloadButton: HTMLButtonElement;
};

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

export function createUiElements(): UiElements {
  const root = document.createElement('div');
  root.className = 'mt-x-overlay-inline';

  const actions = document.createElement('div');
  actions.className = 'mt-x-actions';

  const primaryAction = document.createElement('div');
  primaryAction.className = 'mt-x-primary-action';

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
  primaryAction.appendChild(button);
  actions.appendChild(primaryAction);

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

  const contextNoticeLine = document.createElement('div');
  contextNoticeLine.className = 'mt-x-detail mt-x-context-notice';
  contextNoticeLine.setAttribute('aria-live', 'polite');
  root.appendChild(contextNoticeLine);

  const errorDetailCard = document.createElement('div');
  errorDetailCard.className = 'mt-x-stage-card mt-x-error-detail-card';
  const errorDetailCardToggleButton = document.createElement('button');
  errorDetailCardToggleButton.className = 'mt-x-stage-card-toggle';
  errorDetailCardToggleButton.type = 'button';

  const errorDetailCardTitle = document.createElement('span');
  errorDetailCardTitle.className = 'mt-x-stage-card-title';
  const errorDetailCardHeading = document.createElement('span');
  errorDetailCardHeading.className = 'mt-x-stage-card-heading';
  errorDetailCardHeading.textContent = 'Gemini 回复';
  const errorDetailCardMeta = document.createElement('span');
  errorDetailCardMeta.className = 'mt-x-stage-card-meta';
  errorDetailCardTitle.appendChild(errorDetailCardHeading);
  errorDetailCardTitle.appendChild(errorDetailCardMeta);

  const errorDetailCardTotal = document.createElement('span');
  errorDetailCardTotal.className = 'mt-x-stage-card-total';
  const errorDetailCardChevron = document.createElement('span');
  errorDetailCardChevron.className = 'mt-x-stage-card-chevron';
  errorDetailCardToggleButton.appendChild(errorDetailCardTitle);
  errorDetailCardToggleButton.appendChild(errorDetailCardTotal);
  errorDetailCardToggleButton.appendChild(errorDetailCardChevron);

  const errorDetailCardBody = document.createElement('div');
  errorDetailCardBody.className = 'mt-x-stage-card-body';
  const errorDetailContent = document.createElement('pre');
  errorDetailContent.className = 'mt-x-error-detail-content';
  errorDetailCardBody.appendChild(errorDetailContent);
  errorDetailCard.appendChild(errorDetailCardToggleButton);
  errorDetailCard.appendChild(errorDetailCardBody);
  root.appendChild(errorDetailCard);

  const stageTimingCard = document.createElement('div');
  stageTimingCard.className = 'mt-x-stage-card';
  const stageTimingCardToggleButton = document.createElement('button');
  stageTimingCardToggleButton.className = 'mt-x-stage-card-toggle';
  stageTimingCardToggleButton.type = 'button';

  const stageTimingCardTitle = document.createElement('span');
  stageTimingCardTitle.className = 'mt-x-stage-card-title';
  const stageTimingCardHeading = document.createElement('span');
  stageTimingCardHeading.className = 'mt-x-stage-card-heading';
  stageTimingCardHeading.textContent = '阶段明细';
  const stageTimingCardMeta = document.createElement('span');
  stageTimingCardMeta.className = 'mt-x-stage-card-meta';
  stageTimingCardTitle.appendChild(stageTimingCardHeading);
  stageTimingCardTitle.appendChild(stageTimingCardMeta);

  const stageTimingCardTotal = document.createElement('span');
  stageTimingCardTotal.className = 'mt-x-stage-card-total';
  const stageTimingCardChevron = document.createElement('span');
  stageTimingCardChevron.className = 'mt-x-stage-card-chevron';
  stageTimingCardToggleButton.appendChild(stageTimingCardTitle);
  stageTimingCardToggleButton.appendChild(stageTimingCardTotal);
  stageTimingCardToggleButton.appendChild(stageTimingCardChevron);

  const stageTimingCardBody = document.createElement('div');
  stageTimingCardBody.className = 'mt-x-stage-card-body';
  const stageTimingTimelineRow = document.createElement('div');
  stageTimingTimelineRow.className = 'mt-x-stage-timing-row';
  const stageTimingOverviewLabel = document.createElement('span');
  stageTimingOverviewLabel.className = 'mt-x-stage-row-label';
  stageTimingOverviewLabel.textContent = '总览';
  const stageTimingStageList = document.createElement('div');
  stageTimingStageList.className = 'mt-x-stage-timeline';
  stageTimingTimelineRow.appendChild(stageTimingOverviewLabel);
  stageTimingTimelineRow.appendChild(stageTimingStageList);
  const stageTimingParallelList = document.createElement('div');
  stageTimingParallelList.className = 'mt-x-stage-parallel';
  const stageTimingRuntimeList = document.createElement('div');
  stageTimingRuntimeList.className = 'mt-x-stage-runtime';
  stageTimingCardBody.appendChild(stageTimingTimelineRow);
  stageTimingCardBody.appendChild(stageTimingParallelList);
  stageTimingCardBody.appendChild(stageTimingRuntimeList);
  stageTimingCard.appendChild(stageTimingCardToggleButton);
  stageTimingCard.appendChild(stageTimingCardBody);
  root.appendChild(stageTimingCard);

  const host = document.createElement('div');
  host.appendChild(root);

  return {
    host,
    overlay: root,
    primaryAction,
    button,
    buttonIcon,
    buttonSpinner,
    buttonLabel,
    detailLine,
    contextNoticeLine,
    errorDetailCard,
    errorDetailCardToggleButton,
    errorDetailCardHeading,
    errorDetailCardMeta,
    errorDetailCardTotal,
    errorDetailCardChevron,
    errorDetailCardBody,
    errorDetailContent,
    stageTimingCard,
    stageTimingCardToggleButton,
    stageTimingCardTotal,
    stageTimingCardMeta,
    stageTimingCardChevron,
    stageTimingCardBody,
    stageTimingStageList,
    stageTimingParallelList,
    stageTimingRuntimeList,
    debugDownloadButton,
  };
}

export function renderUi(ui: UiElements, state: PhotoState | null): void {
  const {
    button,
    buttonIcon,
    buttonLabel,
    contextNoticeLine,
    detailLine,
    debugDownloadButton,
  } = ui;

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
    contextNoticeLine.textContent = '';
    debugDownloadButton.style.display = 'none';
    renderErrorDetailCard(ui, null);
    renderStageTimingCard(ui, null);
    clearTransitionTimers();
    return;
  }

  contextNoticeLine.textContent = state.contextNoticeText ?? '';
  const canShowDebugDownload = false;
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
    nextDetailText = state.stageTimingCard ? '' : state.elapsedText;
  } else if (state.status === 'showingOriginal') {
    nextText = '显示译图';
    nextIconKey = 'translated';
    nextDetailText = state.stageTimingCard ? '' : state.elapsedText;
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
  renderErrorDetailCard(ui, state);
  renderStageTimingCard(ui, state);

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
