import { beforeAll, describe, expect, it } from 'vitest';
import { createCanvas, loadImage } from 'canvas';
import type { PipelineCanvas, PlatformProvider } from '@shinobu/image-pipeline';
import { packEditableImage, unpackEditableImage, type EditableImage, type EditableTextLayer } from '@shinobu/image-pipeline/editor';
import { buildEraseLayerCanvases } from '../../packages/image-pipeline/src/editor/eraseLayers';
import { drawTypeset } from '../../packages/image-pipeline/src/pipeline/typeset/drawTypeset';
import type { TypesetLayerCanvas } from '../../packages/image-pipeline/src/editor/types';
import { refineTextMask } from '../../packages/image-pipeline/src/pipeline/maskRefinement';

const platform = {
  createCanvas: (width: number, height: number) => {
    const canvas = createCanvas(width, height), context = canvas.getContext('2d');
    const font = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(context), 'font')!;
    // node-canvas's Windows font parser cannot parse the browser's family list.
    Object.defineProperty(context, 'font', {
      get: () => font.get!.call(context),
      set: (value: string) => font.set!.call(context, `700 ${value.match(/[\d.]+px/u)?.[0] ?? '24px'} Arial`),
    });
    return canvas;
  },
  createImageData: (w: number, h: number) => createCanvas(w, h).getContext('2d').createImageData(w, h),
  waitForFonts: async () => {},
} as unknown as PlatformProvider;

