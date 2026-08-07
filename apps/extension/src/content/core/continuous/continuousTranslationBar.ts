import type {
  ContinuousTranslationBarHandlers,
  ContinuousTranslationBarPort,
  ContinuousTranslationViewState,
} from './continuousTranslationController';

const barStyles = `
  :host { all: initial; }
  .bar {
    display: flex; flex-direction: column; align-items: flex-end; gap: 5px;
    color: oklch(0.94 0.01 250); font: 500 13px/1 system-ui, sans-serif;
  }
  .actions { display: flex; align-items: center; gap: 7px; }
  button {
    height: 34px; border: 1px solid oklch(0.92 0.01 250 / .75);
    border-radius: 999px; padding: 0 11px; cursor: pointer;
    background: oklch(0.14 0.01 250 / .78); color: inherit;
    backdrop-filter: blur(16px) saturate(1.4); font: inherit;
  }
  button:hover { background: oklch(0.14 0.01 250 / .92); }
  button:focus-visible { outline: 2px solid oklch(0.65 0.15 250); outline-offset: 2px; }
  button[hidden] { display: none; }
  .status {
    max-width: 300px; padding: 5px 9px; border-radius: 9px;
    background: oklch(0.14 0.01 250 / .78); color: oklch(0.94 0.01 250 / .8);
    font-size: 12px; line-height: 1.35; backdrop-filter: blur(16px);
  }
  .status:empty { display: none; }
  .status[data-error='true'] { color: oklch(0.82 0.14 25); }
`;

export class ContinuousTranslationBar implements ContinuousTranslationBarPort {
  private readonly host: HTMLDivElement;
  private readonly enableButton: HTMLButtonElement;
  private readonly displayButton: HTMLButtonElement;
  private readonly retryButton: HTMLButtonElement;
  private readonly status: HTMLDivElement;
  private handlers: ContinuousTranslationBarHandlers | undefined;
  private mounted = false;
  private disposed = false;

  constructor(private readonly document: Document = globalThis.document) {
    this.host = document.createElement('div');
    this.host.dataset.mtContinuousUi = '';
    Object.assign(this.host.style, {
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      zIndex: '2147483646',
    });
    const shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = barStyles;
    const bar = document.createElement('div');
    bar.className = 'bar';
    const actions = document.createElement('div');
    actions.className = 'actions';
    this.enableButton = this.button('开启连续翻译');
    this.displayButton = this.button('显示原图');
    this.retryButton = this.button('重试失败页');
    this.retryButton.hidden = true;
    actions.append(this.enableButton, this.displayButton, this.retryButton);
    this.status = document.createElement('div');
    this.status.className = 'status';
    this.status.setAttribute('aria-live', 'polite');
    bar.append(actions, this.status);
    shadow.append(style, bar);

    this.enableButton.addEventListener('click', () => {
      const enabled = this.enableButton.dataset.enabled === 'true';
      this.handlers?.setEnabled(!enabled);
    });
    this.displayButton.addEventListener('click', () => {
      const original = this.displayButton.dataset.mode === 'original';
      this.handlers?.setDisplayMode(original ? 'translated' : 'original');
    });
    this.retryButton.addEventListener('click', () => this.handlers?.retryFailures());
    this.document.addEventListener('fullscreenchange', this.moveIntoFullscreenRoot);
  }

  setHandlers(handlers: ContinuousTranslationBarHandlers): void {
    this.handlers = handlers;
  }

  mount(): void {
    if (this.disposed) return;
    this.mounted = true;
    this.moveIntoFullscreenRoot();
  }

  update(state: ContinuousTranslationViewState): void {
    if (this.disposed) return;
    this.enableButton.dataset.enabled = String(state.enabled);
    this.enableButton.setAttribute('aria-pressed', String(state.enabled));
    this.enableButton.textContent = state.phase === 'starting'
      ? '启动中…'
      : state.enabled ? '关闭连续翻译' : '开启连续翻译';
    this.enableButton.disabled = state.phase === 'starting';
    this.displayButton.dataset.mode = state.displayMode;
    this.displayButton.textContent = state.displayMode === 'translated' ? '显示原图' : '显示译图';
    this.displayButton.disabled = !state.enabled;
    this.retryButton.hidden = !state.canRetry;
    this.status.dataset.error = String(state.phase === 'error');
    this.status.textContent = state.message
      ?? (state.processingPage !== undefined
        ? `第 ${state.processingPage} 页处理中 · 队列 ${state.queued}`
        : state.queued > 0
          ? `队列 ${state.queued}`
          : state.enabled ? '等待页面' : '');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.document.removeEventListener('fullscreenchange', this.moveIntoFullscreenRoot);
    this.host.remove();
    this.handlers = undefined;
  }

  private readonly moveIntoFullscreenRoot = (): void => {
    if (!this.mounted || this.disposed) return;
    const parent = this.document.fullscreenElement ?? this.document.documentElement;
    parent.appendChild(this.host);
  };

  private button(label: string): HTMLButtonElement {
    const button = this.document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    return button;
  }
}
