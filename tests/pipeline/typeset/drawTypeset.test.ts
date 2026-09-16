import { describe, expect, it } from 'vitest';
import { drawTypeset } from '../../../packages/image-pipeline/src/pipeline/typeset';
import { computeFullHorizontalTypeset } from '../../../packages/image-pipeline/src/pipeline/typeset/horizontalLayout';
import type {
  PipelineCanvas,
  PipelineRenderingContext,
  PlatformProvider,
} from '../../../packages/image-pipeline/src/runtime/platform';
import type { TextRegion } from '../../../packages/image-pipeline/src/types';
import { prepareReadableRegion, resolveMinimumReadableFontSize } from '../../../packages/image-pipeline/src/pipeline/typeset/readability';
import { computeReadableHorizontalTypeset, computeReadableVerticalTypeset } from '../../../packages/image-pipeline/src/pipeline/typeset/readableLayout';

function parseCanvasFontSize(font: string, fallback: number): number {
  return Number.parseFloat(font.match(/([\d.]+)px/u)?.[1] ?? '') || fallback;
}

function createMeasureContext(): PipelineRenderingContext {
  const context = {
    font: '16px sans-serif',
    drawImage: () => {},
    measureText(text: string) {
      const fontSize = parseCanvasFontSize(context.font, 16);
      const width = [...text].length * fontSize * 0.6;
      return {
        width,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
        actualBoundingBoxAscent: fontSize * 0.8,
        actualBoundingBoxDescent: fontSize * 0.2,
      };
    },
  };
  return context as unknown as PipelineRenderingContext;
}

function createCanvas(width: number, height: number): PipelineCanvas {
  const context = createMeasureContext();
  return {
    width,
    height,
    getContext: () => context,
    toDataURL: () => 'data:image/png;base64,test',
  };
}

const platform: PlatformProvider = {
  createCanvas,
  createImage: () => {
    throw new Error('createImage is not used by typeset tests');
  },
  loadImage: async () => {
    throw new Error('loadImage is not used by typeset tests');
  },
  createImageData: (width, height) => ({
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  }),
  registerFont: () => {},
  waitForFonts: async () => {},
};

function makeTinyRegion(direction: 'v' | 'h' = 'v'): TextRegion {
  const width = 210;
  const height = 320;
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (((x + 0.5 - width / 2) / (width / 2)) ** 2
        + ((y + 0.5 - height / 2) / (height / 2)) ** 2 < 1) data[y * width + x] = 1;
    }
  }
  return {
    id: 'tiny', direction,
    box: { x: 135, y: 95, width: 65, height: 50 },
    fontSize: 8,
    sourceText: '原文第一列\n原文第二列\n原文第三列\n原文第四列',
    translatedText: '就是因为有大家在，我才能一直坚持到现在，真的非常感谢你们！',
    translatedColumns: ['就是因为有大家在，', '我才能一直坚持到现在，', '真的非常感谢你们！'],
    originalLineCount: 4,
    bubbleMask: { x: 70, y: 20, width, height, data },
  };
}

function makeRegions(): TextRegion[] {
  return [
    {
      id: 'vertical',
      box: { x: 20, y: 20, width: 100, height: 200 },
      direction: 'v',
      sourceText: '縦書き\n原文',
      translatedText: '竖排文字',
      translatedColumns: ['竖排', '文字'],
      originalLineCount: 2,
      fontSize: 32,
      fgColor: [0, 0, 0],
      bgColor: [255, 255, 255],
    },
    {
      id: 'horizontal',
      box: { x: 140, y: 40, width: 220, height: 90 },
      direction: 'h',
      sourceText: '横書き 原文',
      translatedText: '横排测试',
      translatedColumns: ['横排', '测试'],
      originalLineCount: 2,
      fontSize: 28,
      fgColor: [0, 0, 0],
      bgColor: [255, 255, 255],
    },
  ];
}

