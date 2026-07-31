import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInitialPhotoState } from '../../../src/content/core/state/photoStateStore';
import {
  createUiElements,
  renderUi,
} from '../../../src/content/core/ui/imageControls';

class FakeElement {
  className = '';
  type = '';
  textContent = '';
  innerHTML = '';
  title = '';
  tabIndex = -1;
  disabled = false;
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  style: Record<string, string> & {
    setProperty(name: string, value: string): void;
  };

  constructor() {
    const values = Object.create(null) as Record<string, string>;
    this.style = Object.assign(values, {
      setProperty(name: string, value: string) {
        values[name] = value;
      },
    });
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }

  setAttribute(name: string, value: string): void {
    if (name.startsWith('data-')) {
      this.dataset[name.slice(5)] = value;
    }
  }

  getBoundingClientRect() {
    return {
      width: 100,
      height: 32,
      left: 0,
      right: 100,
      top: 0,
      bottom: 32,
    };
  }
}

describe('image controls', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders tweet-context notices on a second gray detail line', () => {
    vi.stubGlobal('document', {
      createElement: vi.fn(() => new FakeElement()),
      createElementNS: vi.fn(() => new FakeElement()),
    });
    const ui = createUiElements();
    const state = createInitialPhotoState('https://example.com/image.jpg');
    state.status = 'translated';
    state.mode = 'translated';
    state.elapsedText = '耗时 12.3 秒';
    state.contextNoticeText = '未找到推文作为上下文';

    renderUi(ui, state);

    expect(ui.detailLine.textContent).toBe('耗时 12.3 秒');
    expect(ui.contextNoticeLine.textContent).toBe('未找到推文作为上下文');
    expect(ui.contextNoticeLine.className).toContain('mt-x-detail');
  });
});
