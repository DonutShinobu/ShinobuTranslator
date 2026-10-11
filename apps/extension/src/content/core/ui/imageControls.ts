import type { PhotoState } from '../types';
import { initializeTranslationButton, updateTranslationButton } from './translationButton';
import { renderErrorDetailCard, renderStageTimingCard } from './cards';

export type UiElements = {
  host: HTMLElement;
  overlay: HTMLDivElement;
  primaryAction: HTMLDivElement;
  button: HTMLButtonElement;
  buttonIcon: HTMLSpanElement;
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
  const buttonLabel = document.createElement('span');
  buttonLabel.className = 'mt-x-label';
  buttonLabel.textContent = '翻译';
  initializeTranslationButton(button, buttonIcon, buttonLabel);
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
    updateTranslationButton(button, '翻译', 'languages', false);
    updateStatusLine('');
    contextNoticeLine.textContent = '';
    debugDownloadButton.style.display = 'none';
    renderErrorDetailCard(ui, null);
    renderStageTimingCard(ui, null);
    return;
  }

  contextNoticeLine.textContent = state.contextNoticeText ?? '';
  const canShowDebugDownload = false;
  debugDownloadButton.style.display = canShowDebugDownload ? 'inline-flex' : 'none';
  debugDownloadButton.disabled = !canShowDebugDownload || state.status === 'running';

  button.dataset.status = state.status;
  button.disabled = state.status === 'running';
  let text = '翻译';
  let detail = '';
  let variant: 'normal' | 'error' = 'normal';
  if (state.status === 'running') text = state.stageText || '翻译中…';
  else if (state.status === 'translated') {
    text = '显示原图';
    detail = state.stageTimingCard ? '' : state.elapsedText;
  } else if (state.status === 'showingOriginal') {
    text = '显示译图';
    detail = state.stageTimingCard ? '' : state.elapsedText;
  } else if (state.status === 'error') {
    text = '重试';
    detail = state.errorText.includes('未找到文本') ? '未找到文本' : `翻译失败：${state.errorText}`;
    if (!state.errorText.includes('未找到文本')) variant = 'error';
  }
  updateTranslationButton(button, text);
  updateStatusLine(detail, variant);
  renderErrorDetailCard(ui, state);
  renderStageTimingCard(ui, state);
}
