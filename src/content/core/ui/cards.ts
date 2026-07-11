import type {
  PhotoState,
  StageTimingCardParallelLane,
  StageTimingCardStage,
} from '../types';
import type { UiElements } from './imageControls';

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

function toStageFlexGrow(percent: number): number {
  const stagePercent = clampPercent(percent);
  return stagePercent > 0 ? Math.max(1, stagePercent) : 0;
}

function toLaneFlexGrow(percent: number): number {
  const lanePercent = clampPercent(percent);
  return lanePercent > 0 ? Math.max(1, lanePercent) : 0;
}

function appendParallelSpacer(container: HTMLElement, percent: number): void {
  const flexGrow = toLaneFlexGrow(percent);
  if (flexGrow <= 0) return;
  const spacer = document.createElement('span');
  spacer.className = 'mt-x-stage-parallel-spacer';
  spacer.style.flexGrow = String(flexGrow);
  container.appendChild(spacer);
}

function appendParallelLaneBar(container: HTMLElement, lane: StageTimingCardParallelLane): void {
  const flexGrow = toLaneFlexGrow(lane.localWidthPercent);
  if (flexGrow <= 0) return;

  const bar = document.createElement('span');
  bar.className = 'mt-x-stage-parallel-bar';
  bar.dataset.stage = lane.stage;
  bar.style.flexGrow = String(flexGrow);
  const detailText = lane.detailText ? `，${lane.detailText}` : '';
  const laneDescription = `${lane.label}：${lane.durationText}${detailText}`;
  bar.dataset.tooltip = laneDescription;
  bar.setAttribute('aria-label', laneDescription);
  bar.tabIndex = 0;
  container.appendChild(bar);
}

function appendParallelLaneSegments(container: HTMLElement, lanes: StageTimingCardParallelLane[]): void {
  const sortedLanes = [...lanes].sort((a, b) => a.localOffsetPercent - b.localOffsetPercent);
  let cursorPercent = 0;
  for (const lane of sortedLanes) {
    const laneOffsetPercent = clampPercent(lane.localOffsetPercent);
    appendParallelSpacer(container, laneOffsetPercent - cursorPercent);
    appendParallelLaneBar(container, lane);
    cursorPercent = Math.max(cursorPercent, laneOffsetPercent + clampPercent(lane.localWidthPercent));
  }
  appendParallelSpacer(container, 100 - cursorPercent);
}

function appendParallelStageSlot(
  track: HTMLElement,
  stage: StageTimingCardStage,
  activeLanes?: StageTimingCardParallelLane[],
): void {
  const slot = document.createElement('span');
  slot.className = 'mt-x-stage-parallel-slot';
  slot.style.flexGrow = String(toStageFlexGrow(stage.percent));
  if (activeLanes && activeLanes.length > 0) {
    const inner = document.createElement('span');
    inner.className = 'mt-x-stage-parallel-inner';
    appendParallelLaneSegments(inner, activeLanes);
    slot.appendChild(inner);
  }
  track.appendChild(slot);
}

function formatStageTimingTotalBadge(totalText: string): string {
  return totalText.replace(/^总耗时：/, '');
}

export function renderErrorDetailCard(ui: UiElements, state: PhotoState | null): void {
  const card = state?.errorDetailCard;
  const visible = !!card && state.status === 'error';
  ui.errorDetailCard.dataset.visible = visible ? 'true' : 'false';
  ui.errorDetailCardToggleButton.disabled = !visible;
  if (!visible || !card) {
    ui.errorDetailCard.dataset.expanded = 'false';
    ui.errorDetailCardToggleButton.setAttribute('aria-expanded', 'false');
    ui.errorDetailCardToggleButton.title = '';
    ui.errorDetailCardHeading.textContent = 'Gemini 回复';
    ui.errorDetailCardMeta.textContent = '';
    ui.errorDetailCardTotal.textContent = '';
    ui.errorDetailContent.textContent = '';
    return;
  }

  ui.errorDetailCard.dataset.expanded = card.expanded ? 'true' : 'false';
  ui.errorDetailCardToggleButton.setAttribute('aria-expanded', card.expanded ? 'true' : 'false');
  ui.errorDetailCardToggleButton.title = card.expanded ? '收起 Gemini 回复' : '展开 Gemini 回复';
  ui.errorDetailCardHeading.textContent = card.title;
  ui.errorDetailCardMeta.textContent = `${card.content.length} 字符`;
  ui.errorDetailCardTotal.textContent = card.expanded ? '收起' : '查看';
  ui.errorDetailContent.textContent = card.content;
}

