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
import { createImageTranslationExecutionModule } from './translation/imageTranslationExecution';
import { createImageTranslationExecutionArbiter } from './translation/imageTranslationExecutionArbiter';
import { ImageTranslationController } from './translation/imageTranslationController';
import { PhotoStateStore } from './state/photoStateStore';
import { ReadingModeController } from './reading/readingModeController';
import { CardStateController } from './ui/cardState';
import { ScreenshotController } from './screenshot/screenshotController';
import { createDefaultReaderEngineReadingModeModule } from './reading/defaultReaderEngineReadingModeModule';
import type { ReaderEngineReadingModeModulePort } from './reading/readerEngineReadingModeModule';
import { createSiteReadingModeAdapter } from './reading/siteReadingModeAdapter';

type MountedImage = {
  key: string;
  target: ImageTarget;
  ui: UiElements;
};

export class TranslatorCore {
  private adapter: SiteAdapter;
  private readonly stateStore = new PhotoStateStore();
  private readonly imageTranslationExecution = createImageTranslationExecutionModule();
  private readonly imageTranslationExecutionArbiter = createImageTranslationExecutionArbiter(
    this.imageTranslationExecution,
  );
  private readonly cardStateController = new CardStateController();
  private readonly screenshotController = new ScreenshotController(
    this.stateStore,
    this.imageTranslationExecutionArbiter,
    this.cardStateController,
  );
  private readonly imageTranslationController: ImageTranslationController;
  private readonly readingModeController: ReadingModeController;
  private readonly readerEngineReadingModeModule: ReaderEngineReadingModeModulePort | null;
  private mounted = new Map<string, MountedImage>();
  private disposeObserver: (() => void) | null = null;
  private syncTimer: number | null = null;
  private stopped = false;

  constructor(adapter: SiteAdapter, contentSessionId?: string) {
    this.adapter = adapter;
    this.imageTranslationController = new ImageTranslationController(
      this.stateStore,
      this.imageTranslationExecutionArbiter,
      {
        resolveTarget: (key) => this.mounted.get(key)?.target,
        resolveTranslationContext: (target) => this.adapter.getTranslationContext?.(target) ?? {
          status: 'empty',
        },
        applyImage: (target, state) => this.applyMountedStateImage(target.key, state),
        render: (key) => this.renderForKey(key),
      },
    );
    this.readingModeController = new ReadingModeController(
      createSiteReadingModeAdapter(adapter),
      this.stateStore,
      this.imageTranslationExecutionArbiter,
      () => this.scheduleSync(),
      () => this.cancelScheduledSync(),
    );
    this.readerEngineReadingModeModule = contentSessionId
      ? createDefaultReaderEngineReadingModeModule(
          this.stateStore,
          this.imageTranslationExecutionArbiter,
        )
      : null;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.disposeObserver) {
      this.disposeObserver();
      this.disposeObserver = null;
    }
    if (this.syncTimer !== null) {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.readingModeController.teardown();
    this.readerEngineReadingModeModule?.dispose();
    this.screenshotController.dispose();
    this.imageTranslationController.dispose();
    this.imageTranslationExecutionArbiter.dispose('翻译核心已停止');
    this.stateStore.dispose();
  }

  start(): void {
    if (this.stopped) return;
    injectStyles();
    this.readerEngineReadingModeModule?.start();
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

    // Reading DOM can disappear during SPA transitions. Detach its UI without
    // cancelling already-submitted work; stop() owns final cancellation.
    this.readingModeController.suspend();

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
    if (!mounted?.ui.host.isConnected) return;
    const state = this.stateStore.get(key) ?? null;
    renderUi(mounted.ui, state);
  }

  private applyMountedStateImage(key: string, state: PhotoState): void {
    const mounted = this.mounted.get(key);
    if (!mounted?.ui.host.isConnected) return;
    this.applyStateImage(mounted.target, state);
  }

  private applyStateImage(target: ImageTarget, state: PhotoState): void {
    if (!state.translatedUrl) return;
    const imageUrl = state.mode === 'translated' ? state.translatedUrl : state.originalUrl;
    this.adapter.applyImage(target, imageUrl);
  }

}
