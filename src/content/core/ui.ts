import type { PhotoState, ReadingModeBarUi } from './types';
import {
  buildScreenshotElementCandidates,
  getNextScreenshotElementCandidateIndex,
  moveScreenshotRect,
  normalizeScreenshotRect,
  resizeScreenshotRect,
  toDocumentScreenshotRect,
} from './screenshot';
import type {
  ScreenshotElementCandidate,
  ScreenshotRect,
  ScreenshotResizeHandle,
  ScreenshotSelection,
} from './screenshot';
import { downloadJson } from './utils';

const styleId = 'mt-overlay-style';
const spinnerSizePx = 16;
const spinnerStrokePx = 2.5;

type ProgressSpinnerBinding = {
  sync: (active: boolean) => void;
  dispose: () => void;
};

export type UiElements = {
  host: HTMLElement;
  overlay: HTMLDivElement;
  primaryAction: HTMLDivElement;
  button: HTMLButtonElement;
  buttonIcon: HTMLSpanElement;
  buttonSpinner: HTMLSpanElement;
  buttonLabel: HTMLSpanElement;
  detailLine: HTMLDivElement;
  debugDownloadButton: HTMLButtonElement;
  dispose: () => void;
};

export type ScreenshotResultUiElements = {
  host: HTMLElement;
  overlay: HTMLDivElement;
  primaryAction: HTMLDivElement;
  button: HTMLButtonElement;
  buttonIcon: HTMLSpanElement;
  buttonSpinner: HTMLSpanElement;
  buttonLabel: HTMLSpanElement;
  detailLine: HTMLDivElement;
  debugDownloadButton: HTMLButtonElement;
  dispose: () => void;
  image: HTMLImageElement;
  closeButton: HTMLButtonElement;
  overlayPositioned: boolean;
  overlayAnchor: ScreenshotResultOverlayAnchor | null;
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

const ICONS = {
  translate: `<svg viewBox="0 0 16 16"><text x="1.5" y="11" font-size="8.5" fill="currentColor" font-family="sans-serif" font-weight="700">文</text><text x="8.5" y="11" font-size="8.5" fill="currentColor" font-family="sans-serif" font-weight="700">A</text></svg>`,
  original: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="3" width="13" height="10" rx="1.5"/><circle cx="5" cy="6" r="1.5" fill="currentColor"/><path d="M1.5 11l4-3 2 2 3-2.5 3.5 2.5"/></svg>`,
  translated: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="3" width="13" height="10" rx="1.5"/><circle cx="5" cy="6" r="1.5" fill="currentColor"/><path d="M1.5 11l4-3 2 2 3-2.5 3.5 2.5"/><rect x="5" y="5.5" width="7.5" height="4" rx="1" fill="currentColor" opacity="0.75"/></svg>`,
  retry: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8A5 5 0 1 1 8 3"/><path d="M8 3l2.5 2.5"/></svg>`,
  confirm: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
};

type IconKey = keyof typeof ICONS;

// Transition animation timer tracking
const animTimers: number[] = [];
let widthCleanupTimer: number = 0;
let transitionGen = 0;
let nextSpinnerId = 1;
let spinnerWorker: Worker | null = null;
let spinnerWorkerFailed = false;

const spinnerBindings = new WeakMap<HTMLSpanElement, ProgressSpinnerBinding>();
const offscreenSpinners = new Set<HTMLSpanElement>();
const spinnerWorkerScript = `
const canvases = new Map();
let rafId = 0;
let timerId = 0;
let running = false;
const hasRaf = typeof self.requestAnimationFrame === "function" && typeof self.cancelAnimationFrame === "function";
const spinPeriodMs = 1200;
const arcRadians = Math.PI * 1.28;

function postError(error) {
  const message = error && error.message ? error.message : String(error);
  self.postMessage({ type: "error", error: message });
}

function schedule() {
  if (!running) return;
  if (hasRaf) {
    rafId = self.requestAnimationFrame(draw);
  } else {
    timerId = self.setTimeout(function () { draw(self.performance.now()); }, 16);
  }
}

function hasActiveCanvas() {
  for (const item of canvases.values()) {
    if (item.active) return true;
  }
  return false;
}

function startLoopIfNeeded() {
  if (running || !hasActiveCanvas()) return;
  running = true;
  schedule();
}

function stopLoopIfIdle() {
  if (hasActiveCanvas()) return;
  running = false;
  if (hasRaf) {
    self.cancelAnimationFrame(rafId);
  } else {
    self.clearTimeout(timerId);
  }
}

function draw(time) {
  if (!running) return;
  const angle = (time % spinPeriodMs) / spinPeriodMs * Math.PI * 2;
  for (const item of canvases.values()) {
    if (item.active) renderSpinner(item, angle);
  }
  schedule();
}

function renderSpinner(item, angle) {
  const size = item.size;
  const dpr = Math.max(1, item.dpr || 1);
  const pixelSize = Math.max(1, Math.round(size * dpr));
  if (item.canvas.width !== pixelSize) item.canvas.width = pixelSize;
  if (item.canvas.height !== pixelSize) item.canvas.height = pixelSize;

  const ctx = item.ctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, 6, -Math.PI / 2 + angle, -Math.PI / 2 + angle + arcRadians);
  ctx.lineWidth = ${spinnerStrokePx};
  ctx.lineCap = "round";
  ctx.strokeStyle = item.color || "rgba(255,255,255,0.92)";
  ctx.stroke();
}

self.addEventListener("message", function (event) {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  try {
    if (data.type === "add") {
      const ctx = data.canvas.getContext("2d");
      if (!ctx) throw new Error("OffscreenCanvas 2D context is unavailable");
      canvases.set(data.id, {
        canvas: data.canvas,
        ctx,
        size: data.size,
        dpr: data.dpr,
        color: data.color,
        active: Boolean(data.active),
      });
      startLoopIfNeeded();
    } else if (data.type === "update") {
      const item = canvases.get(data.id);
      if (!item) return;
      if (typeof data.color === "string" && data.color) item.color = data.color;
      if (typeof data.dpr === "number" && Number.isFinite(data.dpr)) item.dpr = data.dpr;
      if (typeof data.active === "boolean") item.active = data.active;
      if (item.active) {
        renderSpinner(item, self.performance.now());
        startLoopIfNeeded();
      } else {
        stopLoopIfIdle();
      }
    } else if (data.type === "remove") {
      canvases.delete(data.id);
      stopLoopIfIdle();
    }
  } catch (error) {
    postError(error);
  }
});
`;

function clearTransitionTimers(): void {
  for (const t of animTimers) clearTimeout(t);
  animTimers.length = 0;
  clearTimeout(widthCleanupTimer);
}

function scheduleTimer(fn: () => void, ms: number): void {
  animTimers.push(window.setTimeout(fn, ms));
}

function failSpinnerWorker(): void {
  spinnerWorkerFailed = true;
  spinnerWorker?.terminate();
  spinnerWorker = null;
  for (const spinner of offscreenSpinners) {
    spinner.dataset.renderer = 'css';
  }
  offscreenSpinners.clear();
}

function ensureSpinnerWorker(): Worker | null {
  if (spinnerWorker) return spinnerWorker;
  if (
    spinnerWorkerFailed
    || typeof Worker === 'undefined'
    || typeof Blob === 'undefined'
    || typeof URL === 'undefined'
  ) {
    return null;
  }

  let scriptUrl: string | null = null;
  try {
    const blob = new Blob([spinnerWorkerScript], { type: 'application/javascript' });
    scriptUrl = URL.createObjectURL(blob);
    spinnerWorker = new Worker(scriptUrl);
    spinnerWorker.addEventListener('error', failSpinnerWorker);
    spinnerWorker.addEventListener('message', (event: MessageEvent<unknown>) => {
      const data = event.data as { type?: unknown } | null;
      if (data && data.type === 'error') {
        failSpinnerWorker();
      }
    });
    return spinnerWorker;
  } catch {
    failSpinnerWorker();
    return null;
  } finally {
    if (scriptUrl) URL.revokeObjectURL(scriptUrl);
  }
}

function readSpinnerColor(spinner: HTMLSpanElement): string {
  const color = window.getComputedStyle(spinner).color;
  return color || 'rgba(255,255,255,0.92)';
}

function readSpinnerDpr(): number {
  return Math.max(1, Math.min(3, window.devicePixelRatio || 1));
}

function createSpinnerFallbackSvg(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('mt-x-spinner-fallback');
  svg.setAttribute('viewBox', '0 0 16 16');
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '8');
  circle.setAttribute('cy', '8');
  circle.setAttribute('r', '6');
  svg.appendChild(circle);
  return svg;
}

