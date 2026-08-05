import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReadingModeBarUi } from '../../../apps/extension/src/content/core/ui/readingModeBar';

class FakeElement {
  className = '';
  type = '';
  textContent = '';
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }

  setAttribute(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading mode bar', () => {
  it('places the shared error detail line below the action buttons', () => {
    vi.stubGlobal('document', {
      createElement: vi.fn(() => new FakeElement()),
      createElementNS: vi.fn(() => new FakeElement()),
    });

    const ui = createReadingModeBarUi();
    const host = ui.host as unknown as FakeElement;
    const actions = host.children[0];

    expect(actions.className).toBe('mt-x-reading-actions');
    expect(actions.children).toEqual([
      ui.translateCurrentBtn,
      ui.translateAllBtn,
    ]);
    expect(host.children[1]).toBe(ui.errorLine);
    expect(ui.errorLine.className).toBe('mt-x-detail');
  });
});
