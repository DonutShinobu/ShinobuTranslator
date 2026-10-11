import { createMorph, TextMorph, type Morph } from './motion-vendor/motion-kit.js';
import { createLiquidGlass } from './liquidGlass';
import { resolveTranslationIcon, translationIconPaths, type TranslationIconKey } from './translationIcons';

export type { TranslationIconKey } from './translationIcons';

type ButtonMotion = {
  button: HTMLButtonElement;
  icon: HTMLElement;
  path: SVGPathElement;
  label: HTMLElement;
  text: string;
  iconKey: TranslationIconKey;
  running: boolean;
  target: string;
  completionTimer?: ReturnType<typeof setTimeout>;
  morph?: Morph;
  textMorph?: TextMorph;
  hiddenMotion?: boolean;
  glass?: ReturnType<typeof createLiquidGlass>;
  removeListeners?: () => void;
};

const motions = new WeakMap<HTMLButtonElement, ButtonMotion>();
const ns = 'http://www.w3.org/2000/svg';

export function initializeTranslationButton(
  button: HTMLButtonElement,
  icon: HTMLElement,
  label: HTMLElement,
): void {
  button.className += ' mt-x-liquid';
  icon.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS(ns, 'svg');
  for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.65', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(key, value);
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', translationIconPaths.languages);
  svg.appendChild(path);
  icon.replaceChildren(svg);
  const slot = document.createElement('span');
  slot.className = 'mt-x-label-slot';
  slot.appendChild(label);
  button.replaceChildren(icon, slot);
  motions.set(button, { button, icon, path, label, text: label.textContent || '', iconKey: 'languages', target: '', running: false });
}

export function createTranslationButton(text: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.className = 'mt-x-control';
  button.type = 'button';
  const icon = document.createElement('span');
  icon.className = 'mt-x-icon';
  const label = document.createElement('span');
  label.className = 'mt-x-label';
  label.textContent = text;
  initializeTranslationButton(button, icon, label);
  button.setAttribute('aria-label', text);
  return button;
}

function settle(label: HTMLElement): void {
  for (const animation of label.getAnimations({ subtree: true })) {
    if (animation.playState === 'finished') animation.cancel();
  }
  for (const node of label.querySelectorAll<HTMLElement>('[torph-exiting]')) {
    if (!node.getAnimations().length) node.remove();
  }
}

function resetTextMotion(model: ButtonMotion, hidden: boolean): void {
  if (model.textMorph && model.hiddenMotion === hidden) return;
  model.textMorph?.destroy();
  for (const animation of model.label.getAnimations({ subtree: true })) animation.cancel();
  model.label.replaceChildren();
  model.textMorph = new TextMorph({
    element: model.label, duration: 340, ease: 'cubic-bezier(.19,1,.22,1)',
    locale: 'zh-CN', scale: false, numbers: false, disabled: hidden, respectReducedMotion: false,
    onAnimationComplete: () => { settle(model.label); model.glass?.refresh(); },
  });
  model.hiddenMotion = hidden;
  model.textMorph.update(model.text);
}

function startMotion(model: ButtonMotion): void {
  const { button } = model;
  // Detached controls and browsers without WAAPI keep the same usable static UI.
  if (model.morph || !button.isConnected || typeof button.animate !== 'function') return;
  model.glass = createLiquidGlass(button);
  model.morph = createMorph(model.path, translationIconPaths[model.iconKey], { reducedMotion: 'never' });
  const syncVisibility = () => {
    resetTextMotion(model, document.hidden);
    if (document.hidden) model.morph!.set(translationIconPaths[model.iconKey]);
    model.glass!.refresh();
  };
  const pointer = (event: PointerEvent) => {
    const bounds = button.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    model.glass!.material.style.setProperty('--touch-x', `${(event.clientX - bounds.left) / bounds.width * 100}%`);
    model.glass!.material.style.setProperty('--touch-y', `${(event.clientY - bounds.top) / bounds.height * 100}%`);
  };
  document.addEventListener('visibilitychange', syncVisibility);
  button.addEventListener('pointermove', pointer);
  model.removeListeners = () => {
    document.removeEventListener('visibilitychange', syncVisibility);
    button.removeEventListener('pointermove', pointer);
  };
  syncVisibility();
}