function attachOffscreenSpinner(spinner: HTMLSpanElement, canvas: HTMLCanvasElement): ProgressSpinnerBinding {
  const fallbackBinding: ProgressSpinnerBinding = {
    sync: () => {},
    dispose: () => {},
  };

  if (
    !('OffscreenCanvas' in globalThis)
    || typeof canvas.transferControlToOffscreen !== 'function'
  ) {
    spinner.dataset.renderer = 'css';
    return fallbackBinding;
  }

  const worker = ensureSpinnerWorker();
  if (!worker) {
    spinner.dataset.renderer = 'css';
    return fallbackBinding;
  }

  const id = nextSpinnerId++;
  let disposed = false;
  let lastColor = '';
  let lastDpr = 0;
  let lastActive = false;

  try {
    const offscreen = canvas.transferControlToOffscreen();
    spinner.dataset.renderer = 'offscreen';
    offscreenSpinners.add(spinner);
    worker.postMessage({
      type: 'add',
      id,
      canvas: offscreen,
      size: spinnerSizePx,
      dpr: readSpinnerDpr(),
      color: readSpinnerColor(spinner),
      active: false,
    }, [offscreen]);
  } catch {
    spinner.dataset.renderer = 'css';
    offscreenSpinners.delete(spinner);
    return fallbackBinding;
  }

  return {
    sync: (active: boolean) => {
      if (disposed || spinnerWorker !== worker || spinnerWorkerFailed || spinner.dataset.renderer !== 'offscreen') return;
      const color = readSpinnerColor(spinner);
      const dpr = readSpinnerDpr();
      if (color === lastColor && dpr === lastDpr && active === lastActive) return;
      lastColor = color;
      lastDpr = dpr;
      lastActive = active;
      worker.postMessage({
        type: 'update',
        id,
        color,
        dpr,
        active,
      });
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      offscreenSpinners.delete(spinner);
      if (spinnerWorker === worker && !spinnerWorkerFailed) {
        worker.postMessage({ type: 'remove', id });
      }
    },
  };
}

