import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ImageTarget,
  ReadingModeBarUi,
  SiteAdapter,
} from '../../../apps/extension/src/content/core/types';
import { ReadingModeController } from '../../../apps/extension/src/content/core/reading/readingModeController';
import { PhotoStateStore } from '../../../apps/extension/src/content/core/state/photoStateStore';
import {
  createImageTranslationExecutionModule,
  type ImageTranslationExecutionModule,
} from '../../../apps/extension/src/content/core/translation/imageTranslationExecution';
import { createImageTranslationExecutionArbiter } from '../../../apps/extension/src/content/core/translation/imageTranslationExecutionArbiter';
import { prepareExecutionFromSettings } from './executionPreparation';

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

function arbitrate(execution: ImageTranslationExecutionModule) {
  return createImageTranslationExecutionArbiter(execution);
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
      arbitrate(createImageTranslationExecutionModule({
        prepareExecution: prepareExecutionFromSettings(),
      })),
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
    const downloadImage = vi.fn(async () => {
      throw new Error('stop after request capture');
    });
    const executionModule = createImageTranslationExecutionModule({
      prepareExecution: prepareExecutionFromSettings(),
      downloadImage,
    });
    const bar = createFakeBar();
    const controller = new ReadingModeController(
      adapter,
      new PhotoStateStore(200, { revokeObjectURL: vi.fn() }),
      arbitrate(executionModule),
      vi.fn(),
      vi.fn(),
      () => bar.ui,
    );

    controller.sync();
    bar.current.click?.();

    await vi.waitFor(() => {
      expect(downloadImage).toHaveBeenCalledWith(
        {
          kind: 'remote-image',
          url: target.originalUrl,
          referrerPolicy: 'same-origin',
        },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  it('stops admitting pages after a runtime-scoped pipeline failure', async () => {
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
    });
    vi.stubGlobal('window', {
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
    });
    const pages = [
      { key: 'page-1', originalUrl: 'https://cdn.example/page-1.jpg', pageIndex: 0 },
      { key: 'page-2', originalUrl: 'https://cdn.example/page-2.jpg', pageIndex: 1 },
    ];
    const adapter: SiteAdapter = {
      match: () => true,
      findImages: () => [],
      createUiAnchor: () => ({} as HTMLElement),
      applyImage: () => {},
      observe: () => () => {},
      createBottomBarAnchor: () => ({ appendChild: vi.fn() } as unknown as HTMLElement),
      findAllPageUrls: () => pages,
      getVisiblePages: () => [],
      applyImageByKey: vi.fn(),
    };
    const source = new Blob(['source'], { type: 'image/png' });
    const downloadImage = vi.fn(async () => ({
      blob: source,
      file: new File([source], 'source.png', { type: source.type }),
    }));
    const runLocalPipeline = vi.fn(async () => {
      throw Object.assign(new Error('pipeline host unavailable'), {
        code: 'PIPELINE_HOST_UNAVAILABLE',
      });
    });
    const bar = createFakeBar();
    const controller = new ReadingModeController(
      adapter,
      new PhotoStateStore(200, { revokeObjectURL: vi.fn() }),
      arbitrate(createImageTranslationExecutionModule({
        prepareExecution: prepareExecutionFromSettings(),
        downloadImage,
        runLocalPipeline,
      })),
      vi.fn(),
      vi.fn(),
      () => bar.ui,
    );

    controller.sync();
    bar.all.click?.();

    await vi.waitFor(() => expect(runLocalPipeline).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();
    expect(downloadImage).toHaveBeenCalledOnce();
    expect(bar.all.disabled).toBe(false);
  });

  it('stops the page loop when another explicit owner replaces the reading activity', async () => {
    vi.stubGlobal('document', {
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
    });
    vi.stubGlobal('window', {
      requestAnimationFrame: vi.fn(() => 1),
      cancelAnimationFrame: vi.fn(),
    });
    const pages = [
      { key: 'page-1', originalUrl: 'https://cdn.example/page-1.jpg', pageIndex: 0 },
      { key: 'page-2', originalUrl: 'https://cdn.example/page-2.jpg', pageIndex: 1 },
    ];
    const adapter: SiteAdapter = {
      match: () => true,
      findImages: () => [],
      createUiAnchor: () => ({} as HTMLElement),
      applyImage: () => {},
      observe: () => () => {},
      createBottomBarAnchor: () => ({ appendChild: vi.fn() } as unknown as HTMLElement),
      findAllPageUrls: () => pages,
      getVisiblePages: () => [],
      applyImageByKey: vi.fn(),
    };
    const source = new Blob(['source'], { type: 'image/png' });
    const downloadImage = vi.fn(async () => ({
      blob: source,
      file: new File([source], 'source.png', { type: source.type }),
    }));
    let pipelineSignal: AbortSignal | undefined;
    const executionModule = createImageTranslationExecutionModule({
      prepareExecution: prepareExecutionFromSettings(),
      downloadImage,
      runLocalPipeline: (_file, _config, _onProgress, options) => {
        pipelineSignal = options?.signal;
        return new Promise(() => undefined);
      },
    });
    const executionArbiter = arbitrate(executionModule);
    const bar = createFakeBar();
    const controller = new ReadingModeController(
      adapter,
      new PhotoStateStore(200, { revokeObjectURL: vi.fn() }),
      executionArbiter,
      vi.fn(),
      vi.fn(),
      () => bar.ui,
    );

    controller.sync();
    bar.all.click?.();
    await vi.waitFor(() => expect(pipelineSignal).toBeDefined());

    const replacement = executionArbiter.begin({
      owner: 'screenshot',
      origin: 'explicit',
    });
    expect(replacement.status).toBe('active');
    await vi.waitFor(() => expect(bar.all.disabled).toBe(false));

    expect(pipelineSignal?.aborted).toBe(true);
    expect(downloadImage).toHaveBeenCalledOnce();
    if (replacement.status === 'active') replacement.activity.end();
  });
});