function show(model: ButtonMotion, text: string, icon: TranslationIconKey): void {
  startMotion(model);
  if (text !== model.text) {
    if (model.textMorph) {
      const previous = new Set(model.label.querySelectorAll('[torph-item][torph-id]:not([torph-exiting])'));
      const width = model.label.getBoundingClientRect().width;
      model.textMorph.update(text);
      if (!model.hiddenMotion) {
        // Keep entering glyphs inside the slot; shared glyphs retain Torph's FLIP.
        for (const node of model.label.querySelectorAll<HTMLElement>('[torph-item][torph-id]:not([torph-exiting])')) {
          if (previous.has(node)) continue;
          for (const animation of node.getAnimations()) {
            const effect = animation.effect as KeyframeEffect;
            const frames = effect.getKeyframes();
            if (frames[0]?.transform) {
              const pose = new DOMMatrix(String(frames[0].transform));
              pose.m41 = Math.max(-node.offsetLeft, Math.min(pose.m41, Math.max(0, width - node.offsetWidth) - node.offsetLeft));
              frames[0].transform = pose.toString();
              effect.setKeyframes(frames);
            } else if (frames[0]?.opacity !== undefined) {
              effect.updateTiming({ duration: 260, delay: 0, easing: 'cubic-bezier(.33,0,.2,1)' });
            }
          }
        }
      }
    } else model.label.textContent = text;
    model.text = text;
  }
  if (model.iconKey !== icon) {
    if (model.morph) {
      if (model.hiddenMotion) model.morph.set(translationIconPaths[icon]);
      else model.morph.morphTo(translationIconPaths[icon], { stiffness: 400, damping: 40 });
    } else model.path.setAttribute('d', translationIconPaths[icon]);
    model.iconKey = icon;
  }
  model.icon.dataset.icon = icon;
  model.button.dataset.phase = icon;
  model.glass?.setRunning(model.running && icon !== 'confirm');
  model.glass?.refresh();
}

export function updateTranslationButton(
  button: HTMLButtonElement,
  text: string,
  icon = resolveTranslationIcon(text),
  running = button.dataset.status === 'running',
): void {
  const model = motions.get(button);
  button.setAttribute('aria-label', text);
  button.setAttribute('aria-busy', String(running));
  button.title = text;
  button.dataset.label = text;
  if (!model) {
    // Alternate consumers can supply a plain button without the animated structure.
    const label = button.querySelector<HTMLElement>('.mt-x-label');
    if (label) label.textContent = text;
    return;
  }
  if (model.target === text && model.running === running && model.completionTimer) return;
  const completed = model.running && !running && icon === 'original' && !!model.morph;
  clearTimeout(model.completionTimer);
  model.completionTimer = undefined;
  model.target = text;
  model.running = running;
  if (completed) {
    show(model, '完成', 'confirm');
    // Feedback is visual only: callers already enable the original/translated toggle.
    model.completionTimer = setTimeout(() => {
      model.completionTimer = undefined;
      show(model, text, icon);
    }, 600);
  } else show(model, text, icon);
}

export function destroyTranslationButton(button: HTMLButtonElement): void {
  const model = motions.get(button);
  if (!model) return;
  clearTimeout(model.completionTimer);
  model.removeListeners?.();
  model.morph?.destroy();
  model.textMorph?.destroy();
  model.glass?.destroy();
  model.label.textContent = model.target || model.text;
  if (typeof button.getAnimations === 'function') {
    for (const animation of button.getAnimations({ subtree: true })) animation.cancel();
  }
  motions.delete(button);
}

export function refreshTranslationButton(button: HTMLButtonElement): void {
  motions.get(button)?.glass?.refresh();
}
