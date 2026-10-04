import { describe, expect, it } from 'vitest';
import { LayerEditingState } from '../../../apps/extension/src/content/core/editing/layerEditingState';
import type { EditableImage, EditableTextLayer } from '@shinobu/image-pipeline/editor';

function image(): EditableImage {
  const base = {
    regionId: 'r1', image: new Blob(['png'], { type: 'image/png' }), width: 40, height: 60,
    transform: [1, 0, 0, 1, 20, 30] as [number, number, number, number, number, number],
    quad: [{ x: 20, y: 30 }, { x: 60, y: 30 }, { x: 60, y: 90 }, { x: 20, y: 90 }] as EditableTextLayer['quad'],
  };
  return { width: 300, height: 300, targetLang: 'zh-CN', layers: [
    { ...base, id: 'erase:r1', kind: 'erase' },
    { ...base, id: 'text:r1', kind: 'text', region: {
      id: 'r1', box: { x: 20, y: 30, width: 40, height: 60 }, direction: 'v',
      sourceText: '原文', translatedText: '译文', translatedColumns: ['旧', '分栏'],
    } },
  ] };
}

describe('photo layer editing state', () => {
  it('selects by stacking order or type and deletes layers independently', () => {
    const state = new LayerEditingState(image(), new Blob());
    expect(state.hitTest(40, 50).map((layer) => layer.content.kind)).toEqual(['text', 'erase']);
    expect(state.hitTest(40, 50, 'erase')).toEqual([state.layers[0]]);
    state.remove(state.layers[1]);
    expect(state.hitTest(40, 50)).toEqual([state.layers[0]]);
    expect(state.layers[0].deleted).toBe(false);
    state.remove(state.layers[0]);
    expect(state.hitTest(40, 50)).toEqual([]);
  });

  it('moves only text and uses its transformed hit area', () => {
    const state = new LayerEditingState(image(), new Blob());
    state.move(state.layers[0], 100, 100);
    expect(state.layers[0].offsetX).toBe(0);
    state.move(state.layers[1], 100, 100);
    expect(state.hitTest(140, 150)).toEqual([state.layers[1]]);
    expect(state.hitTest(40, 50, 'text')).toEqual([]);
    state.move(state.layers[1], 500, 500);
    expect(state.layers[1].offsetX).toBe(240);
    expect(state.layers[1].offsetY).toBe(210);
  });

  it('clears model column hints and applies only the newest rendered text', async () => {
    const state = new LayerEditingState(image(), new Blob());
    const layer = state.layers[1];
    const callbacks: Array<(value: EditableTextLayer) => void> = [];
    const regions: EditableTextLayer['region'][] = [];
    const render = (region: EditableTextLayer['region']) => {
      regions.push(region);
      return new Promise<EditableTextLayer>((resolve) => callbacks.push(resolve));
    };
    const a = state.editText(layer, '第一版', render), b = state.editText(layer, '第二版\n换行', render);
    expect(regions[1].translatedColumns).toBeUndefined();
    expect(regions[1].direction).toBe('v');
    const textLayer = layer.content as EditableTextLayer;
    callbacks[1]({ ...textLayer, region: regions[1] }); await b;
    callbacks[0]({ ...textLayer, region: regions[0] }); await a;
    expect((layer.content as EditableTextLayer).region.translatedText).toBe('第二版\n换行');
    expect(state.revision).toBe(1);
  });

  it('preserves a usable layer on failure and ignores results after deletion or disposal', async () => {
    const state = new LayerEditingState(image(), new Blob());
    const layer = state.layers[1], original = layer.content as EditableTextLayer;
    await expect(state.editText(layer, '新文字', async () => { throw new Error('font failed'); })).rejects.toThrow('font failed');
    expect(layer.content).toBe(original);
    let complete!: (value: EditableTextLayer) => void;
    const pending = state.editText(layer, '新文字', () => new Promise((resolve) => { complete = resolve; }));
    state.remove(layer); state.dispose(); complete({ ...original, region: { ...original.region, translatedText: '新文字' } });
    await pending;
    expect(layer.deleted).toBe(true);
    expect(layer.content).toBe(original);
  });

  it('cancels an earlier render when the user restores the current text', async () => {
    const state = new LayerEditingState(image(), new Blob()), layer = state.layers[1];
    const original = layer.content as EditableTextLayer;
    let complete!: (value: EditableTextLayer) => void;
    const pending = state.editText(layer, '临时文字', () => new Promise((resolve) => { complete = resolve; }));
    await state.editText(layer, '译文', async () => { throw new Error('should not render'); });
    complete({ ...original, region: { ...original.region, translatedText: '临时文字' } }); await pending;
    expect(layer.content).toBe(original);
  });
});
