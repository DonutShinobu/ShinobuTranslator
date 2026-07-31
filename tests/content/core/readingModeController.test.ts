import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultExtensionSettings } from '../../../src/shared/config';
import type {
  ImageTarget,
  ReadingModeBarUi,
  SiteAdapter,
} from '../../../src/content/core/types';
import { ReadingModeController } from '../../../src/content/core/reading/readingModeController';
import { PhotoStateStore } from '../../../src/content/core/state/photoStateStore';
import { TranslationRunner } from '../../../src/content/core/translation/translationRunner';

type FakeButton = {
  style: { display: string };
  dataset: Record<string, string>;
  disabled: boolean;
  label: { textContent: string };
  click?: () => void;
  addEventListener(type: string, listener: () => void): void;
  querySelector(selector: string): { textContent: string } | null;
};

function createFakeButton(labelText: string): FakeButton {
  const button: FakeButton = {
    style: { display: '' },
    dataset: {},
    disabled: false,
    label: { textContent: labelText },
    addEventListener(type, listener) {
      if (type === 'click') button.click = listener;
    },
    querySelector(selector) {
      return selector === '.mt-x-label' ? button.label : null;
    },
  };
  return button;
}

function createFakeBar(): { ui: ReadingModeBarUi; current: FakeButton; all: FakeButton; remove: ReturnType<typeof vi.fn> } {
  const current = createFakeButton('翻译当前页');
  const all = createFakeButton('翻译全部');
  const remove = vi.fn();
  const host = { isConnected: true, remove };
  return {
    ui: {
      host: host as unknown as HTMLElement,
      translateCurrentBtn: current as unknown as HTMLButtonElement,
      translateAllBtn: all as unknown as HTMLButtonElement,
    },
    current,
    all,
    remove,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ReadingModeController', () => {
  it('reuses stored translations, toggles visible pages, and tears down its bar', async () => {
    const target: ImageTarget = {
      element: {} as HTMLImageElement,
      key: 'page-1',
      originalUrl: 'https://example.com/page-1.jpg',
    };
    const applyImageByKey = vi.fn();
    const anchor = { appendChild: vi.fn() };
    const adapter: SiteAdapter = {
      match: () => true,
      findImages: () => [],
      createUiAnchor: () => ({} as HTMLElement),
      applyImage: () => {},
      observe: () => () => {},
      createBottomBarAnchor: () => anchor as unknown as HTMLElement,
      findAllPageUrls: () => [{ key: target.key, originalUrl: target.originalUrl, pageIndex: 0 }],
      getVisiblePages: () => [target],
      applyImageByKey,
    };
    const store = new PhotoStateStore(200, { revokeObjectURL: vi.fn() });
    const state = store.ensure(target.key, target.originalUrl);
    state.translatedUrl = 'blob:translated-page-1';
    state.status = 'translated';
    state.mode = 'translated';
    const bar = createFakeBar();
    const controller = new ReadingModeController(
      adapter,
      store,
      new TranslationRunner(),
      vi.fn(),
      vi.fn(),
      () => bar.ui,
    );

    controller.sync();
    expect(anchor.appendChild).toHaveBeenCalledWith(bar.ui.host);
    expect(applyImageByKey).toHaveBeenLastCalledWith(target.key, target.originalUrl);
    expect(bar.current.label.textContent).toBe('显示译图');

    bar.current.click?.();
    await Promise.resolve();
    expect(applyImageByKey).toHaveBeenLastCalledWith(target.key, 'blob:translated-page-1');
    expect(bar.current.label.textContent).toBe('显示原图');

    controller.teardown();
    expect(bar.remove).toHaveBeenCalledOnce();
  });

  it('passes the document meta referrer policy when downloading a reading-mode page', async () => {
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => ({ content: 'origin' })),
      querySelectorAll: vi.fn(() => [
        { content: 'origin' },
        { content: 'same-origin' },
      ]),
    });
    vi.stubGlobal('window', {
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
    });
    const target: ImageTarget = {
      element: {} as HTMLImageElement,
      key: 'page-1',
      originalUrl: 'https://cdn.example/page-1.jpg',
    };
    const anchor = { appendChild: vi.fn() };
    const adapter: SiteAdapter = {
      match: () => true,
      findImages: () => [],
      createUiAnchor: () => ({} as HTMLElement),
      applyImage: () => {},
      observe: () => () => {},
      createBottomBarAnchor: () => anchor as unknown as HTMLElement,
      findAllPageUrls: () => [{ key: target.key, originalUrl: target.originalUrl, pageIndex: 0 }],
      getVisiblePages: () => [target],
      applyImageByKey: vi.fn(),
    };
    const runner = new TranslationRunner();
    vi.spyOn(runner, 'loadPipelineRunSettings').mockResolvedValue({
      settings: defaultExtensionSettings,
      showElapsedTime: false,
      showStageTimingDetails: false,
      showRuntimeStages: false,
      stageTimingCardExpanded: false,
      showTypesetDebug: false,
      enableDebugLog: false,
    });
    const downloadImageFile = vi.spyOn(runner, 'downloadImageFile')
      .mockRejectedValue(new Error('stop after request capture'));
    const bar = createFakeBar();
    const controller = new ReadingModeController(
      adapter,
      new PhotoStateStore(200, { revokeObjectURL: vi.fn() }),
      runner,
      vi.fn(),
      vi.fn(),
      () => bar.ui,
    );

    controller.sync();
    bar.current.click?.();

    await vi.waitFor(() => {
      expect(downloadImageFile).toHaveBeenCalledWith({
        originalUrl: target.originalUrl,
        referrerPolicy: 'same-origin',
        diagnosticRunId: undefined,
      });
    });
  });

  it('keeps the translate-all queue in the content owner after a host disconnect', async () => {
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
    });
    vi.stubGlobal('window', {
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
    });
    const pages = [
      {
        key: 'page-1',
        originalUrl: 'https://cdn.example/page-1.jpg',
        pageIndex: 0,
      },
      {
        key: 'page-2',
        originalUrl: 'https://cdn.example/page-2.jpg',
        pageIndex: 1,
      },
    ];
    const applyImageByKey = vi.fn();
    const adapter: SiteAdapter = {
      match: () => true,
      findImages: () => [],
      createUiAnchor: () => ({} as HTMLElement),
      applyImage: () => {},
      observe: () => () => {},
      createBottomBarAnchor: () => (
        { appendChild: vi.fn() } as unknown as HTMLElement
      ),
      findAllPageUrls: () => pages,
      getVisiblePages: () => [],
      applyImageByKey,
    };
    const store = new PhotoStateStore(200, { revokeObjectURL: vi.fn() });
    const runner = new TranslationRunner();
    vi.spyOn(runner, 'loadPipelineRunSettings').mockResolvedValue({
      settings: defaultExtensionSettings,
      showElapsedTime: false,
      showStageTimingDetails: false,
      showRuntimeStages: false,
      stageTimingCardExpanded: false,
      showTypesetDebug: false,
      enableDebugLog: false,
    });
    let rejectDisconnectedHost: ((error: Error) => void) | undefined;
    const disconnectedDownload = new Promise<never>((_, reject) => {
      rejectDisconnectedHost = reject;
    });
    const downloadImageFile = vi.spyOn(runner, 'downloadImageFile')
      .mockImplementationOnce(() => disconnectedDownload)
      .mockResolvedValue({
        file: {} as File,
        blob: {} as Blob,
      });
    const runPipelineFromFile = vi.spyOn(runner, 'runPipelineFromFile')
      .mockImplementation(async ({ state }) => {
        state.translatedUrl = `blob:translated-${state.originalUrl}`;
        state.status = 'translated';
        state.mode = 'translated';
        return undefined as never;
      });
    const scheduleCoreSync = vi.fn();
    const bar = createFakeBar();
    const controller = new ReadingModeController(
      adapter,
      store,
      runner,
      scheduleCoreSync,
      vi.fn(),
      () => bar.ui,
    );

    controller.sync();
    bar.all.click?.();
    await vi.waitFor(() => {
      expect(downloadImageFile).toHaveBeenCalledTimes(1);
    });
    expect(bar.all.dataset.status).toBe('running');

    rejectDisconnectedHost?.(new Error('Firefox Event Page disconnected'));

    await vi.waitFor(() => {
      expect(downloadImageFile).toHaveBeenCalledTimes(2);
      expect(runPipelineFromFile).toHaveBeenCalledOnce();
      expect(bar.all.dataset.status).toBe('');
    });
    expect(store.get(pages[0].key)).toMatchObject({
      errorText: 'Firefox Event Page disconnected',
      status: 'error',
    });
    expect(store.get(pages[1].key)).toMatchObject({
      mode: 'translated',
      status: 'translated',
      translatedUrl: `blob:translated-${pages[1].originalUrl}`,
    });
    expect(applyImageByKey).toHaveBeenCalledWith(
      pages[1].key,
      `blob:translated-${pages[1].originalUrl}`,
    );
    expect(scheduleCoreSync).toHaveBeenCalledTimes(2);
  });
});
