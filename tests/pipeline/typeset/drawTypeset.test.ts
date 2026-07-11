import { describe, expect, it } from 'vitest';
import { drawTypeset } from '../../../src/pipeline/typeset';
import { computeFullHorizontalTypeset } from '../../../src/pipeline/typeset/horizontalLayout';
import type {
  PipelineCanvas,
  PipelineRenderingContext,
  PlatformProvider,
} from '../../../src/runtime/platform';
import type { TextRegion } from '../../../src/types';

function createMeasureContext(): PipelineRenderingContext {
  const context = {
    font: '16px sans-serif',
    drawImage: () => {},
    measureText(text: string) {
      const fontSize = Number.parseFloat(context.font) || 16;
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
    expect(horizontal.columnVerticalItems).toEqual([]);
  });
});
