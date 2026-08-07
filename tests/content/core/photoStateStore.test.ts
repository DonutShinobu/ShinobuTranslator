import { describe, expect, it, vi } from 'vitest';
import { PhotoStateStore } from '../../../apps/extension/src/content/core/state/photoStateStore';

describe('PhotoStateStore', () => {
  it('reuses state for the same key and keeps the original state identity', () => {
    const store = new PhotoStateStore();
    const first = store.ensure('image-1', 'https://example.com/one.jpg');
    const second = store.ensure('image-1', 'https://example.com/changed.jpg');

    expect(second).toBe(first);
    expect(second.originalUrl).toBe('https://example.com/one.jpg');
  });

  it('evicts the oldest state and revokes every owned object URL', () => {
    const revokeObjectURL = vi.fn();
    const store = new PhotoStateStore(2, { revokeObjectURL });
    const oldest = store.ensure('image-1', 'https://example.com/one.jpg');
    oldest.translatedUrl = 'blob:translated-1';
    oldest.debugOriginalUrl = 'blob:debug-1';
    store.ensure('image-2', 'https://example.com/two.jpg');

    store.ensure('image-3', 'https://example.com/three.jpg');

    expect(store.get('image-1')).toBeUndefined();
    expect(revokeObjectURL.mock.calls).toEqual([
      ['blob:translated-1'],
      ['blob:debug-1'],
    ]);
  });

  it('releases URLs exactly once when deleting and disposing states', () => {
    const revokeObjectURL = vi.fn();
    const store = new PhotoStateStore(200, { revokeObjectURL });
    const first = store.ensure('image-1', 'https://example.com/one.jpg');
    first.translatedUrl = 'blob:translated-1';
    const second = store.ensure('image-2', 'https://example.com/two.jpg');
    second.debugOriginalUrl = 'blob:debug-2';

    store.delete('image-1');
    store.delete('image-1');
    store.dispose();

    expect(revokeObjectURL.mock.calls).toEqual([
      ['blob:translated-1'],
      ['blob:debug-2'],
    ]);
    expect(store.get('image-2')).toBeUndefined();
  });

  it('does not evict protected active states until they are released', () => {
    const revokeObjectURL = vi.fn();
    const store = new PhotoStateStore(2, { revokeObjectURL });
    const active = store.ensure('active', 'https://example.com/active.jpg');
    active.translatedUrl = 'blob:active';
    const release = store.protect('active');
    store.ensure('image-2', 'https://example.com/two.jpg');

    store.ensure('image-3', 'https://example.com/three.jpg');

    expect(store.get('active')).toBe(active);
    expect(store.get('image-2')).toBeUndefined();
    expect(revokeObjectURL).not.toHaveBeenCalledWith('blob:active');

    release();
    store.ensure('image-4', 'https://example.com/four.jpg');

    expect(store.get('active')).toBeUndefined();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:active');
  });
});
