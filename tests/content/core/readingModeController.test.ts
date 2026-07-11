import { describe, expect, it, vi } from 'vitest';
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
});