describe('drawTypeset', () => {
  it.each(['v', 'h'] as const)('reflows tiny %s translation at the minimum size within a large bubble', async (direction) => {
    const region = makeTinyRegion(direction);
    const original = structuredClone(region);
    const result = await drawTypeset(createCanvas(800, 600), [region], 'zh-CHS',
      { renderText: false, collectDebugLog: true }, platform);
    const debug = result.debugLog!.regions[0];
    expect(debug.fittedFontSize).toBe(18);
    expect(debug.layoutDiagnostics).toMatchObject({ minimumFontSize: 18, readabilityReflowed: true });
    expect(debug.preferredColumns).toEqual([]);
    expect(debug.columnGlyphCenters.flat().map((glyph) => glyph.ch).join('')).toBe(region.translatedText);
    expect(debug.expandedBox.width * debug.expandedBox.height).toBeGreaterThan(region.box.width * region.box.height);
    // Every corner of every rendered line/column remains inside the detected bubble.
    const mask = region.bubbleMask!;
    for (const quad of debug.columnCanvasQuads) {
      for (const point of quad) {
        const x = Math.floor(point.x - mask.x);
        const y = Math.floor(point.y - mask.y);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThan(mask.width);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThan(mask.height);
        expect(mask.data[y * mask.width + x]).toBe(1);
      }
    }
    expect(region).toEqual(original);
  });

  it.each([400, 800, 1600])('scales the readable floor with a %s-pixel page', async (width) => {
    const region = makeTinyRegion();
    const scale = width / 800;
    region.bubbleMask = undefined;
    region.box = { x: 100 * scale, y: 100 * scale, width: 100 * scale, height: 160 * scale };
    const result = await drawTypeset(createCanvas(width, width), [region], 'zh-CHS',
      { renderText: false, collectDebugLog: true }, platform);
    expect(resolveMinimumReadableFontSize(width)).toBe(18 * scale);
    expect(result.debugLog!.regions[0].fittedFontSize).toBeGreaterThanOrEqual(18 * scale);
  });

  it('leaves already-readable typesetting unchanged', async () => {
    const region = makeRegions()[0];
    const options = { renderText: false, collectDebugLog: true };
    const original = await drawTypeset(createCanvas(800, 600), [region], 'zh-CHS', { ...options, minimumFontSize: 0 }, platform);
    const readable = await drawTypeset(createCanvas(800, 600), [region], 'zh-CHS', options, platform);
    expect(readable.debugLog!.regions).toEqual(original.debugLog!.regions);
  });

  it('preserves original-text mode and supports an explicit minimum override', async () => {
    const region = makeTinyRegion();
    const options = { renderText: false, collectDebugLog: true };
    const disabled = await drawTypeset(createCanvas(800, 600), [region], 'zh-CHS', { ...options, minimumFontSize: 0 }, platform);
    expect(disabled.debugLog!.regions[0].fittedFontSize).toBeLessThan(18);
    const larger = await drawTypeset(createCanvas(800, 600), [region], 'zh-CHS', { ...options, minimumFontSize: 24 }, platform);
    expect(larger.debugLog!.regions[0].fittedFontSize).toBe(24);
    region.translatedText = '';
    region.translatedColumns = undefined;
    const source = await drawTypeset(createCanvas(800, 600), [region], 'zh-CHS', options, platform);
    expect(source.debugLog!.regions[0].layoutDiagnostics?.readabilityReflowed).not.toBe(true);
  });

  it('avoids neighboring text when selecting bubble whitespace', () => {
    const region = makeTinyRegion();
    region.box = { x: 80, y: 50, width: 30, height: 40 };
    region.bubbleMask = { x: 40, y: 20, width: 200, height: 300, data: new Uint8Array(200 * 300).fill(1) };
    const neighbor: TextRegion = { ...region, id: 'neighbor', box: { x: 150, y: 20, width: 90, height: 300 } };
    const prepared = prepareReadableRegion(region, 8, 18, 800, 600, [region, neighbor]);
    expect(prepared.box.x + prepared.box.width).toBeLessThan(150);
    expect(prepared.box.x).toBeGreaterThan(40);
    expect(prepared.box.height).toBeGreaterThan(region.box.height);
    expect(prepared.translatedColumns).toBeUndefined();
  });

  it('clips bubble search to the page and handles missing or empty masks', () => {
    const region = makeTinyRegion();
    region.box = { x: 0, y: 0, width: 20, height: 20 };
    region.bubbleMask = { x: -20, y: -30, width: 100, height: 100, data: new Uint8Array(10000).fill(1) };
    const prepared = prepareReadableRegion(region, 8, 18, 800, 600, [region]);
    expect(prepared.box).toEqual({ x: 6, y: 6, width: 68, height: 58 });
    region.bubbleMask.data.fill(0);
    const empty = prepareReadableRegion(region, 8, 18, 800, 600, [region]);
    expect(empty.box).toEqual(region.box);
    region.bubbleMask = undefined;
    expect(prepareReadableRegion(region, 8, 18, 800, 600, [region]).box).toEqual(empty.box);
  });

  it.each(['v', 'h'] as const)('relaxes the font target only to keep dense %s text complete and inside its bubble', async (direction) => {
    const region = makeTinyRegion(direction);
    region.translatedText = '甲乙丙丁戊己庚辛壬癸'.repeat(20);
    region.translatedColumns = undefined;
    const result = await drawTypeset(createCanvas(800, 600), [region], 'zh-CHS',
      { renderText: false, collectDebugLog: true }, platform);
    const debug = result.debugLog!.regions[0];
    expect(debug.fittedFontSize).toBeLessThan(18);
    expect(debug.layoutDiagnostics).toMatchObject({ minimumFontSizeRelaxed: true, boundedLayout: true, spacingTightened: true });
    const safe = prepareReadableRegion(region, 8, 18, 800, 600, [region]).box;
    expect(debug.expandedBox).toEqual(safe);
    expect(debug.columnGlyphCenters.flat().map((glyph) => glyph.ch).join('')).toBe(region.translatedText);
    for (const box of debug.columnBoxes) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(debug.offscreenWidth);
      expect(box.y + box.height).toBeLessThanOrEqual(debug.offscreenHeight);
    }
    for (const point of debug.columnCanvasQuads.flat()) {
      expect(point.x).toBeGreaterThanOrEqual(safe.x);
      expect(point.y).toBeGreaterThanOrEqual(safe.y);
      expect(point.x).toBeLessThanOrEqual(safe.x + safe.width);
      expect(point.y).toBeLessThanOrEqual(safe.y + safe.height);
    }
  });

  it.each(['v', 'h'] as const)('tightens %s spacing before reducing the requested font', (direction) => {
    const ctx = createMeasureContext();
    const originalMeasure = ctx.measureText.bind(ctx);
    ctx.measureText = (text) => ({ ...originalMeasure(text),
      fontBoundingBoxAscent: parseCanvasFontSize(ctx.font, 16) * 1.1,
      fontBoundingBoxDescent: parseCanvasFontSize(ctx.font, 16) * 0.3 });
    const region: TextRegion = { id: 'compact', direction, fontSize: 8,
      box: { x: 100, y: 100, width: direction === 'v' ? 74 : 90, height: direction === 'v' ? 160 : 86 },
      sourceText: '原文', translatedText: '甲乙丙丁戊己庚辛'.repeat(3) + '壬癸子丑' };
    const input = { region, fontFamily: 'Test Sans', measureCtx: ctx, minimumFontSize: 18 };
    const layout = direction === 'v' ? computeReadableVerticalTypeset(input) : computeReadableHorizontalTypeset(input);
    expect(layout.fittedFontSize).toBe(18);
    expect(layout.expandedRegion.box).toEqual(region.box);
    expect(layout.layoutDiagnostics).toMatchObject({ spacingTightened: true, minimumFontSizeRelaxed: false });
    if ('columns' in layout) {
      expect(layout.layoutDiagnostics.advanceScale).toBeLessThan(1);
      expect(layout.metrics.colSpacing).toBe(0);
      for (const glyph of layout.columns.flatMap((column) => column.glyphs)) {
        expect(glyph.advanceY).toBeGreaterThanOrEqual(glyph.inkHeight);
        expect(layout.metrics.colWidth).toBeGreaterThan(glyph.inkWidth);
      }
    } else {
      expect(layout.lineHeightScale).toBeLessThan(1);
      for (const line of layout.lineBoxes) expect(line.lineHeight).toBeGreaterThan(line.inkHeight);
    }
  });

  it.each(['v', 'h'] as const)('keeps %s punctuation without hanging it outside the last cell', (direction) => {
    const region: TextRegion = { id: 'punctuation', box: { x: 0, y: 0, width: 110, height: 78 },
      sourceText: '原文', translatedText: '甲乙丙丁，戊己庚辛。壬癸（子丑）……' };
    const input = { region, fontFamily: 'Test Sans', measureCtx: createMeasureContext(), minimumFontSize: 18 };
    const layout = direction === 'v' ? computeReadableVerticalTypeset(input) : computeReadableHorizontalTypeset(input);
    expect(layout.fittedFontSize).toBe(18);
    const content = 'columns' in layout ? layout.columns.flatMap((c) => c.glyphs.map((g) => g.sourceText)).join('')
      : layout.lines.map((line) => line.text).join('');
    expect(content).toBe(region.translatedText);
    for (const box of layout.debugColumnBoxes) {
      expect(box.x - layout.strokePadding).toBeGreaterThanOrEqual(0);
      expect(box.y - layout.strokePadding).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width - layout.strokePadding).toBeLessThanOrEqual(region.box.width);
      expect(box.y + box.height - layout.strokePadding).toBeLessThanOrEqual(region.box.height);
    }
  });

  it.each(['v', 'h'] as const)('partitions connected bubbles and renders %s neighbors independently of processing order', async (direction) => {
    const mask = { x: 40, y: 20, width: 260, height: 220, data: new Uint8Array(260 * 220).fill(1) };
    const left: TextRegion = { id: 'left', direction, fontSize: 8, sourceText: '一\n二\n三\n四',
      box: { x: 90, y: 70, width: 50, height: 60 }, bubbleMask: mask,
      translatedText: '虽然我不会放任他们在城里乱来，但也不能让无辜的人因此受到伤害。大家先冷静下来。' };
    const right: TextRegion = { id: 'right', direction, fontSize: 8, sourceText: '一\n二',
      box: { x: 215, y: 70, width: 40, height: 60 }, bubbleMask: mask,
      translatedText: '我就是这个意思。' };
    const draw = async (regions: TextRegion[]) => (await drawTypeset(createCanvas(800, 600), regions, 'zh-CHS',
      { renderText: false, collectDebugLog: true }, platform)).debugLog!.regions;
    const forward = await draw([left, right]);
    const backward = await draw([right, left]);
    const cut = ((left.box.x + left.box.width / 2) + (right.box.x + right.box.width / 2)) / 2;
    expect(forward[0].expandedBox.x + forward[0].expandedBox.width).toBeLessThan(cut);
    expect(forward[1].expandedBox.x).toBeGreaterThan(cut);
    for (const [index, source] of [left, right].entries()) {
      const a = forward[index];
      const b = backward.find((region) => region.regionId === a.regionId)!;
      expect(a.columnGlyphCenters.flat().map((g) => g.ch).join('')).toBe(source.translatedText);
      expect(a.expandedBox).toEqual(b.expandedBox);
      expect(a.columnCanvasQuads).toEqual(b.columnCanvasQuads);
    }
  });

  it('repairs overflowing source-column spacing even above the minimum font size', async () => {
    const region: TextRegion = { id: 'wide-pitch', direction: 'v', fontSize: 20,
      box: { x: 100, y: 100, width: 40, height: 100 }, sourceText: '第一列\n第二列',
      translatedText: '甲乙丙丁戊己', translatedColumns: ['甲乙丙', '丁戊己'], originalLineCount: 2 };
    const result = await drawTypeset(createCanvas(800, 600), [region], 'zh-CHS',
      { renderText: false, collectDebugLog: true }, platform);
    const debug = result.debugLog!.regions[0];
    expect(debug.fittedFontSize).toBeGreaterThanOrEqual(18);
    expect(debug.layoutDiagnostics?.boundedLayout).toBe(true);
    expect(debug.expandedBox).toEqual(region.box);
    expect(debug.columnGlyphCenters.flat().map((g) => g.ch).join('')).toBe(region.translatedText);
  });

  it('applies horizontal source style and exposes baseline line boxes', () => {
    const region: TextRegion = {
      id: 'horizontal-source-style',
      box: { x: 100, y: 50, width: 200, height: 80 },
      direction: 'h',
      sourceText: '上行\n下行文字',
      translatedText: '译文上行译文下行',
      translatedColumns: ['译文上行', '译文下行'],
      originalLineCount: 2,
      fontSize: 32,
      sourceLineGeometries: [
        {
          text: '上行',
          direction: 'h',
          box: { x: 120, y: 60, width: 80, height: 20 },
          centerX: 160,
          centerY: 70,
          width: 80,
          height: 20,
          fontSize: 20,
        },
        {
          text: '下行文字',
          direction: 'h',
          box: { x: 120, y: 90, width: 120, height: 20 },
          centerX: 180,
          centerY: 100,
          width: 120,
          height: 20,
          fontSize: 20,
        },
      ],
    };

    const layout = computeFullHorizontalTypeset({
      region,
      fontFamily: 'Test Sans',
      measureCtx: createMeasureContext(),
    });

    expect(layout).toMatchObject({
      initialFontSize: 20,
      alignment: 'left',
      horizontalAnchor: { contentCenterY: 35 },
      layoutDiagnostics: {
        sourceGeometryProfileUsed: true,
        sourceFontSize: 20,
        sourcePitch: 30,
        horizontalAlignment: 'left',
        horizontalAnchorContentCenterY: 35,
      },
    });
    expect(layout?.lineBoxes).toHaveLength(layout?.lines.length ?? 0);
    expect(layout?.lineBoxes.every((line) => (
      Number.isFinite(line.baselineY) && line.ascent > 0 && line.descent > 0
    ))).toBe(true);
    expect(layout?.debugColumnBoxes).toEqual(layout?.lineBoxes.map((line) => ({
      x: line.x,
      y: line.topY,
      width: line.width,
      height: line.visualHeight,
    })));
  });

  it('preserves source font size and visual line geometry for identity text', () => {
    const measureCtx = createMeasureContext();
    const originalMeasureText = measureCtx.measureText.bind(measureCtx);
    measureCtx.measureText = (text: string) => {
      const measured = originalMeasureText(text);
      const fontSize = parseCanvasFontSize(measureCtx.font, 16);
      return {
        ...measured,
        fontBoundingBoxAscent: fontSize * 1.1,
        fontBoundingBoxDescent: fontSize * 0.3,
      };
    };
    const region: TextRegion = {
      id: 'horizontal-source-identity',
      box: { x: 0, y: 0, width: 400, height: 80 },
      direction: 'h',
      sourceText: '甲乙 丙丁',
      translatedText: '甲乙 丙丁',
      originalLineCount: 1,
      fontSize: 80,
      sourceLineGeometries: [{
        text: '甲乙 丙丁',
        direction: 'h',
        box: { x: 0, y: 0, width: 400, height: 80 },
        centerX: 200,
        centerY: 40,
        width: 400,
        height: 80,
        fontSize: 80,
      }],
    };

    const layout = computeFullHorizontalTypeset({
      region,
      fontFamily: 'Test Sans',
      measureCtx,
    });

    expect(layout).toMatchObject({
      initialFontSize: 80,
      fittedFontSize: 80,
      layoutDiagnostics: {
        horizontalSourceIdentityMatched: true,
        horizontalSourceLineTargetWidths: [400],
      },
    });
    expect(layout?.debugColumnBoxes).toEqual([
      expect.objectContaining({ width: 400, height: 80 }),
    ]);
    expect(layout!.lineBoxes[0].baselineY - layout!.strokePadding).toBeCloseTo(64, 6);
  });

  it('exposes a horizontal layout result independent from Canvas rendering', () => {
    const horizontalRegion = makeRegions()[1];
    const layout = computeFullHorizontalTypeset({
      region: horizontalRegion,
      fontFamily: 'Test Sans',
      measureCtx: createMeasureContext(),
    });

    expect(layout).not.toBeNull();
    expect(layout).toMatchObject({
      expandedRegion: expect.objectContaining({ id: 'horizontal' }),
      text: '横排测试',
      preferredLines: ['横排', '测试'],
      sourceLines: ['横書き 原文'],
      fittedFontSize: expect.any(Number),
      alignment: expect.stringMatching(/^(left|center|right)$/),
    });
    expect(layout?.lines).toHaveLength(layout?.debugColumnBoxes.length ?? 0);
    expect(layout?.offscreenWidth).toBeGreaterThan(0);
    expect(layout?.offscreenHeight).toBeGreaterThan(0);
  });

  it('characterizes vertical and horizontal layout geometry and debug schema', async () => {
    const regions = makeRegions();
    const originalRegions = structuredClone(regions);

    const result = await drawTypeset(
      createCanvas(400, 300),
      regions,
      'zh-CHS',
      { renderText: false, collectDebugLog: true },
      platform,
    );

    expect(regions).toEqual(originalRegions);
    expect(result.canvas).toMatchObject({ width: 400, height: 300 });
    expect(result.debugLog?.regions).toHaveLength(2);
    const [vertical, horizontal] = result.debugLog?.regions ?? [];

    expect(vertical).toMatchObject({
      regionId: 'vertical',
      regionIndex: 0,
      direction: 'v',
      sourceText: '縦書き\n原文',
      translatedTextUsed: '竖排文字',
      preferredColumns: ['竖排', '文字'],
      sourceBox: { x: 20, y: 20, width: 100, height: 200 },
    });
    expect(horizontal).toMatchObject({
      regionId: 'horizontal',
      regionIndex: 1,
      direction: 'h',
      sourceText: '横書き 原文',
      translatedTextUsed: '横排测试',
      preferredColumns: ['横排', '测试'],
      sourceBox: { x: 140, y: 40, width: 220, height: 90 },
    });

    for (const debugRegion of [vertical, horizontal]) {
      expect(debugRegion.fittedFontSize).toBeGreaterThanOrEqual(8);
      expect(debugRegion.offscreenWidth).toBeGreaterThan(0);
      expect(debugRegion.offscreenHeight).toBeGreaterThan(0);
      expect(debugRegion.columnBoxes.length).toBeGreaterThan(0);
      expect(debugRegion.columnCanvasQuads).toHaveLength(debugRegion.columnBoxes.length);
      expect(debugRegion.columnBreakReasons).toHaveLength(debugRegion.columnBoxes.length);
      expect(debugRegion.columnSegmentIds).toHaveLength(debugRegion.columnBoxes.length);
      expect(debugRegion.columnSegmentSources).toHaveLength(debugRegion.columnBoxes.length);
      for (const box of debugRegion.columnBoxes) {
        expect([box.x, box.y, box.width, box.height].every(Number.isFinite)).toBe(true);
        expect(box.width).toBeGreaterThan(0);
        expect(box.height).toBeGreaterThan(0);
      }
    }

    expect(vertical.columnVerticalItems?.flat().length).toBeGreaterThan(0);
    expect(horizontal.columnGlyphCenters.flat()).toHaveLength(4);
    expect(horizontal.columnGlyphCenters.flat().map((center) => center.ch)).toEqual([
      '横', '排', '测', '试',
    ]);
    for (const line of horizontal.columnGlyphCenters) {
      expect(line.every((center, index) => (
        index === 0 || center.x > line[index - 1].x
      ))).toBe(true);
      expect(new Set(line.map((center) => center.y)).size).toBe(1);
    }
    expect(horizontal.columnVerticalItems).toEqual([]);
  });
});
