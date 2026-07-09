import type { PhotoState, ReadingModeBarUi, StageTimingCardParallelLane, StageTimingCardStage } from './types';
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

const styleId = 'mt-overlay-style';

export type UiElements = {
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
      --mt-stage-bg: var(--mt-bg, oklch(0.14 0.01 250 / 0.72));
      --mt-stage-bg-hover: var(--mt-bg-hover, oklch(0.14 0.01 250 / 0.85));
      --mt-stage-bg-active: var(--mt-bg-active, oklch(0.14 0.01 250 / 0.92));
      --mt-stage-border: var(--mt-border, oklch(0.92 0.01 250 / 0.85));
      --mt-stage-border-soft: oklch(0.92 0.02 350 / 0.2);
      --mt-stage-muted: var(--mt-text-detail, oklch(0.94 0.01 250 / 0.7));
      --mt-stage-track: oklch(0.94 0.02 350 / 0.18);
      --mt-stage-fill: oklch(0.77 0.1 350 / 0.94);
      --mt-stage-fill-soft: oklch(0.83 0.07 350 / 0.5);
      --mt-stage-node-bg: oklch(0.22 0.022 350 / 0.44);
      --mt-stage-node-border: oklch(0.86 0.04 350 / 0.22);
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
      --mt-stage-bg: var(--mt-bg, oklch(0.97 0.005 250 / 0.82));
      --mt-stage-bg-hover: var(--mt-bg-hover, oklch(0.97 0.005 250 / 0.88));
      --mt-stage-bg-active: var(--mt-bg-active, oklch(0.97 0.005 250 / 0.92));
      --mt-stage-border: var(--mt-border, oklch(0.55 0.01 250 / 0.7));
      --mt-stage-border-soft: oklch(0.76 0.035 350 / 0.24);
      --mt-stage-muted: var(--mt-text-detail, oklch(0.2 0.01 250 / 0.7));
      --mt-stage-track: oklch(0.86 0.03 350 / 0.64);
      --mt-stage-fill: oklch(0.7 0.105 350 / 0.9);
      --mt-stage-fill-soft: oklch(0.82 0.055 350 / 0.62);
      --mt-stage-node-bg: oklch(0.985 0.016 350 / 0.76);
      --mt-stage-node-border: oklch(0.78 0.04 350 / 0.28);
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

    .mt-x-stage-card {
      display: none;
      width: min(286px, calc(100vw - 24px));
      max-width: 286px;
      margin-top: 2px;
      box-sizing: border-box;
      border: 1px solid var(--mt-stage-border, oklch(0.9 0.012 250 / 0.22));
      border-radius: 18px;
      background: var(--mt-stage-bg, oklch(0.16 0.012 250 / 0.86));
      color: var(--mt-text, oklch(0.94 0.01 250));
      box-shadow:
        0 8px 22px oklch(0 0 0 / 0.14),
        inset 0 1px 0 oklch(1 0 0 / 0.08);
      overflow: visible;
      font-family: "MTX-SourceHanSans-CN", "MTX-SourceHanSans-TW", system-ui, sans-serif;
      text-shadow: none;
      backdrop-filter: blur(14px) saturate(1.15);
      -webkit-backdrop-filter: blur(14px) saturate(1.15);
    }
    .mt-x-stage-card[data-visible='true'] {
      display: block;
    }
    .mt-x-stage-card-toggle {
      width: 100%;
      min-height: 34px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 8px;
      border: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      padding: 6px 9px 6px 11px;
      text-align: left;
      font: inherit;
      letter-spacing: 0;
      border-radius: 17px;
    }
    .mt-x-stage-card[data-expanded='true'] .mt-x-stage-card-toggle {
      border-radius: 17px 17px 0 0;
    }
    .mt-x-stage-card-toggle:hover {
      background: var(--mt-stage-bg-hover, oklch(0.92 0.01 250 / 0.06));
    }
    .mt-x-stage-card-toggle:focus-visible {
      outline: 2px solid var(--mt-focus, oklch(0.6 0.15 250 / 0.8));
      outline-offset: -2px;
    }
    .mt-x-stage-card-title {
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .mt-x-stage-card-heading {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11.5px;
      line-height: 1.1;
      font-weight: 640;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mt-x-stage-card-heading::before {
      width: 5px;
      height: 5px;
      flex: 0 0 auto;
      border-radius: 50%;
      background: var(--mt-stage-fill, oklch(0.72 0.12 350 / 0.96));
      box-shadow: 0 0 0 3px oklch(0.78 0.08 350 / 0.12);
      content: "";
    }
    .mt-x-stage-card-meta {
      color: var(--mt-stage-muted, oklch(0.94 0.01 250 / 0.7));
      font-size: 10.5px;
      line-height: 1.15;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mt-x-stage-card-total {
      font-size: 11.5px;
      font-weight: 660;
      line-height: 1;
      white-space: nowrap;
      color: var(--mt-stage-fill, oklch(0.72 0.12 350 / 0.96));
    }
    .mt-x-stage-card-chevron {
      width: 7px;
      height: 7px;
      border-right: 1.5px solid currentColor;
      border-bottom: 1.5px solid currentColor;
      transform: rotate(45deg);
      transition: transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
      opacity: 0.72;
    }
    .mt-x-stage-card[data-expanded='true'] .mt-x-stage-card-chevron {
      transform: rotate(225deg);
    }
    .mt-x-stage-card-body {
      display: none;
      padding: 0 10px 9px;
      border-top: 1px solid var(--mt-stage-border-soft, oklch(0.9 0.012 250 / 0.22));
    }
    .mt-x-stage-card[data-expanded='true'] .mt-x-stage-card-body {
      display: block;
    }
    .mt-x-error-detail-card .mt-x-stage-card-heading::before {
      background: var(--mt-error-text, oklch(0.82 0.12 25 / 0.85));
      box-shadow: 0 0 0 3px oklch(0.72 0.12 25 / 0.12);
    }
    .mt-x-error-detail-card .mt-x-stage-card-total {
      color: var(--mt-error-text, oklch(0.82 0.12 25 / 0.85));
    }
    .mt-x-error-detail-content {
      max-height: 220px;
      margin: 9px 0 0;
      box-sizing: border-box;
      border: 1px solid var(--mt-stage-border-soft, oklch(0.9 0.012 250 / 0.22));
      border-radius: 12px;
      padding: 8px;
      overflow: auto;
      background: oklch(0 0 0 / 0.18);
      color: var(--mt-stage-muted, oklch(0.94 0.01 250 / 0.7));
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 10.5px;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .mt-x-stage-timing-row {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      align-items: center;
      gap: 6px;
      margin-top: 9px;
    }
    .mt-x-stage-row-label,
    .mt-x-stage-parallel-label {
      min-width: 0;
      color: var(--mt-stage-muted, oklch(0.94 0.01 250 / 0.7));
      font-size: 9.5px;
      font-weight: 560;
      line-height: 1.2;
      text-align: right;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      pointer-events: none;
    }
    .mt-x-stage-timeline {
      position: relative;
      display: flex;
      align-items: center;
      gap: 2px;
      box-sizing: border-box;
      height: 13px;
      padding: 2px;
      border: 1px solid var(--mt-stage-border-soft, oklch(0.9 0.012 250 / 0.18));
      border-radius: 999px;
      background: var(--mt-stage-track, oklch(0.94 0.01 250 / 0.14));
      overflow: visible;
    }
    .mt-x-stage-segment {
      position: relative;
      flex-basis: 0;
      height: 100%;
      min-width: 3px;
      border-radius: 999px;
      background: color-mix(in oklab, var(--mt-stage-fill, oklch(0.72 0.12 350 / 0.96)) var(--mt-stage-alpha, 76%), var(--mt-stage-fill-soft, oklch(0.83 0.07 350 / 0.5)));
      cursor: help;
      opacity: 0.9;
      transition: opacity 0.15s ease-out, filter 0.15s ease-out, box-shadow 0.15s ease-out;
    }
    .mt-x-stage-segment:hover {
      z-index: 5;
      opacity: 1;
      filter: saturate(1.15);
      box-shadow:
        0 0 0 1px oklch(1 0 0 / 0.2),
        0 0 10px color-mix(in oklab, var(--mt-stage-fill, oklch(0.72 0.12 350 / 0.96)) 38%, transparent);
    }
    .mt-x-stage-segment:focus-visible {
      z-index: 5;
      outline: 2px solid var(--mt-focus, oklch(0.6 0.15 250 / 0.8));
      outline-offset: 3px;
    }
    .mt-x-stage-segment[data-tooltip]::before,
    .mt-x-stage-parallel-bar[data-tooltip]::before,
    .mt-x-runtime-node[data-tooltip]::before {
      position: absolute;
      left: 50%;
      bottom: calc(100% + 6px);
      z-index: 20;
      width: 10px;
      height: 10px;
      border-right: 1px solid var(--mt-stage-border-soft, oklch(0.9 0.012 250 / 0.28));
      border-bottom: 1px solid var(--mt-stage-border-soft, oklch(0.9 0.012 250 / 0.28));
      background: var(--mt-stage-bg-active, var(--mt-stage-bg, oklch(0.16 0.012 250 / 0.96)));
      content: "";
      opacity: 0;
      pointer-events: none;
      transform: translateX(-50%) translateY(7px) rotate(45deg);
      transition:
        opacity 90ms ease-out,
        transform 120ms cubic-bezier(0.2, 0.85, 0.25, 1);
    }
    .mt-x-stage-segment[data-tooltip]::after,
    .mt-x-stage-parallel-bar[data-tooltip]::after,
    .mt-x-runtime-node[data-tooltip]::after {
      position: absolute;
      left: 50%;
      bottom: calc(100% + 10px);
      z-index: 21;
      box-sizing: border-box;
      width: max-content;
      max-width: min(248px, calc(100vw - 32px));
      border: 1px solid var(--mt-stage-border-soft, oklch(0.9 0.012 250 / 0.28));
      border-radius: 12px;
      padding: 7px 9px;
      background: var(--mt-stage-bg-active, var(--mt-stage-bg, oklch(0.16 0.012 250 / 0.96)));
      color: var(--mt-text, oklch(0.94 0.01 250));
      box-shadow:
        0 10px 26px oklch(0 0 0 / 0.2),
        inset 0 1px 0 oklch(1 0 0 / 0.08);
      content: attr(data-tooltip);
      font-size: 10.5px;
      font-weight: 560;
      line-height: 1.38;
      letter-spacing: 0;
      opacity: 0;
      overflow-wrap: anywhere;
      pointer-events: none;
      text-align: left;
      text-shadow: none;
      transform: translateX(-50%) translateY(7px);
      transition:
        opacity 90ms ease-out,
        transform 120ms cubic-bezier(0.2, 0.85, 0.25, 1);
      white-space: normal;
    }
    .mt-x-stage-segment[data-tooltip]:hover::before,
    .mt-x-stage-segment[data-tooltip]:hover::after,
    .mt-x-stage-segment[data-tooltip]:focus-visible::before,
    .mt-x-stage-segment[data-tooltip]:focus-visible::after,
    .mt-x-stage-parallel-bar[data-tooltip]:hover::before,
    .mt-x-stage-parallel-bar[data-tooltip]:hover::after,
    .mt-x-stage-parallel-bar[data-tooltip]:focus-visible::before,
    .mt-x-stage-parallel-bar[data-tooltip]:focus-visible::after,
    .mt-x-runtime-node[data-tooltip]:hover::before,
    .mt-x-runtime-node[data-tooltip]:hover::after,
    .mt-x-runtime-node[data-tooltip]:focus-visible::before,
    .mt-x-runtime-node[data-tooltip]:focus-visible::after {
      opacity: 1;
      transform: translateX(-50%) translateY(0) rotate(45deg);
    }
    .mt-x-stage-segment[data-tooltip]:hover::after,
    .mt-x-stage-segment[data-tooltip]:focus-visible::after,
    .mt-x-stage-parallel-bar[data-tooltip]:hover::after,
    .mt-x-stage-parallel-bar[data-tooltip]:focus-visible::after,
    .mt-x-runtime-node[data-tooltip]:hover::after,
    .mt-x-runtime-node[data-tooltip]:focus-visible::after {
      transform: translateX(-50%) translateY(0);
    }
    .mt-x-stage-parallel {
      display: none;
      gap: 4px;
      padding-top: 5px;
    }
    .mt-x-stage-parallel[data-visible='true'] {
      display: grid;
    }
    .mt-x-stage-parallel-row {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr);
      align-items: center;
      gap: 6px;
      min-height: 12px;
    }
    .mt-x-stage-parallel-track {
      position: relative;
      box-sizing: border-box;
      width: 100%;
      height: 10px;
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 1px 2px;
      border: 1px solid var(--mt-stage-border-soft, oklch(0.9 0.012 250 / 0.16));
      border-radius: 999px;
      background: var(--mt-stage-track, oklch(0.94 0.01 250 / 0.14));
      overflow: visible;
      pointer-events: none;
    }
    .mt-x-stage-parallel-slot {
      min-width: 3px;
      height: 100%;
      flex-basis: 0;
      pointer-events: none;
    }
    .mt-x-stage-parallel-inner {
      display: flex;
      align-items: stretch;
      gap: 2px;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }
    .mt-x-stage-parallel-spacer {
      min-width: 0;
      height: 100%;
      flex-basis: 0;
      opacity: 0;
      pointer-events: none;
    }
    .mt-x-stage-parallel-bar {
      position: relative;
      z-index: 1;
      flex-basis: 0;
      height: 100%;
      min-width: 3px;
      border-radius: 999px;
      background: color-mix(in oklab, var(--mt-stage-fill, oklch(0.72 0.12 350 / 0.96)) 82%, var(--mt-stage-fill-soft, oklch(0.83 0.07 350 / 0.5)));
      box-shadow: inset 0 1px 0 oklch(1 0 0 / 0.18);
      cursor: help;
      pointer-events: auto;
    }
    .mt-x-stage-parallel-bar[data-stage='mask_refine'] {
      opacity: 0.68;
    }
    .mt-x-stage-parallel-bar[data-stage='inpaint'] {
      background: color-mix(in oklab, var(--mt-stage-fill, oklch(0.72 0.12 350 / 0.96)) 94%, var(--mt-stage-fill-soft, oklch(0.83 0.07 350 / 0.5)));
    }
    .mt-x-stage-parallel-bar:hover,
    .mt-x-stage-parallel-bar:focus-visible {
      z-index: 5;
      outline: none;
      box-shadow:
        inset 0 1px 0 oklch(1 0 0 / 0.2),
        0 0 10px color-mix(in oklab, var(--mt-stage-fill, oklch(0.72 0.12 350 / 0.96)) 36%, transparent);
    }
    .mt-x-stage-runtime {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      align-items: center;
      gap: 5px;
      padding-top: 8px;
    }
    .mt-x-runtime-node {
      position: relative;
      min-width: 0;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      grid-template-areas:
        "dot label"
        "dot provider";
      align-items: center;
      column-gap: 5px;
      min-height: 42px;
      box-sizing: border-box;
      border: 1px solid var(--mt-stage-node-border, oklch(0.85 0.05 175 / 0.7));
      border-radius: 14px;
      padding: 7px 8px 6px;
      background: var(--mt-stage-node-bg, oklch(0.16 0.03 175 / 0.72));
      color: var(--mt-stage-muted, oklch(0.94 0.01 250 / 0.7));
      box-shadow: inset 0 1px 0 oklch(1 0 0 / 0.06);
    }
    .mt-x-runtime-dot {
      grid-area: dot;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--mt-stage-fill, oklch(0.72 0.12 350 / 0.96));
      box-shadow: 0 0 0 3px oklch(0.72 0.1 350 / 0.1);
    }
    .mt-x-runtime-node[data-status='disabled'] .mt-x-runtime-dot,
    .mt-x-runtime-node[data-status='unknown'] .mt-x-runtime-dot {
      background: var(--mt-stage-muted, oklch(0.94 0.01 250 / 0.7));
      box-shadow: none;
      opacity: 0.58;
    }
    .mt-x-runtime-node[data-status='enabled'] {
      border-color: var(--mt-stage-border-soft, oklch(0.9 0.012 250 / 0.22));
    }
    .mt-x-runtime-node:hover,
    .mt-x-runtime-node:focus-visible {
      z-index: 5;
    }
    .mt-x-runtime-node:focus-visible {
      outline: 2px solid var(--mt-focus, oklch(0.6 0.15 250 / 0.8));
      outline-offset: 2px;
    }
    .mt-x-runtime-label {
      grid-area: label;
      min-width: 0;
      color: var(--mt-text, oklch(0.94 0.01 250));
      font-size: 10.5px;
      font-weight: 650;
      line-height: 1.1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mt-x-runtime-provider {
      grid-area: provider;
      min-width: 0;
      margin-top: 2px;
      font-size: 9.5px;
      line-height: 1.32;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
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
    .mt-x-screenshot-result[data-overlay-motion='smooth'] .mt-x-overlay-inline {
      transition:
        left var(--mt-overlay-motion-ms, 240ms) cubic-bezier(0.16, 0.92, 0.18, 1),
        right var(--mt-overlay-motion-ms, 240ms) cubic-bezier(0.16, 0.92, 0.18, 1),
        top var(--mt-overlay-motion-ms, 240ms) cubic-bezier(0.16, 0.92, 0.18, 1);
    }
    .mt-x-screenshot-result img {
      position: relative;
      z-index: 1;
      display: none;
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      object-fit: fill;
      pointer-events: auto;
      user-select: none;
      -webkit-user-drag: none;
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

function renderErrorDetailCard(ui: UiElements, state: PhotoState | null): void {
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

function renderStageTimingCard(ui: UiElements, state: PhotoState | null): void {
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
    renderErrorDetailCard(ui, null);
    renderStageTimingCard(ui, null);
    clearTransitionTimers();
    return;
  }

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
  const currentSpinner = document.createElement('span');
  currentSpinner.className = 'mt-x-spinner';
  currentSpinner.innerHTML = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>';
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
  const allSpinner = document.createElement('span');
  allSpinner.className = 'mt-x-spinner';
  allSpinner.innerHTML = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>';
  const allLabel = document.createElement('span');
  allLabel.className = 'mt-x-label';
  allLabel.textContent = '翻译全部';
  translateAllBtn.appendChild(allIcon);
  translateAllBtn.appendChild(allSpinner);
  translateAllBtn.appendChild(allLabel);
  host.appendChild(translateAllBtn);

  return { host, translateCurrentBtn, translateAllBtn };
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
