import { getExtensionRuntime } from '../../../shared/extensionRuntime';
import cornerStyles from './corners.css?inline';

const styleId = 'mt-overlay-style';

export function resolveRuntimeAssetUrl(path: string): string | null {
  const runtime = getExtensionRuntime();
  return runtime ? runtime.getURL(path) : null;
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
      --mt-glass-text: #fff5fb;
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
      --mt-glass-text: #402c39;
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
      font-family: "MTX-SourceHanSans-CN", "MTX-SourceHanSans-TW", system-ui, sans-serif;
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
    }
    .mt-x-control.mt-x-simple[data-status='running'] {
      overflow: hidden;
    }
    .mt-x-control.mt-x-simple[data-status='running'] .mt-x-icon {
      display: none;
    }
    .mt-x-control-secondary.mt-x-simple .mt-x-icon {
      display: none;
    }
    .mt-x-simple .mt-x-spinner {
      display: none;
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
      will-change: transform;
      animation: mt-x-spin-rotate 1.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
    }
    .mt-x-simple .mt-x-spinner svg {
      width: 16px;
      height: 16px;
    }
    .mt-x-simple .mt-x-spinner svg circle {
      fill: none;
      stroke: currentColor;
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-dasharray: 1, 37.7;
      animation: mt-x-spin-arc 1.8s ease-in-out infinite;
    }
    .mt-x-control.mt-x-simple[data-status='running'] .mt-x-spinner {
      display: inline-flex;
    }
    .mt-x-control.mt-x-simple[data-status='running']::after {
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
    .mt-x-control.mt-x-liquid,
    .mt-x-screenshot-select-toolbar.mt-x-liquid {
      --mt-glass-solid: #f3edf0;
      --mt-glass-shadow: #3725321f;
      box-sizing: border-box;
      isolation: isolate;
      min-width: 0;
      max-width: 100%;
      padding: 0 12px;
      border: 0;
      background: transparent;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      /* Inherit the nearest theme; page-wide light selectors can cross dark anchors. */
      color: var(--mt-glass-text, #fff5fb);
      text-shadow: none;
      -webkit-text-fill-color: currentColor;
      letter-spacing: 0;
      transform-origin: center center;
      touch-action: manipulation;
      -webkit-tap-highlight-color: transparent;
      transition: color 180ms cubic-bezier(.25,1,.5,1);
    }
    .mt-x-liquid .mt-x-glass-material {
      position: absolute;
      inset: 0;
      z-index: -1;
      border-radius: inherit;
      border: 0;
      background-color: transparent;
      backdrop-filter: none;
      -webkit-backdrop-filter: none;
      box-shadow: inset 0 .5px .65px #fff8fc40, inset 0 -.5px .8px #68334924, 0 2px 8px var(--mt-glass-shadow, #37253233);
      transition: background-color 180ms cubic-bezier(.25,1,.5,1), box-shadow 180ms cubic-bezier(.25,1,.5,1);
      pointer-events: none;
    }
    .mt-x-liquid .mt-x-glass-optical {
      /* Clear tone and the padded optical overlay replace the fallback's inset highlights. */
      background-color: transparent;
      box-shadow: 0 2px 8px var(--mt-glass-shadow, #37253233);
    }
    .mt-x-glass-overlay {
      position: absolute;
      left: -2px;
      top: -2px;
      width: calc(100% + 4px);
      height: calc(100% + 4px);
      overflow: visible;
      pointer-events: none;
    }
    .mt-x-glass-material::before {
      content: '';
      position: absolute;
      inset: 0;
      z-index: 1;
      border-radius: inherit;
      background-image: radial-gradient(
        var(--lg-glow-size,64px) circle at var(--lg-glow-x,50%) var(--lg-glow-y,50%),
        color-mix(in srgb, rgb(255 255 255 / .3) calc(var(--lg-glow,0) * 100%), transparent),
        transparent
      );
    }
    .mt-x-glass-light-color { transition: flood-color 240ms cubic-bezier(.25,1,.5,1); }
    .mt-x-glass-light-base { transition: opacity 240ms cubic-bezier(.25,1,.5,1); }
    .mt-x-liquid .mt-x-icon { flex: 0 0 16px; transition: none; }
    .mt-x-liquid .mt-x-icon svg { overflow: visible; color: inherit; filter: none; }
    .mt-x-liquid .mt-x-icon, .mt-x-liquid .mt-x-label, .mt-x-liquid [torph-item] { color: inherit !important; -webkit-text-fill-color: currentColor; }
    .mt-x-liquid .mt-x-label-slot { position: relative; min-width: 0; max-width: min(366px, calc(100vw - 80px)); overflow: hidden; }
    .mt-x-liquid .mt-x-label { display: block; line-height: 20px; font-weight: 550; overflow: visible; white-space: pre; transition: none; }
    .mt-x-control.mt-x-liquid:hover:not(:disabled), .mt-x-control.mt-x-liquid:active:not(:disabled) { background: transparent; }
    @media (prefers-reduced-transparency: reduce) {
      .mt-x-control.mt-x-liquid, .mt-x-screenshot-select-toolbar.mt-x-liquid { color: #17131a !important; }
      .mt-x-liquid .mt-x-glass-material { background: var(--mt-glass-solid); backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }
      .mt-x-liquid .mt-x-icon, .mt-x-liquid .mt-x-label, .mt-x-liquid [torph-item] { color: inherit !important; }
    }
    @supports not (backdrop-filter: blur(1px)) {
      .mt-x-control.mt-x-liquid, .mt-x-screenshot-select-toolbar.mt-x-liquid { color: #17131a !important; }
      .mt-x-liquid .mt-x-glass-material { background: var(--mt-glass-solid); }
      .mt-x-liquid .mt-x-icon, .mt-x-liquid .mt-x-label, .mt-x-liquid [torph-item] { color: inherit !important; }
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
    .mt-x-context-notice:empty {
      display: none;
    }

    .mt-x-stage-card {
      display: none;
      width: min(286px, calc(100vw - 24px));
      max-width: 286px;
      margin-top: 2px;
      box-sizing: border-box;
      border: 1px solid var(--mt-stage-border, oklch(0.9 0.012 250 / 0.22));
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
    }
    .mt-x-stage-card[data-expanded='true'] .mt-x-stage-card-toggle {
      border-bottom-left-radius: 0;
      border-bottom-right-radius: 0;
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
      flex-direction: column;
      align-items: flex-end;
      gap: 4px;
    }

    .mt-x-reading-actions {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .mt-x-reading-bar > .mt-x-detail:empty {
      display: none;
    }

    .mt-x-pill-close.mt-x-liquid,
    .mt-x-pill-close.mt-x-simple {
      position: absolute;
      right: -4px;
      top: -4px;
      z-index: 2;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 15px;
      height: 15px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 9px;
      line-height: 1;
      padding: 0;
      flex: 0 0 auto;
    }
    .mt-x-pill-close.mt-x-simple {
      border: 1px solid var(--mt-border, oklch(0.55 0.01 250 / 0.7));
      background: var(--mt-bg-active, oklch(0.97 0.005 250 / 0.92));
      color: oklch(0.38 0.006 250 / 0.94);
      overflow: hidden;
      transition: transform 0.15s ease-out;
    }
    .mt-x-pill-close.mt-x-simple::after {
      content: '';
      position: absolute;
      inset: 0;
      border-radius: inherit;
      background: oklch(0 0 0 / 0.12);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.15s ease-out;
    }
    .mt-x-pill-close.mt-x-simple:hover::after {
      opacity: 1;
    }
    .mt-x-pill-close.mt-x-simple:hover {
      transform: scale(1.04);
    }
    .mt-x-pill-close.mt-x-simple svg {
      position: relative;
      z-index: 1;
      width: 9px;
      height: 9px;
      display: block;
    }
    .mt-x-pill-close > .mt-x-icon {
      width: 9px;
      height: 9px;
      flex-basis: 9px;
    }
    .mt-x-pill-close > .mt-x-icon svg {
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
    .mt-x-screenshot-select-toolbar.mt-x-liquid,
    .mt-x-screenshot-select-toolbar.mt-x-simple {
      position: fixed;
      z-index: 2147483647;
      display: none;
      gap: 6px;
      align-items: center;
      padding: 4px;
      border-radius: 999px;
      pointer-events: auto;
    }
    .mt-x-screenshot-select-toolbar.mt-x-simple {
      border: 1px solid oklch(0.55 0.01 250 / 0.46);
      background: oklch(0.97 0.005 250 / 0.9);
      box-shadow: 0 8px 24px oklch(0 0 0 / 0.18);
      backdrop-filter: blur(16px) saturate(1.4);
      -webkit-backdrop-filter: blur(16px) saturate(1.4);
    }
    .mt-x-screenshot-select[data-phase='confirming'] .mt-x-screenshot-select-toolbar {
      display: inline-flex;
    }
    .mt-x-screenshot-select-action.mt-x-liquid,
    .mt-x-screenshot-select-action.mt-x-simple {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      padding: 0;
    }
    .mt-x-screenshot-select-action.mt-x-simple {
      border: 0;
      background: oklch(0.94 0.008 250 / 0.92);
      color: oklch(0.16 0.006 250);
      transition: background-color 0.15s ease-out, transform 0.15s ease-out;
    }
    .mt-x-screenshot-select-action.mt-x-simple:hover {
      background: oklch(0.86 0.012 250 / 0.96);
      transform: scale(1.04);
    }
    .mt-x-screenshot-select-action.mt-x-simple[data-action='confirm'] {
      color: oklch(0.34 0.07 150);
    }
    .mt-x-screenshot-select-action.mt-x-simple[data-action='reset'] {
      color: oklch(0.38 0.045 25);
    }
    .mt-x-screenshot-select-action.mt-x-simple svg {
      width: 15px;
      height: 15px;
      display: block;
    }
    .mt-x-screenshot-select-action > .mt-x-icon {
      width: 15px;
      height: 15px;
      flex-basis: 15px;
    }
    .mt-x-screenshot-select-action > .mt-x-icon svg {
      width: 15px;
      height: 15px;
      display: block;
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

    .mt-x-layer-editor {
      position: fixed;
      z-index: 2147483646;
      overflow: clip;
      isolation: isolate;
      outline: none;
      touch-action: none;
      user-select: none;
    }
    .mt-x-layer-editor[data-contained='true'] { position: absolute; z-index: 2; }
    .mt-x-layer-control-portal {
      position: fixed;
      z-index: 2147483647;
      max-width: min(480px, 85vw);
    }
    .mt-x-layer-control-portal > .mt-x-overlay-inline {
      position: static !important;
      left: auto !important;
      right: auto !important;
      top: auto !important;
      bottom: auto !important;
      transform: none !important;
    }
    .mt-x-layer-stage {
      position: absolute;
      left: 0;
      top: 0;
      transform-origin: 0 0;
      pointer-events: none;
    }
    .mt-x-layer-stage > img {
      position: absolute !important;
      display: block !important;
      left: 0 !important;
      top: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      border: 0 !important;
      max-width: none !important;
      max-height: none !important;
      object-fit: fill !important;
      transform-origin: 0 0 !important;
      transition: none !important;
      pointer-events: none !important;
      box-shadow: none !important;
      z-index: 0 !important;
    }
    .mt-x-layer-stage > .mt-x-layer-highlight {
      --mt-layer-highlight: oklch(0.65 0.16 350);
      z-index: 2 !important;
      opacity: 0.35;
      filter: drop-shadow(0 0 var(--mt-layer-glow, 2px) var(--mt-layer-highlight));
    }
    .mt-x-layer-stage > .mt-x-layer-highlight[data-kind='erase'] { --mt-layer-highlight: oklch(0.64 0.12 195); }
    .mt-x-layer-stage > .mt-x-layer-highlight[data-selected='true'] { opacity: 0.55; }
    .mt-x-layer-selection {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: visible;
      pointer-events: none;
      z-index: 3;
    }
    .mt-x-layer-selection > polygon {
      fill: none;
      stroke: oklch(0.65 0.16 350);
      stroke-width: 1.5;
      stroke-dasharray: 8 4;
      stroke-linejoin: round;
    }
    .mt-x-layer-selection > polygon[data-kind='erase'] { stroke: oklch(0.64 0.12 195); }
    .mt-x-layer-input {
      appearance: none;
      position: absolute;
      left: 0;
      top: 0;
      transform-origin: 0 0;
      box-sizing: border-box;
      z-index: 4;
      min-width: 0;
      max-width: none;
      margin: 0;
      padding: 0;
      border: 0;
      border-radius: 0;
      outline: none;
      box-shadow: none;
      background: transparent;
      color: transparent;
      caret-color: var(--mt-layer-caret);
      -webkit-text-fill-color: transparent;
      font-kerning: none;
      white-space: pre;
      overflow: visible;
      resize: none;
      pointer-events: auto;
      user-select: text;
    }
    .mt-x-layer-input .mt-x-layer-glyph { position: relative; display: inline-block; vertical-align: top; white-space: pre; user-select: text; }
    .mt-x-layer-input::selection, .mt-x-layer-input *::selection { background: oklch(0.65 0.16 350 / 0.3); }
    .mt-x-layer-error { flex-basis: 100%; color: var(--mt-error-text, oklch(0.5 0.16 25)); }
    .mt-x-layer-error:empty { display: none; }

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
      0% { stroke-dasharray: 1, 37.7; stroke-dashoffset: 0; }
      50% { stroke-dasharray: 25, 37.7; stroke-dashoffset: -12; }
      100% { stroke-dasharray: 1, 37.7; stroke-dashoffset: -37.7; }
    }
    @media (prefers-reduced-motion: reduce) {
      .mt-x-simple .mt-x-spinner,
      .mt-x-simple .mt-x-spinner svg circle,
      .mt-x-control.mt-x-simple[data-status='running']::after {
        animation: none;
      }
    }

    ${cornerStyles}
  `;
  document.documentElement.appendChild(style);
}