function createProgressSpinner(): HTMLSpanElement {
  const spinner = document.createElement('span');
  spinner.className = 'mt-x-spinner';
  spinner.dataset.renderer = 'css';

  const canvas = document.createElement('canvas');
  canvas.className = 'mt-x-spinner-canvas';
  canvas.width = spinnerSizePx;
  canvas.height = spinnerSizePx;
  canvas.setAttribute('aria-hidden', 'true');

  spinner.appendChild(canvas);
  spinner.appendChild(createSpinnerFallbackSvg());

  const binding = attachOffscreenSpinner(spinner, canvas);
  spinnerBindings.set(spinner, binding);
  return spinner;
}

function syncProgressSpinner(spinner: HTMLSpanElement, active: boolean): void {
  spinnerBindings.get(spinner)?.sync(active);
}

function disposeProgressSpinner(spinner: HTMLSpanElement): void {
  const binding = spinnerBindings.get(spinner);
  if (!binding) return;
  binding.dispose();
  spinnerBindings.delete(spinner);
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
    .mt-x-overlay-inline[data-anchor-x='left'] {
      align-items: flex-start;
    }
    .mt-x-overlay-inline[data-anchor-x='right'] {
      align-items: flex-end;
    }
    .mt-x-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      position: relative;
    }
    .mt-x-primary-action {
      position: relative;
      display: inline-flex;
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
      align-items: center;
      justify-content: center;
      contain: size paint;
      transform-origin: center;
    }
    .mt-x-spinner[data-renderer='css'] {
      will-change: transform;
      animation: mt-x-spin-rotate 1.2s linear infinite;
    }
    .mt-x-spinner[data-renderer='offscreen'] {
      animation: none;
      will-change: auto;
    }
    .mt-x-spinner svg,
    .mt-x-spinner canvas {
      width: 16px;
      height: 16px;
      display: block;
      flex: 0 0 auto;
    }
    .mt-x-spinner[data-renderer='css'] .mt-x-spinner-canvas,
    .mt-x-spinner[data-renderer='offscreen'] .mt-x-spinner-fallback {
      display: none;
    }
    .mt-x-spinner svg circle {
      fill: none;
      stroke: currentColor;
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-dasharray: 24, 37.7;
      stroke-dashoffset: 0;
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

    /* Reading mode bottom bar */
    .mt-x-reading-bar {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .mt-x-pill-close {
      position: absolute;
      right: -4px;
      top: -4px;
      z-index: 2;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 15px;
      height: 15px;
      border: 1px solid var(--mt-border, oklch(0.55 0.01 250 / 0.7));
      border-radius: 50%;
      background: var(--mt-bg-active, oklch(0.97 0.005 250 / 0.92));
      color: oklch(0.38 0.006 250 / 0.94);
      cursor: pointer;
      font-size: 9px;
      line-height: 1;
      padding: 0;
      flex: 0 0 auto;
      overflow: hidden;
      transition: transform 0.15s ease-out;
    }
    .mt-x-pill-close::after {
      content: "";
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: oklch(0 0 0 / 0.12);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s ease-out;
    }
    .mt-x-pill-close:hover::after {
      opacity: 1;
    }
    .mt-x-pill-close:hover {
      transform: scale(1.04);
    }
    .mt-x-pill-close svg {
      position: relative;
      z-index: 1;
      width: 9px;
      height: 9px;
      display: block;
    }

    .mt-x-screenshot-select {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: oklch(0 0 0 / 0.1);
      cursor: crosshair;
      user-select: none;
      touch-action: none;
      font-family: "MTX-SourceHanSans-CN", "MTX-SourceHanSans-TW", system-ui, sans-serif;
    }
    .mt-x-screenshot-select-rect {
      position: fixed;
      display: none;
      border: 5px solid oklch(0.38 0.006 250 / 0.94);
      border-radius: 8px;
      background: transparent;
      box-shadow: 0 0 0 9999px oklch(0 0 0 / 0.34);
      box-sizing: border-box;
      pointer-events: none;
    }
    .mt-x-screenshot-select-rect[data-mode='element'] {
      border-style: solid;
    }
    .mt-x-screenshot-select[data-phase='selecting'] .mt-x-screenshot-select-rect[data-mode='element'] {
      transition:
        left 180ms cubic-bezier(0.2, 0.85, 0.25, 1),
        top 180ms cubic-bezier(0.2, 0.85, 0.25, 1),
        width 180ms cubic-bezier(0.2, 0.85, 0.25, 1),
        height 180ms cubic-bezier(0.2, 0.85, 0.25, 1);
    }
    .mt-x-screenshot-select-rect[data-mode='manual'] {
      border-style: dashed;
    }
    .mt-x-screenshot-select[data-phase='confirming'] {
      cursor: default;
    }
    .mt-x-screenshot-select[data-phase='confirming'] .mt-x-screenshot-select-rect {
      pointer-events: auto;
      cursor: move;
    }
    .mt-x-screenshot-select-handle {
      position: absolute;
      z-index: 2;
      display: none;
      width: 24px;
      height: 24px;
      border: 0;
      background: transparent;
      box-sizing: border-box;
      pointer-events: auto;
    }
    .mt-x-screenshot-select[data-phase='confirming'] .mt-x-screenshot-select-handle {
      display: block;
    }
    .mt-x-screenshot-select-handle[data-handle='n'] {
      left: -12px;
      top: -12px;
      width: calc(100% + 24px);
      height: 24px;
      cursor: ns-resize;
    }
    .mt-x-screenshot-select-handle[data-handle='s'] {
      left: -12px;
      bottom: -12px;
      width: calc(100% + 24px);
      height: 24px;
      cursor: ns-resize;
    }
    .mt-x-screenshot-select-handle[data-handle='e'] {
      right: -12px;
      top: -12px;
      width: 24px;
      height: calc(100% + 24px);
      cursor: ew-resize;
    }
    .mt-x-screenshot-select-handle[data-handle='w'] {
      left: -12px;
      top: -12px;
      width: 24px;
      height: calc(100% + 24px);
      cursor: ew-resize;
    }
    .mt-x-screenshot-select-handle[data-handle='nw'],
    .mt-x-screenshot-select-handle[data-handle='ne'],
    .mt-x-screenshot-select-handle[data-handle='sw'],
    .mt-x-screenshot-select-handle[data-handle='se'] {
      z-index: 3;
      width: 30px;
      height: 30px;
    }
    .mt-x-screenshot-select-handle[data-handle='nw'] { left: -15px; top: -15px; cursor: nwse-resize; }
    .mt-x-screenshot-select-handle[data-handle='ne'] { right: -15px; top: -15px; cursor: nesw-resize; }
    .mt-x-screenshot-select-handle[data-handle='sw'] { left: -15px; bottom: -15px; cursor: nesw-resize; }
    .mt-x-screenshot-select-handle[data-handle='se'] { right: -15px; bottom: -15px; cursor: nwse-resize; }
    .mt-x-screenshot-select-toolbar {
      position: fixed;
      z-index: 2147483647;
      display: none;
      gap: 6px;
      align-items: center;
      padding: 4px;
      border: 1px solid oklch(0.55 0.01 250 / 0.46);
      border-radius: 999px;
      background: oklch(0.97 0.005 250 / 0.9);
      box-shadow: 0 8px 24px oklch(0 0 0 / 0.18);
      backdrop-filter: blur(16px) saturate(1.4);
      -webkit-backdrop-filter: blur(16px) saturate(1.4);
      pointer-events: auto;
    }
    .mt-x-screenshot-select[data-phase='confirming'] .mt-x-screenshot-select-toolbar {
      display: inline-flex;
    }
    .mt-x-screenshot-select-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border: 0;
      border-radius: 50%;
      background: oklch(0.94 0.008 250 / 0.92);
      color: oklch(0.16 0.006 250);
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      padding: 0;
      transition: background-color 0.15s ease-out, transform 0.15s ease-out;
    }
    .mt-x-screenshot-select-action svg {
      width: 15px;
      height: 15px;
      display: block;
    }
    .mt-x-screenshot-select-action:hover {
      background: oklch(0.86 0.012 250 / 0.96);
      transform: scale(1.04);
    }
    .mt-x-screenshot-select-action[data-action='confirm'] {
      color: oklch(0.34 0.07 150);
    }
    .mt-x-screenshot-select-action[data-action='reset'] {
      color: oklch(0.38 0.045 25);
    }
    .mt-x-screenshot-result {
      position: absolute;
      z-index: 2147483646;
      min-width: 24px;
      min-height: 24px;
      overflow: visible;
      cursor: move;
      user-select: none;
      touch-action: none;
      font-family: "MTX-SourceHanSans-CN", "MTX-SourceHanSans-TW", system-ui, sans-serif;
    }
    .mt-x-screenshot-result.mt-x-screenshot-result-zooming {
      transition:
        left 180ms cubic-bezier(0.2, 0.85, 0.25, 1),
        top 180ms cubic-bezier(0.2, 0.85, 0.25, 1),
        width 180ms cubic-bezier(0.2, 0.85, 0.25, 1),
        height 180ms cubic-bezier(0.2, 0.85, 0.25, 1);
    }
    .mt-x-screenshot-result::before {
      content: "";
      position: absolute;
      inset: 0;
      z-index: 0;
      box-sizing: border-box;
      background: oklch(0.92 0.06 355 / 0.08);
      box-shadow: 0 12px 32px oklch(0 0 0 / 0.24);
      pointer-events: none;
      opacity: 1;
      transition: opacity 0.16s ease-out;
    }
    .mt-x-screenshot-result[data-image='original']::before,
    .mt-x-screenshot-result[data-image='translated']::before {
      opacity: 0;
    }
    .mt-x-screenshot-result .mt-x-overlay-inline {
      position: absolute;
      left: 0;
      top: 0;
      z-index: 2;
      align-items: flex-end;
      cursor: move;
    }
    .mt-x-screenshot-result img {
      position: relative;
      z-index: 1;
      display: none;
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      object-fit: fill;
      pointer-events: none;
      user-select: none;
      box-shadow: 0 12px 32px oklch(0 0 0 / 0.24);
      transition: opacity 0.16s ease-out, filter 0.16s ease-out;
    }
    .mt-x-screenshot-result[data-image='original'] img,
    .mt-x-screenshot-result[data-image='translated'] img {
      display: block;
    }
    .mt-x-screenshot-result[data-status='running'][data-image='original'] img {
      filter: saturate(0.96) brightness(0.99);
    }
    .mt-x-shortcut-toast {
      position: fixed;
      left: 50%;
      bottom: 28px;
      z-index: 2147483647;
      transform: translateX(-50%) translateY(6px);
      max-width: min(280px, calc(100vw - 32px));
      padding: 8px 12px;
      border: 1px solid oklch(0.55 0.01 250 / 0.28);
      border-radius: 999px;
      background: oklch(0.97 0.005 250 / 0.92);
      color: oklch(0.18 0.006 250);
      box-shadow: 0 10px 28px oklch(0 0 0 / 0.18);
      backdrop-filter: blur(16px) saturate(1.35);
      -webkit-backdrop-filter: blur(16px) saturate(1.35);
      font: 500 12px/1.2 "MTX-SourceHanSans-CN", "MTX-SourceHanSans-TW", system-ui, sans-serif;
      text-align: center;
      pointer-events: none;
      opacity: 0;
      transition:
        opacity 150ms ease-out,
        transform 180ms cubic-bezier(0.2, 0.85, 0.25, 1);
    }
    .mt-x-shortcut-toast[data-visible='true'] {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
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
  `;
  document.documentElement.appendChild(style);
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
  const buttonSpinner = createProgressSpinner();
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
    debugDownloadButton,
    dispose: () => {
      disposeProgressSpinner(buttonSpinner);
    },
  };
}

export function renderUi(ui: UiElements, state: PhotoState | null): void {
  const { button, buttonIcon, buttonLabel, buttonSpinner, detailLine, debugDownloadButton } = ui;

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
    syncProgressSpinner(buttonSpinner, false);
    clearTransitionTimers();
    return;
  }

  const canShowDebugDownload = !!state.debugLogData;
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
  syncProgressSpinner(buttonSpinner, state.status === 'running');

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
    nextDetailText = state.elapsedText ? `翻译完成\n${state.elapsedText}` : '';
  } else if (state.status === 'showingOriginal') {
    nextText = '显示译图';
    nextIconKey = 'translated';
    nextDetailText = state.elapsedText ? `当前显示原图\n${state.elapsedText}` : '';
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

export function createReadingModeBarUi(): ReadingModeBarUi {
  const host = document.createElement('div');
  host.className = 'mt-x-reading-bar';
  host.dataset.theme = 'light';

  const translateCurrentBtn = document.createElement('button');
  translateCurrentBtn.className = 'mt-x-control';
  translateCurrentBtn.type = 'button';
  translateCurrentBtn.dataset.theme = 'light';
  const currentIcon = document.createElement('span');
  currentIcon.className = 'mt-x-icon';
  currentIcon.innerHTML = ICONS.translate;
  const currentSpinner = createProgressSpinner();
  const currentLabel = document.createElement('span');
  currentLabel.className = 'mt-x-label';
  currentLabel.textContent = '翻译当前页';
  translateCurrentBtn.appendChild(currentIcon);
  translateCurrentBtn.appendChild(currentSpinner);
  translateCurrentBtn.appendChild(currentLabel);
  host.appendChild(translateCurrentBtn);

  const translateAllBtn = document.createElement('button');
  translateAllBtn.className = 'mt-x-control';
  translateAllBtn.type = 'button';
  translateAllBtn.dataset.theme = 'light';
  const allIcon = document.createElement('span');
  allIcon.className = 'mt-x-icon';
  allIcon.innerHTML = ICONS.translate;
  const allSpinner = createProgressSpinner();
  const allLabel = document.createElement('span');
  allLabel.className = 'mt-x-label';
  allLabel.textContent = '翻译全部';
  translateAllBtn.appendChild(allIcon);
  translateAllBtn.appendChild(allSpinner);
  translateAllBtn.appendChild(allLabel);
  host.appendChild(translateAllBtn);

  return {
    host,
    translateCurrentBtn,
    translateAllBtn,
    syncSpinners: (currentActive: boolean, allActive: boolean) => {
      syncProgressSpinner(currentSpinner, currentActive);
      syncProgressSpinner(allSpinner, allActive);
    },
    dispose: () => {
      disposeProgressSpinner(currentSpinner);
      disposeProgressSpinner(allSpinner);
    },
  };
}

export function handleDebugDownload(state: PhotoState): void {
  if (!state.debugLogData) return;
  downloadJson(state.debugLogData, 'typeset-debug-log');
}

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

function clampViewportPosition(value: number, size: number, viewportSize: number, inset: number): number {
  const max = Math.max(inset, viewportSize - size - inset);
  return Math.min(max, Math.max(inset, value));
}

function getFloatingControlPosition(
  rect: ScreenshotRect,
  controlWidth: number,
  controlHeight: number,
): FloatingControlPosition {
  const inset = 8;
  const gap = 8;
  const preferredLeft = rect.left + rect.width - controlWidth;
  const left = clampViewportPosition(
    preferredLeft,
    controlWidth,
    window.innerWidth,
    inset,
  );
  const anchorY = rect.top >= controlHeight + gap + inset ? 'top' : 'bottom';
  const preferredTop = anchorY === 'top'
    ? rect.top - controlHeight - gap
    : rect.top + rect.height + gap;
  const top = clampViewportPosition(preferredTop, controlHeight, window.innerHeight, inset);
  const anchorX = left <= inset ? 'left' : 'right';
  return { left, top, anchorX, anchorY };
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

function positionScreenshotResultOverlay(ui: ScreenshotResultUiElements): boolean {
  const hostRect = ui.host.getBoundingClientRect();
  if (hostRect.width <= 0 || hostRect.height <= 0) return false;
  const overlayRect = ui.overlay.getBoundingClientRect();
  const overlayWidth = overlayRect.width || 64;
  const position = getFloatingControlPosition(
    {
      left: hostRect.left,
      top: hostRect.top,
      width: hostRect.width,
      height: hostRect.height,
    },
    overlayWidth,
    overlayRect.height || 34,
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
  return { ...base, image, closeButton, overlayPositioned: false, overlayAnchor: null };
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
