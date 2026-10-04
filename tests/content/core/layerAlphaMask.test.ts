import { describe, expect, it } from 'vitest';
import type { EditableRasterLayer } from '@shinobu/image-pipeline/editor';
import { hitsLayerAlpha } from '../../../apps/extension/src/content/core/editing/layerAlphaMask';

const mask = { width: 3, height: 3, alpha: Uint8Array.of(0, 0, 0, 0, 255, 0, 0, 0, 0) };
const layer: EditableRasterLayer = { id: 'text:x', regionId: 'x', image: new Blob(), width: 3, height: 3,
  transform: [1, 0, 0, 1, 20, 30], quad: [{ x: 20, y: 30 }, { x: 23, y: 30 }, { x: 23, y: 33 }, { x: 20, y: 33 }] };

describe('layer alpha hit testing', () => {
  it('passes through transparent pixels and rejects points outside a sprite', () => {
    expect(hitsLayerAlpha(mask, layer, 0, 0, 21.5, 31.5)).toBe(true);
    for (const [x, y] of [[20.5, 30.5], [22.5, 31.5], [19, 31], [25, 31]]) {
      expect(hitsLayerAlpha(mask, layer, 0, 0, x, y)).toBe(false);
    }
  });
  it('inverts rotation, nonuniform scale and movement in source pixels', () => {
    const rotated = { ...layer, transform: [0, 2, -3, 0, 20, 30] as EditableRasterLayer['transform'] };
    expect(hitsLayerAlpha(mask, rotated, 10, -5, 25.5, 28)).toBe(true);
    expect(hitsLayerAlpha(mask, rotated, 10, -5, 28.5, 26)).toBe(false);
    expect(hitsLayerAlpha(mask, { ...layer, transform: [0, 0, 0, 0, 0, 0] }, 0, 0, 1, 1)).toBe(false);
  });
  it('allows a small hit margin without turning the full sprite into a target', () => {
    expect(hitsLayerAlpha(mask, layer, 0, 0, 20.5, 31.5, 1)).toBe(true);
    expect(hitsLayerAlpha(mask, layer, 0, 0, 25, 31.5, 1)).toBe(false);
    // A reduced display scale must not cap the corresponding source-pixel tolerance at eight pixels.
    const alpha = new Uint8Array(40); alpha[20] = 255;
    expect(hitsLayerAlpha({ width: 40, height: 1, alpha }, { ...layer, width: 40, height: 1 }, 0, 0, 30.5, 30.5, 12)).toBe(true);
  });
});
