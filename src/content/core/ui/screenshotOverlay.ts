import type { PhotoState } from '../types';
import {
  buildScreenshotElementCandidates,
  getNextScreenshotElementCandidateIndex,
  moveScreenshotRect,
  normalizeScreenshotRect,
  resizeScreenshotRect,
  toDocumentScreenshotRect,
} from '../screenshot';
import type {
  ScreenshotElementCandidate,
  ScreenshotRect,
  ScreenshotResizeHandle,
  ScreenshotSelection,
} from '../screenshot';
import { ICONS } from './icons';
import { createUiElements, renderUi } from './imageControls';

export type ScreenshotResultUiElements = {
  host: HTMLElement;
  overlay: HTMLDivElement;
  primaryAction: HTMLDivElement;
  button: HTMLButtonElement;
  buttonIcon: HTMLSpanElement;
  buttonSpinner: HTMLSpanElement;
  buttonLabel: HTMLSpanElement;
  detailLine: HTMLDivElement;
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
  image: HTMLImageElement;
  closeButton: HTMLButtonElement;
  overlayPositioned: boolean;
  overlayAnchor: ScreenshotResultOverlayAnchor | null;
  contextImageNormalLockY: 'top' | 'bottom' | null;
  contextImageOverlayMode: string | null;
  overlayMotionTimer: number | null;
};

export type ScreenshotResultOverlayAnchor = {
  anchorX: 'left' | 'right';
  anchorY: 'top' | 'bottom';
  offsetX: number;
  offsetY: number;
};

export type ScreenshotResultOverlayPositionStyle = {
  left: string;
  right: string;
  top: string;
};