export function renderStageTimingCard(ui: UiElements, state: PhotoState | null): void {
  const card = state?.stageTimingCard;
  const visible = !!card && (state.status === 'translated' || state.status === 'showingOriginal');
  ui.stageTimingCard.dataset.visible = visible ? 'true' : 'false';
  ui.stageTimingCardToggleButton.disabled = !visible;
  if (!visible || !card) {
    ui.stageTimingCardToggleButton.setAttribute('aria-expanded', 'false');
    ui.stageTimingCardTotal.textContent = '';
    ui.stageTimingCardMeta.textContent = '';
    ui.stageTimingStageList.replaceChildren();
    ui.stageTimingParallelList.dataset.visible = 'false';
    ui.stageTimingParallelList.replaceChildren();
    ui.stageTimingRuntimeList.replaceChildren();
    return;
  }

  ui.stageTimingCard.dataset.expanded = card.expanded ? 'true' : 'false';
  ui.stageTimingCardToggleButton.setAttribute('aria-expanded', card.expanded ? 'true' : 'false');
  ui.stageTimingCardToggleButton.title = card.expanded ? '收起阶段明细' : '展开阶段明细';
  ui.stageTimingCardTotal.textContent = formatStageTimingTotalBadge(card.totalText);
  ui.stageTimingCardMeta.textContent = `${card.stages.length} 个阶段 · ${card.runtimes.length} 个模型`;

  ui.stageTimingStageList.replaceChildren();
  ui.stageTimingStageList.className = 'mt-x-stage-timeline';
  for (const stage of card.stages) {
    const segment = document.createElement('span');
    segment.className = 'mt-x-stage-segment';
    const stagePercent = clampPercent(stage.percent);
    segment.style.flexGrow = String(toStageFlexGrow(stagePercent));
    segment.style.setProperty('--mt-stage-alpha', `${Math.min(92, Math.max(44, Math.round(stagePercent + 48)))}%`);
    const fallbackText = stage.fallbackText ? `，${stage.fallbackText}` : '';
    const stageDescription = `${stage.label}：${stage.durationText}，${stage.percentText}${fallbackText}`;
    segment.dataset.tooltip = stageDescription;
    segment.setAttribute('aria-label', stageDescription);
    segment.tabIndex = 0;
    ui.stageTimingStageList.appendChild(segment);
  }

  ui.stageTimingParallelList.replaceChildren();
  const parallelStageIndex = card.stages.findIndex((stage) => stage.parallelLanes && stage.parallelLanes.length > 0);
  const parallelStage = parallelStageIndex >= 0 ? card.stages[parallelStageIndex] : undefined;
  if (parallelStage?.parallelLanes?.length) {
    ui.stageTimingParallelList.dataset.visible = 'true';
    const lanes = parallelStage.parallelLanes;
    const translateLane = lanes.find((lane) => lane.stage === 'translate');
    const eraseLanes = lanes.filter((lane) => lane.stage === 'mask_refine' || lane.stage === 'inpaint');
    const parallelRows: Array<{ label: string; lanes: typeof lanes }> = [];
    if (translateLane) {
      parallelRows.push({ label: '翻译', lanes: [translateLane] });
    }
    if (eraseLanes.length > 0) {
      parallelRows.push({ label: '去字', lanes: eraseLanes });
    }

    for (const rowData of parallelRows) {
      const row = document.createElement('div');
      row.className = 'mt-x-stage-parallel-row';
      const label = document.createElement('span');
      label.className = 'mt-x-stage-parallel-label';
      label.textContent = rowData.label;
      const track = document.createElement('span');
      track.className = 'mt-x-stage-parallel-track';
      card.stages.forEach((stage, stageIndex) => {
        appendParallelStageSlot(track, stage, stageIndex === parallelStageIndex ? rowData.lanes : undefined);
      });
      row.appendChild(label);
      row.appendChild(track);
      ui.stageTimingParallelList.appendChild(row);
    }
  } else {
    ui.stageTimingParallelList.dataset.visible = 'false';
  }

  ui.stageTimingRuntimeList.replaceChildren();
  for (const runtime of card.runtimes) {
    const chip = document.createElement('span');
    chip.className = 'mt-x-runtime-node';
    chip.dataset.status = runtime.status;
    chip.dataset.tooltip = runtime.detail;
    chip.setAttribute('aria-label', `${runtime.label}：${runtime.providerText}，${runtime.detail}`);
    chip.tabIndex = 0;
    const dot = document.createElement('span');
    dot.className = 'mt-x-runtime-dot';
    const label = document.createElement('strong');
    label.className = 'mt-x-runtime-label';
    label.textContent = runtime.label;
    const provider = document.createElement('span');
    provider.className = 'mt-x-runtime-provider';
    provider.textContent = runtime.providerText;
    chip.appendChild(dot);
    chip.appendChild(label);
    chip.appendChild(provider);
    ui.stageTimingRuntimeList.appendChild(chip);
  }
}