describe('editable image artifacts', () => {
  // Windows native canvas can spend several seconds initializing its first context.
  beforeAll(() => { createCanvas(1, 1).getContext('2d'); }, 60000);
  it('round-trips binary raster and bubble constraints through one transferable artifact', async () => {
    const image: EditableImage = { width: 100, height: 200, targetLang: 'zh-CHT', layers: [{
      id: 'text:one', regionId: 'one', kind: 'text', width: 10, height: 20,
      image: new Blob([Uint8Array.of(1, 2, 3)], { type: 'image/png' }),
      transform: [1, 0, 0, 1, 5, 6], quad: [{ x: 5, y: 6 }, { x: 15, y: 6 }, { x: 15, y: 26 }, { x: 5, y: 26 }],
      region: { id: 'one', box: { x: 5, y: 6, width: 10, height: 20 }, sourceText: '日文', translatedText: '中文',
        bubbleMask: { x: 0, y: 0, width: 2, height: 2, data: Uint8Array.of(1, 0, 1, 1) } },
      layout: { fontSize: 18, fontFamily: 'Test Font', color: '#234567', direction: 'v',
        glyphs: [{ start: 0, end: 1, x: 5, y: 7, width: 18, height: 18, baselineY: 14 }] },
    }] };
    const restored = await unpackEditableImage(packEditableImage(image));
    expect(restored.width).toBe(100);
    const layer = restored.layers[0] as EditableTextLayer;
    expect([...new Uint8Array(await layer.image.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(layer.region.bubbleMask?.data).toEqual(Uint8Array.of(1, 0, 1, 1));
    expect(layer.transform).toEqual(image.layers[0].transform);
    expect(layer.layout).toEqual((image.layers[0] as EditableTextLayer).layout);
    await expect(unpackEditableImage(packEditableImage(image).slice(0, 8))).rejects.toThrow();
    await expect(unpackEditableImage(new Blob(['bad']))).rejects.toThrow();
  }, 15000);

  it('partitions repair pixels without covering adjacent source pixels', () => {
    const cleaned = createCanvas(8, 4), mask = createCanvas(8, 4), original = createCanvas(8, 4);
    original.getContext('2d').fillStyle = 'red'; original.getContext('2d').fillRect(0, 0, 8, 4);
    cleaned.getContext('2d').drawImage(original, 0, 0);
    cleaned.getContext('2d').fillStyle = 'white'; cleaned.getContext('2d').fillRect(1, 1, 6, 2);
    mask.getContext('2d').fillStyle = 'white'; mask.getContext('2d').fillRect(1, 1, 6, 2);
    const labels = new Int32Array(32);
    for (let y = 1; y < 3; y++) for (let x = 1; x < 7; x++) labels[y * 8 + x] = x < 4 ? 1 : 2;
    const layers = buildEraseLayerCanvases(cleaned, mask, { width: 8, height: 4, regionIds: ['a', 'b'], labels }, platform);
    const result = createCanvas(8, 4), context = result.getContext('2d'); context.drawImage(original, 0, 0);
    for (const layer of layers) context.drawImage(layer.canvas as ReturnType<typeof createCanvas>, layer.bounds.x, layer.bounds.y);
    expect(context.getImageData(0, 0, 8, 4).data).toEqual(cleaned.getContext('2d').getImageData(0, 0, 8, 4).data);
    context.drawImage(original, 0, 0);
    context.drawImage(layers[1].canvas as ReturnType<typeof createCanvas>, layers[1].bounds.x, layers[1].bounds.y);
    expect([...context.getImageData(2, 1, 1, 1).data]).toEqual([255, 0, 0, 255]);
    expect([...context.getImageData(5, 1, 1, 1).data]).toEqual([255, 255, 255, 255]);
  }, 15000);

  it('collects ownership through mask refinement and the global dilation', () => {
    const source = createCanvas(100, 60), raw = createCanvas(100, 60);
    const context = source.getContext('2d'); context.fillStyle = 'white'; context.fillRect(0, 0, 100, 60);
    context.fillStyle = 'black'; context.fillRect(12, 14, 10, 18); context.fillRect(65, 14, 10, 18);
    raw.getContext('2d').fillStyle = 'white'; raw.getContext('2d').fillRect(12, 14, 10, 18); raw.getContext('2d').fillRect(65, 14, 10, 18);
    const regions = [12, 65].map((x, index) => ({ id: String(index), box: { x: x - 2, y: 12, width: 14, height: 22 }, sourceText: '文', translatedText: '' }));
    const refined = refineTextMask(source, regions, raw, platform, {}, false, undefined, true);
    const ordinary = refineTextMask(source, regions, raw, platform);
    expect(ordinary.regionOwnership).toBeUndefined();
    expect(refined.refinedMaskCanvas.getContext('2d')!.getImageData(0, 0, 100, 60).data)
      .toEqual(ordinary.refinedMaskCanvas.getContext('2d')!.getImageData(0, 0, 100, 60).data);
    expect(refined.regionOwnership?.regionIds).toEqual(['0', '1']);
    const repaired = createCanvas(100, 60); repaired.getContext('2d').drawImage(source, 0, 0);
    const pixels = repaired.getContext('2d').getImageData(0, 0, 100, 60);
    const mask = refined.refinedMaskCanvas.getContext('2d')!.getImageData(0, 0, 100, 60).data;
    for (let p = 0; p < mask.length; p += 4) if (mask[p] > 127) pixels.data.fill(255, p, p + 4);
    repaired.getContext('2d').putImageData(pixels, 0, 0);
    const layers = buildEraseLayerCanvases(repaired, refined.refinedMaskCanvas, refined.regionOwnership!, platform);
    expect(layers.map((layer) => layer.regionId)).toEqual(['0', '1']);
  });

  it('retains source offsets across normalized whitespace and the actual horizontal baseline', async () => {
    const layers: TypesetLayerCanvas[] = [];
    await drawTypeset(createCanvas(240, 160), [{
      id: 'spaced', box: { x: 20, y: 20, width: 200, height: 100 }, direction: 'h', fontSize: 24,
      sourceText: 'W W\n下', translatedText: 'W W\n下',
    }], 'zh-CN', { onTextLayer: (layer) => layers.push(layer) }, platform);
    const { glyphs } = layers[0].layout!;
    expect(glyphs.map((glyph) => layers[0].region.translatedText.slice(glyph.start, glyph.end)).join('')).toBe('WW下');
    expect(glyphs.map((glyph) => glyph.start)).toEqual([0, 2, 4]);
    expect(glyphs[0].baselineY).toBe(glyphs[1].baselineY);
    expect(glyphs[2].baselineY).toBeGreaterThan(glyphs[0].baselineY!);
  });

  it.each(['h', 'v', 'rotated', 'original'] as const)('preserves %s text pixels when rebuilding collected layers', async (direction) => {
    const source = createCanvas(300, 300), context = source.getContext('2d');
    context.fillStyle = 'white'; context.fillRect(0, 0, 300, 300);
    const layers: TypesetLayerCanvas[] = [];
    const result = await drawTypeset(source, [{
      id: 'text', direction: direction === 'h' ? 'h' : 'v', box: { x: 80, y: 50, width: 100, height: 170 },
      sourceText: '原文', translatedText: direction === 'original' ? '' : '测试文字', fontSize: 24,
      ...(direction === 'rotated' ? { quad: [{ x: 80, y: 50 }, { x: 178, y: 70 }, { x: 145, y: 235 }, { x: 47, y: 215 }] as EditableTextLayer['quad'] } : {}),
    }], 'zh-CN', { onTextLayer: (layer) => layers.push(layer) }, platform);
    expect(layers).toHaveLength(1);
    expect(layers[0].region.translatedText).toBe(direction === 'original' ? '原文' : '测试文字');
    expect(layers[0].layout?.direction).toBe(direction === 'h' ? 'h' : 'v');
    expect(layers[0].layout?.glyphs.map((glyph) => layers[0].region.translatedText.slice(glyph.start, glyph.end)).join(''))
      .toBe(layers[0].region.translatedText);
    expect(result.canvas.getContext('2d')!.getImageData(0, 0, 300, 300).data.some((value, index) => index % 4 !== 3 && value < 250)).toBe(true);
    const rebuilt = createCanvas(300, 300), c = rebuilt.getContext('2d'); c.drawImage(source, 0, 0);
    for (const layer of layers) {
      c.setTransform(...layer.transform); c.drawImage(layer.canvas as ReturnType<typeof createCanvas>, 0, 0);
    }
    expect(c.getImageData(0, 0, 300, 300).data).toEqual(result.canvas.getContext('2d')!.getImageData(0, 0, 300, 300).data);
    // Export/decode the transparent raster, as the browser client does.
    const png = (layers[0].canvas as ReturnType<typeof createCanvas>).toBuffer('image/png');
    expect((await loadImage(png)).width).toBe(layers[0].canvas.width);
    (result.canvas as PipelineCanvas).width = 0;
  });
});