function setRectStyle(element: HTMLElement, rect: ScreenshotRect): void {
  element.style.left = `${rect.left}px`;
  element.style.top = `${rect.top}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

type FloatingControlPosition = {
  left: number;
  top: number;
  anchorX: 'left' | 'right';
  anchorY: 'top' | 'bottom';
};

type ScreenshotResultOverlayPositionOptions = {
  placement?: 'normal' | 'contextImage';
  lockNormalWhenReachable?: boolean;
  preferOutsideFallback?: boolean;
};

const floatingControlInset = 8;

const floatingControlGap = 8;

function clampViewportPosition(value: number, size: number, viewportSize: number, inset: number): number {
  const max = Math.max(inset, viewportSize - size - inset);
  return Math.min(max, Math.max(inset, value));
}

function getFloatingControlPosition(
  rect: ScreenshotRect,
  controlWidth: number,
  controlHeight: number,
): FloatingControlPosition {
  const preferredLeft = rect.left + rect.width - controlWidth;
  const left = clampViewportPosition(
    preferredLeft,
    controlWidth,
    window.innerWidth,
    floatingControlInset,
  );
  const anchorY = rect.top >= controlHeight + floatingControlGap + floatingControlInset ? 'top' : 'bottom';
  const preferredTop = anchorY === 'top'
    ? rect.top - controlHeight - floatingControlGap
    : rect.top + rect.height + floatingControlGap;
  const top = clampViewportPosition(preferredTop, controlHeight, window.innerHeight, floatingControlInset);
  const anchorX = left <= floatingControlInset ? 'left' : 'right';
  return { left, top, anchorX, anchorY };
}

function getReachableNormalAnchorY(
  rect: ScreenshotRect,
  controlHeight: number,
): 'top' | 'bottom' | null {
  const topAvailable = rect.top >= controlHeight + floatingControlGap + floatingControlInset;
  if (topAvailable) return 'top';
  const bottomAvailable = rect.top + rect.height + floatingControlGap + controlHeight <=
    window.innerHeight - floatingControlInset;
  return bottomAvailable ? 'bottom' : null;
}

function positionElementNearViewportRect(element: HTMLElement, rect: ScreenshotRect): void {
  const elementRect = element.getBoundingClientRect();
  const position = getFloatingControlPosition(
    rect,
    elementRect.width || 64,
    elementRect.height || 34,
  );
  element.style.left = `${position.left}px`;
  element.style.top = `${position.top}px`;
}

function isUsableViewportAnchorRect(rect: ScreenshotRect | undefined): rect is ScreenshotRect {
  return rect !== undefined && rect.width > 0 && rect.height > 0;
}

function getStickyInsideRightContextImageAnchor(
  hostRect: DOMRect,
  visibleRect: ScreenshotRect,
  overlayWidth: number,
): ScreenshotResultOverlayAnchor {
  const visibleLeft = Math.max(0, visibleRect.left);
  const visibleRight = Math.min(window.innerWidth, visibleRect.left + visibleRect.width);
  const visibleTop = Math.max(0, visibleRect.top);
  const minLeft = visibleLeft + floatingControlInset;
  const overlayLeft = Math.max(minLeft, visibleRight - overlayWidth);
  const overlayTop = visibleTop + floatingControlInset;
  return {
    anchorX: 'right',
    anchorY: 'top',
    offsetX: hostRect.right - overlayLeft - overlayWidth,
    offsetY: overlayTop - hostRect.top,
  };
}

function getOutsideRightContextImageAnchor(
  hostRect: DOMRect,
  visibleRect: ScreenshotRect,
  overlayWidth: number,
  overlayHeight: number,
): ScreenshotResultOverlayAnchor {
  const visibleLeft = Math.max(0, visibleRect.left);
  const visibleRight = Math.min(window.innerWidth, visibleRect.left + visibleRect.width);
  const visibleTop = Math.max(0, visibleRect.top);
  const minLeft = visibleLeft + floatingControlInset;
  const overlayLeft = Math.max(minLeft, visibleRight - overlayWidth);
  let overlayTop = visibleTop + floatingControlInset;

  const topEdgeVisible = hostRect.top > 0 && hostRect.top < overlayHeight + floatingControlGap + floatingControlInset;
  if (topEdgeVisible) {
    overlayTop = Math.max(floatingControlInset, hostRect.top - overlayHeight - floatingControlGap);
  }

  return {
    anchorX: 'right',
    anchorY: 'top',
    offsetX: hostRect.right - overlayLeft - overlayWidth,
    offsetY: overlayTop - hostRect.top,
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getOverlayMotionDurationMs(distancePx: number): number {
  if (!Number.isFinite(distancePx) || distancePx <= 0) return 180;
  const normalized = Math.sqrt(distancePx);
  return Math.round(clampNumber(180 + normalized * 22, 260, 820));
}

function getOverlayAnchorViewportPosition(
  hostRect: DOMRect,
  anchor: ScreenshotResultOverlayAnchor,
  overlayWidth: number,
): { left: number; top: number } {
  return {
    left: anchor.anchorX === 'right'
      ? hostRect.right - anchor.offsetX - overlayWidth
      : hostRect.left + anchor.offsetX,
    top: anchor.anchorY === 'bottom'
      ? hostRect.bottom + anchor.offsetY
      : hostRect.top + anchor.offsetY,
  };
}

function prepareContextImageOverlayMotion(
  ui: ScreenshotResultUiElements,
  mode: string,
  previousOverlayRect: DOMRect | null,
  hostRect: DOMRect,
  anchor: ScreenshotResultOverlayAnchor,
  overlayWidth: number,
): void {
  const previousMode = ui.contextImageOverlayMode;
  if (previousMode === mode) return;
  ui.contextImageOverlayMode = mode;
  if (previousMode === null) return;
  const nextOverlayPosition = getOverlayAnchorViewportPosition(hostRect, anchor, overlayWidth);
  const distancePx = previousOverlayRect
    ? Math.hypot(
        nextOverlayPosition.left - previousOverlayRect.left,
        nextOverlayPosition.top - previousOverlayRect.top,
      )
    : 0;
  const durationMs = getOverlayMotionDurationMs(distancePx);
  ui.host.style.setProperty('--mt-overlay-motion-ms', `${durationMs}ms`);
  ui.host.dataset.overlayMotion = 'smooth';
  if (ui.overlayMotionTimer !== null) {
    window.clearTimeout(ui.overlayMotionTimer);
  }
  ui.overlayMotionTimer = window.setTimeout(() => {
    delete ui.host.dataset.overlayMotion;
    ui.overlayMotionTimer = null;
  }, durationMs + 80);
}

function applyLockedNormalContextImageOverlayPosition(
  ui: ScreenshotResultUiElements,
  hostRect: DOMRect,
  overlayWidth: number,
  overlayHeight: number,
  anchorY: 'top' | 'bottom',
): void {
  const previousOverlayRect = ui.overlay.getBoundingClientRect();
  const anchor: ScreenshotResultOverlayAnchor = {
    anchorX: 'right',
    anchorY,
    offsetX: 0,
    offsetY: anchorY === 'top'
      ? -overlayHeight - floatingControlGap
      : floatingControlGap,
  };
  prepareContextImageOverlayMotion(ui, `normal-${anchorY}`, previousOverlayRect, hostRect, anchor, overlayWidth);
  ui.overlayAnchor = anchor;
  ui.overlay.dataset.anchorX = 'right';
  syncScreenshotResultOverlayPosition(ui);
}

function syncContextImageOverlayPosition(
  ui: ScreenshotResultUiElements,
  hostRect: DOMRect,
  visibleRect: ScreenshotRect,
  overlayWidth: number,
  overlayHeight: number,
  options: ScreenshotResultOverlayPositionOptions,
): boolean {
  if (ui.contextImageNormalLockY) {
    applyLockedNormalContextImageOverlayPosition(
      ui,
      hostRect,
      overlayWidth,
      overlayHeight,
      ui.contextImageNormalLockY,
    );
    return true;
  }

  const reachableAnchorY = getReachableNormalAnchorY(hostRect, overlayHeight);
  if (reachableAnchorY && options.lockNormalWhenReachable) {
    ui.contextImageNormalLockY = reachableAnchorY;
    applyLockedNormalContextImageOverlayPosition(ui, hostRect, overlayWidth, overlayHeight, reachableAnchorY);
    return true;
  }

  if (reachableAnchorY) {
    return positionScreenshotResultOverlay(ui);
  }

  const anchor = options.preferOutsideFallback
    ? getOutsideRightContextImageAnchor(hostRect, visibleRect, overlayWidth, overlayHeight)
    : getStickyInsideRightContextImageAnchor(hostRect, visibleRect, overlayWidth);
  const previousOverlayRect = ui.overlay.getBoundingClientRect();
  prepareContextImageOverlayMotion(ui, 'sticky', previousOverlayRect, hostRect, anchor, overlayWidth);
  ui.overlayAnchor = anchor;
  ui.overlay.dataset.anchorX = anchor.anchorX;
  syncScreenshotResultOverlayPosition(ui);
  return true;
}

function positionScreenshotResultOverlay(
  ui: ScreenshotResultUiElements,
  anchorViewportRect?: ScreenshotRect,
  options: ScreenshotResultOverlayPositionOptions = {},
): boolean {
  const hostRect = ui.host.getBoundingClientRect();
  if (hostRect.width <= 0 || hostRect.height <= 0) return false;
  const overlayRect = ui.overlay.getBoundingClientRect();
  const overlayWidth = overlayRect.width || 64;
  const overlayHeight = overlayRect.height || 34;
  const targetRect = isUsableViewportAnchorRect(anchorViewportRect)
    ? anchorViewportRect
    : {
        left: hostRect.left,
        top: hostRect.top,
        width: hostRect.width,
        height: hostRect.height,
      };
  if (options.placement === 'contextImage') {
    return syncContextImageOverlayPosition(ui, hostRect, targetRect, overlayWidth, overlayHeight, options);
  }

  ui.contextImageNormalLockY = null;
  ui.contextImageOverlayMode = null;
  const position = getFloatingControlPosition(
    targetRect,
    overlayWidth,
    overlayHeight,
  );
  const overlayLeft = position.left - hostRect.left;
  const overlayTop = position.top - hostRect.top;
  ui.overlayAnchor = {
    anchorX: position.anchorX,
    anchorY: position.anchorY,
    offsetX: position.anchorX === 'right' ? hostRect.width - overlayLeft - overlayWidth : overlayLeft,
    offsetY: position.anchorY === 'bottom' ? overlayTop - hostRect.height : overlayTop,
  };
  ui.overlay.dataset.anchorX = position.anchorX;
  syncScreenshotResultOverlayPosition(ui);
  return true;
}

export function setScreenshotResultRect(ui: ScreenshotResultUiElements, rect: ScreenshotRect): void {
  setRectStyle(ui.host, rect);
}

export function repositionScreenshotResultOverlay(
  ui: ScreenshotResultUiElements,
  anchorViewportRect?: ScreenshotRect,
  options: ScreenshotResultOverlayPositionOptions = {},
): void {
  ui.overlayPositioned = positionScreenshotResultOverlay(ui, anchorViewportRect, options);
}

export function freezeScreenshotResultOverlayPosition(ui: ScreenshotResultUiElements): void {
  const hostRect = ui.host.getBoundingClientRect();
  const overlayRect = ui.overlay.getBoundingClientRect();
  if (hostRect.width <= 0 || hostRect.height <= 0 || overlayRect.width <= 0 || overlayRect.height <= 0) {
    return;
  }
  const leftOffset = overlayRect.left - hostRect.left;
  const rightOffset = hostRect.right - overlayRect.right;
  const topOffset = overlayRect.top - hostRect.top;
  const bottomOffset = overlayRect.top - hostRect.bottom;
  const anchorX = Math.abs(rightOffset) <= Math.abs(leftOffset) ? 'right' : 'left';
  const anchorY = Math.abs(bottomOffset) <= Math.abs(topOffset) ? 'bottom' : 'top';
  ui.overlayAnchor = {
    anchorX,
    anchorY,
    offsetX: anchorX === 'right' ? rightOffset : leftOffset,
    offsetY: anchorY === 'bottom' ? bottomOffset : topOffset,
  };
  ui.overlay.dataset.anchorX = anchorX;
  ui.overlayPositioned = true;
  syncScreenshotResultOverlayPosition(ui);
}

function formatCssCalcFromFullSize(offset: number): string {
  const sign = offset < 0 ? '-' : '+';
  return `calc(100% ${sign} ${Math.abs(offset)}px)`;
}

export function getScreenshotResultOverlayPositionStyle(
  anchor: ScreenshotResultOverlayAnchor,
): ScreenshotResultOverlayPositionStyle {
  return {
    left: anchor.anchorX === 'left' ? `${anchor.offsetX}px` : 'auto',
    right: anchor.anchorX === 'right' ? `${anchor.offsetX}px` : 'auto',
    top: anchor.anchorY === 'bottom' ? formatCssCalcFromFullSize(anchor.offsetY) : `${anchor.offsetY}px`,
  };
}

function syncScreenshotResultOverlayPosition(ui: ScreenshotResultUiElements): void {
  if (!ui.overlayAnchor) return;
  const positionStyle = getScreenshotResultOverlayPositionStyle(ui.overlayAnchor);
  ui.overlay.style.left = positionStyle.left;
  ui.overlay.style.right = positionStyle.right;
  ui.overlay.style.top = positionStyle.top;
}

function clampViewportX(value: number): number {
  return Math.min(Math.max(value, 0), window.innerWidth);
}

function clampViewportY(value: number): number {
  return Math.min(Math.max(value, 0), window.innerHeight);
}

function toSelection(rect: ScreenshotRect): ScreenshotSelection {
  return {
    viewportRect: rect,
    documentRect: toDocumentScreenshotRect(rect, window.scrollX, window.scrollY),
  };
}

function isSelectableScreenshotElement(element: Element, host: HTMLElement): boolean {
  if (host.contains(element)) return false;
  if (element === document.body || element === document.documentElement) return false;
  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

function toElementScreenshotRect(element: Element): ScreenshotRect {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function collectScreenshotElementCandidates(
  host: HTMLElement,
  clientX: number,
  clientY: number,
): Array<ScreenshotElementCandidate<Element>> {
  const inputs: Array<{ element: Element; rect: ScreenshotRect }> = [];
  const seen = new Set<Element>();
  for (const element of document.elementsFromPoint(clientX, clientY)) {
    let current: Element | null = element;
    while (current && current !== document.body && current !== document.documentElement) {
      if (!seen.has(current) && isSelectableScreenshotElement(current, host)) {
        seen.add(current);
        inputs.push({
          element: current,
          rect: toElementScreenshotRect(current),
        });
      }
      current = current.parentElement;
    }
  }
  return buildScreenshotElementCandidates(inputs, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
}

type ScreenshotSelectionPhase = 'selecting' | 'confirming';

type ScreenshotSelectionAdjustOperation = {
  pointerId: number;
  startX: number;
  startY: number;
  startRect: ScreenshotRect;
  kind: 'move' | 'resize';
  handle?: ScreenshotResizeHandle;
};

const screenshotResizeHandles: ScreenshotResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function isScreenshotResizeHandle(value: string | undefined): value is ScreenshotResizeHandle {
  return value === 'n' ||
    value === 's' ||
    value === 'e' ||
    value === 'w' ||
    value === 'nw' ||
    value === 'ne' ||
    value === 'sw' ||
    value === 'se';
}

function getScreenshotResizeHandle(target: EventTarget | null): ScreenshotResizeHandle | null {
  if (!(target instanceof Element)) return null;
  const handle = target.closest<HTMLElement>('.mt-x-screenshot-select-handle')?.dataset.handle;
  return isScreenshotResizeHandle(handle) ? handle : null;
}

function isPointInsideScreenshotRect(rect: ScreenshotRect, clientX: number, clientY: number): boolean {
  return clientX >= rect.left &&
    clientX <= rect.left + rect.width &&
    clientY >= rect.top &&
    clientY <= rect.top + rect.height;
}

export function requestScreenshotSelection(): Promise<ScreenshotSelection | null> {
  return new Promise((resolve) => {
    const minSelectionSize = 12;
    const host = document.createElement('div');
    host.className = 'mt-x-screenshot-select';

    const selectionRect = document.createElement('div');
    selectionRect.className = 'mt-x-screenshot-select-rect';
    for (const handle of screenshotResizeHandles) {
      const handleElement = document.createElement('span');
      handleElement.className = 'mt-x-screenshot-select-handle';
      handleElement.dataset.handle = handle;
      selectionRect.appendChild(handleElement);
    }

    const toolbar = document.createElement('div');
    toolbar.className = 'mt-x-screenshot-select-toolbar';
    const confirmButton = document.createElement('button');
    confirmButton.className = 'mt-x-screenshot-select-action';
    confirmButton.type = 'button';
    confirmButton.dataset.action = 'confirm';
    confirmButton.innerHTML = ICONS.confirm;
    confirmButton.title = '确认选区';
    const resetButton = document.createElement('button');
    resetButton.className = 'mt-x-screenshot-select-action';
    resetButton.type = 'button';
    resetButton.dataset.action = 'reset';
    resetButton.innerHTML = ICONS.close;
    resetButton.title = '重新框选';
    toolbar.appendChild(confirmButton);
    toolbar.appendChild(resetButton);

    host.appendChild(selectionRect);
    host.appendChild(toolbar);
    document.body.appendChild(host);

    let active = false;
    let dragged = false;
    let startX = 0;
    let startY = 0;
    let pointerId: number | null = null;
    let settled = false;
    let elementCandidates: Array<ScreenshotElementCandidate<Element>> = [];
    let elementCandidateIndex = -1;
    let selectedElementRect: ScreenshotRect | null = null;
    let phase: ScreenshotSelectionPhase = 'selecting';
    let confirmedRect: ScreenshotRect | null = null;
    let confirmedMode: 'element' | 'manual' = 'element';
    let adjustOperation: ScreenshotSelectionAdjustOperation | null = null;

    const cleanup = (selection: ScreenshotSelection | null): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeydown, true);
      host.remove();
      resolve(selection);
    };

    const setPhase = (nextPhase: ScreenshotSelectionPhase): void => {
      phase = nextPhase;
      host.dataset.phase = nextPhase;
    };

    const positionToolbar = (rect: ScreenshotRect): void => {
      positionElementNearViewportRect(toolbar, rect);
    };

    const renderSelectionRect = (rect: ScreenshotRect, mode: 'element' | 'manual'): void => {
      selectionRect.style.display = 'block';
      selectionRect.dataset.mode = mode;
      setRectStyle(selectionRect, rect);
      positionToolbar(rect);
    };

    const hideSelectionRect = (): void => {
      selectionRect.style.display = 'none';
      selectedElementRect = null;
      confirmedRect = null;
    };

    const resetSelection = (): void => {
      active = false;
      dragged = false;
      pointerId = null;
      adjustOperation = null;
      elementCandidates = [];
      elementCandidateIndex = -1;
      selectedElementRect = null;
      confirmedRect = null;
      setPhase('selecting');
      hideSelectionRect();
    };

    const confirmCurrentSelection = (): void => {
      if (!confirmedRect) return;
      cleanup(toSelection(confirmedRect));
    };

    const lockSelectionRect = (rect: ScreenshotRect, mode: 'element' | 'manual'): void => {
      confirmedRect = rect;
      confirmedMode = mode;
      setPhase('confirming');
      renderSelectionRect(rect, mode);
    };

    const renderElementCandidate = (index: number): void => {
      const candidate = elementCandidates[index];
      if (!candidate) {
        hideSelectionRect();
        return;
      }
      elementCandidateIndex = index;
      selectedElementRect = candidate.rect;
      renderSelectionRect(candidate.rect, 'element');
    };

    const refreshElementCandidates = (clientX: number, clientY: number): void => {
      elementCandidates = collectScreenshotElementCandidates(host, clientX, clientY);
      if (elementCandidates.length === 0) {
        elementCandidateIndex = -1;
        hideSelectionRect();
        return;
      }
      renderElementCandidate(0);
    };

    const updateManualSelectionRect = (currentX: number, currentY: number): ScreenshotRect => {
      const rect = normalizeScreenshotRect(startX, startY, currentX, currentY, window.innerWidth, window.innerHeight);
      renderSelectionRect(rect, 'manual');
      return rect;
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      if (phase === 'confirming') {
        if (!confirmedRect) return;
        const handle = getScreenshotResizeHandle(event.target);
        if (!handle && !isPointInsideScreenshotRect(confirmedRect, event.clientX, event.clientY)) return;
        event.preventDefault();
        event.stopPropagation();
        adjustOperation = {
          pointerId: event.pointerId,
          startX: clampViewportX(event.clientX),
          startY: clampViewportY(event.clientY),
          startRect: confirmedRect,
          kind: handle ? 'resize' : 'move',
          handle: handle ?? undefined,
        };
        host.setPointerCapture(event.pointerId);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      active = true;
      dragged = false;
      pointerId = event.pointerId;
      startX = clampViewportX(event.clientX);
      startY = clampViewportY(event.clientY);
      host.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (adjustOperation) {
        if (adjustOperation.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        const currentX = clampViewportX(event.clientX);
        const currentY = clampViewportY(event.clientY);
        const deltaX = currentX - adjustOperation.startX;
        const deltaY = currentY - adjustOperation.startY;
        confirmedRect = adjustOperation.kind === 'resize' && adjustOperation.handle
          ? resizeScreenshotRect(
              adjustOperation.startRect,
              adjustOperation.handle,
              deltaX,
              deltaY,
              { width: window.innerWidth, height: window.innerHeight },
              minSelectionSize,
            )
          : moveScreenshotRect(
              adjustOperation.startRect,
              deltaX,
              deltaY,
              { width: window.innerWidth, height: window.innerHeight },
            );
        renderSelectionRect(confirmedRect, confirmedMode);
        return;
      }
      if (phase === 'confirming') return;
      if (!active) {
        refreshElementCandidates(event.clientX, event.clientY);
        return;
      }
      if (pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      const currentX = clampViewportX(event.clientX);
      const currentY = clampViewportY(event.clientY);
      if (Math.abs(currentX - startX) > 2 || Math.abs(currentY - startY) > 2) {
        dragged = true;
      }
      if (dragged) {
        updateManualSelectionRect(currentX, currentY);
      }
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (adjustOperation) {
        if (adjustOperation.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        if (host.hasPointerCapture(event.pointerId)) {
          host.releasePointerCapture(event.pointerId);
        }
        adjustOperation = null;
        return;
      }
      if (!active || pointerId !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      active = false;
      if (host.hasPointerCapture(event.pointerId)) {
        host.releasePointerCapture(event.pointerId);
      }
      pointerId = null;

      if (!dragged) {
        if (selectedElementRect) {
          lockSelectionRect(selectedElementRect, 'element');
        }
        return;
      }

      const currentX = clampViewportX(event.clientX);
      const currentY = clampViewportY(event.clientY);
      const viewportRect = updateManualSelectionRect(currentX, currentY);
      if (viewportRect.width < minSelectionSize || viewportRect.height < minSelectionSize) {
        if (selectedElementRect) {
          lockSelectionRect(selectedElementRect, 'element');
        } else {
          hideSelectionRect();
        }
        return;
      }

      lockSelectionRect(viewportRect, 'manual');
    };

    const onWheel = (event: WheelEvent): void => {
      if (active) return;
      event.preventDefault();
      event.stopPropagation();
      if (phase === 'confirming') return;
      if (elementCandidates.length === 0) {
        refreshElementCandidates(event.clientX, event.clientY);
      }
      const direction = event.deltaY < 0 ? 'larger' : 'smaller';
      const nextIndex = getNextScreenshotElementCandidateIndex(
        elementCandidateIndex,
        elementCandidates.length,
        direction,
      );
      renderElementCandidate(nextIndex);
    };

    const onDoubleClick = (event: MouseEvent): void => {
      if (phase !== 'confirming' || !confirmedRect) return;
      if (!isPointInsideScreenshotRect(confirmedRect, event.clientX, event.clientY)) return;
      event.preventDefault();
      event.stopPropagation();
      confirmCurrentSelection();
    };

    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Enter' && phase === 'confirming') {
        event.preventDefault();
        confirmCurrentSelection();
        return;
      }
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cleanup(null);
    };

    toolbar.addEventListener('pointerdown', (event) => {
      event.stopPropagation();
    });
    confirmButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      confirmCurrentSelection();
    });
    resetButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      resetSelection();
    });
    setPhase('selecting');
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointermove', onPointerMove);
    host.addEventListener('pointerup', onPointerUp);
    host.addEventListener('wheel', onWheel, { passive: false });
    host.addEventListener('dblclick', onDoubleClick);
    document.addEventListener('keydown', onKeydown, true);
  });
}

export function createScreenshotResultUi(rect: ScreenshotRect): ScreenshotResultUiElements {
  const base = createUiElements();
  base.host.className = 'mt-x-screenshot-result';
  base.host.dataset.theme = 'light';
  base.host.dataset.status = 'running';
  setRectStyle(base.host, rect);

  const image = document.createElement('img');
  image.alt = '翻译截图';
  image.draggable = false;

  const closeButton = document.createElement('button');
  closeButton.className = 'mt-x-pill-close';
  closeButton.type = 'button';
  closeButton.innerHTML = ICONS.close;
  closeButton.title = '关闭';

  base.primaryAction.appendChild(closeButton);
  base.host.appendChild(image);
  return {
    ...base,
    image,
    closeButton,
    overlayPositioned: false,
    overlayAnchor: null,
    contextImageNormalLockY: null,
    contextImageOverlayMode: null,
    overlayMotionTimer: null,
  };
}

export function renderScreenshotResultUi(
  ui: ScreenshotResultUiElements,
  state: PhotoState,
): void {
  renderUi(ui, state);
  if (!ui.overlayPositioned) {
    ui.overlayPositioned = positionScreenshotResultOverlay(ui);
  } else {
    syncScreenshotResultOverlayPosition(ui);
  }
  ui.host.dataset.status = state.status;
  const originalUrl = state.originalUrl.startsWith('screenshot:') ? undefined : state.originalUrl;
  const imageUrl = state.status === 'translated'
    ? state.translatedUrl
    : originalUrl ?? state.translatedUrl;
  const imageKind = imageUrl
    ? imageUrl === state.translatedUrl && state.status === 'translated'
      ? 'translated'
      : 'original'
    : undefined;
  if (imageKind) {
    ui.host.dataset.image = imageKind;
  } else {
    delete ui.host.dataset.image;
  }
  if (imageUrl && ui.image.src !== imageUrl) {
    ui.image.src = imageUrl;
  }
}
