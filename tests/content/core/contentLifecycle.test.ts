import { describe, expect, it, vi } from 'vitest';
import { bindContentLifecycle } from '../../../apps/extension/src/content/core/contentLifecycle';

describe('content lifecycle', () => {
  it('ignores BFCache pagehide and stops once for a real document exit', () => {
    let pageHideListener: ((event: PageTransitionEvent) => void) | undefined;
    const target = {
      addEventListener: vi.fn((
        _type: 'pagehide',
        listener: (event: PageTransitionEvent) => void,
      ) => {
        pageHideListener = listener;
      }),
      removeEventListener: vi.fn(),
    };
    const core = { stop: vi.fn() };
    const port = { disconnect: vi.fn() };
    bindContentLifecycle(core, port, target);

    pageHideListener?.({ persisted: true } as PageTransitionEvent);
    expect(core.stop).not.toHaveBeenCalled();
    expect(port.disconnect).not.toHaveBeenCalled();

    pageHideListener?.({ persisted: false } as PageTransitionEvent);
    pageHideListener?.({ persisted: false } as PageTransitionEvent);
    expect(core.stop).toHaveBeenCalledOnce();
    expect(port.disconnect).toHaveBeenCalledOnce();
    expect(target.removeEventListener).toHaveBeenCalledOnce();
  });

  it('allows explicit lifecycle shutdown when no port exists', () => {
    const target = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const core = { stop: vi.fn() };
    const stop = bindContentLifecycle(core, null, target);

    expect(stop).not.toThrow();
    expect(stop).not.toThrow();
    expect(core.stop).toHaveBeenCalledOnce();
  });
});
