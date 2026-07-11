import type {
  ImageTarget,
  PhotoState,
  SiteAdapter,
} from './types';
import {
  createUiElements,
  injectStyles,
  renderUi,
} from './ui';
import type { UiElements } from './ui';
import type { ScreenshotRect, ScreenshotSelection } from './screenshot';
import { TranslationRunner } from './translation/translationRunner';
import { ImageTranslationController } from './translation/imageTranslationController';
import { PhotoStateStore } from './state/photoStateStore';
import { ReadingModeController } from './reading/readingModeController';
import { CardStateController } from './ui/cardState';
import { ScreenshotController } from './screenshot/screenshotController';

type MountedImage = {
  key: string;
  target: ImageTarget;
  ui: UiElements;
};

export class TranslatorCore {
  private adapter: SiteAdapter;
  private readonly stateStore = new PhotoStateStore();
  private readonly translationRunner = new TranslationRunner();
  private readonly cardStateController = new CardStateController();
  private readonly screenshotController = new ScreenshotController(
    this.stateStore,
    this.translationRunner,
    this.cardStateController,
  );
  private readonly imageTranslationController: ImageTranslationController;
  private readonly readingModeController: ReadingModeController;
  private mounted = new Map<string, MountedImage>();
  private disposeObserver: (() => void) | null = null;
  private syncTimer: number | null = null;

  constructor(adapter: SiteAdapter) {
    this.adapter = adapter;
    this.imageTranslationController = new ImageTranslationController(
      this.stateStore,
      this.translationRunner,
      {
        resolveTarget: (key) => this.mounted.get(key)?.target,
        applyImage: (target, state) => this.applyStateImage(target, state),
        render: (key) => this.renderForKey(key),
      },
    );
    this.readingModeController = new ReadingModeController(
      adapter,
      this.stateStore,
      this.translationRunner,
      () => this.scheduleSync(),
      () => this.cancelScheduledSync(),
    );
  }

  stop(): void {
    if (this.disposeObserver) {
      this.disposeObserver();
      this.disposeObserver = null;
    }
    if (this.syncTimer !== null) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.readingModeController.teardown();
    this.screenshotController.dispose();
    this.stateStore.dispose();
  }

  start(): void {
    injectStyles();
    this.disposeObserver = this.adapter.observe(() => this.scheduleSync());
    this.sync();
  }

  async startScreenshotTranslate(): Promise<void> {
    await this.screenshotController.startScreenshotTranslate();
  }

  async translateImageInFloatingOverlay(
    originalUrl: string,
    imageElement: HTMLImageElement,
    fallbackDocumentRect: ScreenshotRect,
  ): Promise<void> {
    await this.screenshotController.translateImageInFloatingOverlay(
      originalUrl,
      imageElement,
      fallbackDocumentRect,
    );
  }

  async translateScreenshotSelection(selection: ScreenshotSelection): Promise<void> {
    await this.screenshotController.translateScreenshotSelection(selection);
  }

  private scheduleSync(): void {
    if (this.syncTimer !== null) return;
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      this.sync();
    }, 100);
  }

  private cancelScheduledSync(): void {
    if (this.syncTimer === null) return;
    window.clearTimeout(this.syncTimer);
    this.syncTimer = null;
  }

  private sync(): void {
    if (this.adapter.isReadingMode?.()) {
      this.readingModeController.sync();
      return;
    }

    // Not in reading mode — clean up reading bar if it was previously shown.
    this.readingModeController.teardown();

    const targets = this.adapter.findImages();
    const currentKeys = new Set(targets.map((t) => t.key));

    for (const [key, mounted] of this.mounted) {
      if (!currentKeys.has(key)) {
        mounted.ui.host.remove();
        this.mounted.delete(key);
      }
    }

    for (const target of targets) {
      const mounted = this.mounted.get(target.key);
      if (mounted?.ui.host.isConnected) {
        mounted.target = target;
        const state = this.stateStore.ensure(target.key, target.originalUrl);
        this.applyStateImage(target, state);
        continue;
      }
      if (mounted) {
        this.mounted.delete(target.key);
      }

      const key = target.key;
      const anchor = this.adapter.createUiAnchor(target);
      const ui = createUiElements();
      anchor.appendChild(ui.host);

      ui.button.addEventListener('click', () => {
        const currentTarget = this.mounted.get(key)?.target ?? target;
        void this.imageTranslationController.handleTranslateClick(currentTarget);
      });
      ui.stageTimingCardToggleButton.addEventListener('click', () => {
        const state = this.stateStore.get(key);
        if (state) this.cardStateController.toggleStageTimingCard(state, () => this.renderForKey(key));
      });
      ui.errorDetailCardToggleButton.addEventListener('click', () => {
        const state = this.stateStore.get(key);
        if (state) this.cardStateController.toggleErrorDetailCard(state, () => this.renderForKey(key));
      });

      this.mounted.set(key, { key, target, ui });
      const state = this.stateStore.ensure(key, target.originalUrl);
      this.applyStateImage(target, state);
      renderUi(ui, state);
    }
  }

  private renderForKey(key: string): void {
    const mounted = this.mounted.get(key);
    if (!mounted) return;
    const state = this.stateStore.get(key) ?? null;
    renderUi(mounted.ui, state);
  }

  private applyStateImage(target: ImageTarget, state: PhotoState): void {
    if (!state.translatedUrl) return;
    const imageUrl = state.mode === 'translated' ? state.translatedUrl : state.originalUrl;
    this.adapter.applyImage(target, imageUrl);
  }

}
