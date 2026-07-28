import { describe, expect, it } from "vitest";
import type { PipelineRenderingContext } from "../../../src/runtime/platform";
import type { BubbleMask, TextRegion } from "../../../src/types";
import {
  buildHorizontalLineBoxes,
  buildHorizontalGlyphPlacements,
  rebalanceHorizontalShortTailLines,
  resolveHorizontalLineMetrics,
  resolveHorizontalSafeInterval,
} from "../../../src/pipeline/typeset/horizontalFit";
import {
  resolveHorizontalSourceGeometryProfile,
  resolveHorizontalSourceLineAnchor,
  resolveHorizontalSourceLineLayouts,
} from "../../../src/pipeline/typeset/sourceGeometry";

function parseCanvasFontSize(font: string, fallback: number): number {
  return Number.parseFloat(font.match(/([\d.]+)px/u)?.[1] ?? "") || fallback;
}

function makeRegion(overrides: Partial<TextRegion> = {}): TextRegion {
  return {
    id: "horizontal-test",
    box: { x: 100, y: 50, width: 200, height: 100 },
    direction: "h",
    sourceText: "甲乙\n丙丁戊",
    translatedText: "甲乙丙丁戊",
    ...overrides,
  };
}

function createMeasureContext(withBounds = true): PipelineRenderingContext {
  const context = {
    font: "20px Test Sans",
    measureText(text: string) {
      const fontSize = parseCanvasFontSize(context.font, 20);
      const width = [...text].length * fontSize * 0.5;
      if (!withBounds) return { width };
      return {
        width,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: width,
        actualBoundingBoxAscent: fontSize * 0.8,
        actualBoundingBoxDescent: fontSize * 0.2,
        fontBoundingBoxAscent: fontSize * 0.8,
        fontBoundingBoxDescent: fontSize * 0.2,
      };
    },
  };
  return context as unknown as PipelineRenderingContext;
}

function createMask(
  width: number,
  height: number,
  isInside: (x: number, y: number) => boolean,
): BubbleMask {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (isInside(x, y)) data[y * width + x] = 1;
    }
  }
  return { x: 0, y: 0, width, height, data };
}

describe("resolveHorizontalSourceGeometryProfile", () => {
  it("extracts source style, top-to-bottom mapping, anchor, and left alignment", () => {
    const region = makeRegion({
      sourceLineGeometries: [
        {
          text: "甲乙",
          direction: "h",
          box: { x: 120, y: 60, width: 80, height: 20 },
          centerX: 160,
          centerY: 70,
          width: 80,
          height: 20,
          fontSize: 20,
        },
        {
          text: "丙丁戊",
          direction: "h",
          box: { x: 120, y: 90, width: 120, height: 20 },
          centerX: 180,
          centerY: 100,
          width: 120,
          height: 20,
          fontSize: 20,
        },
      ],
    });

    const profile = resolveHorizontalSourceGeometryProfile(
      region,
      2,
      createMeasureContext(),
      "Test Sans",
    );

    expect(profile).toMatchObject({
      lineCount: 2,
      groupCenterY: 85,
      sourceFontSize: 20,
      sourcePitch: 30,
      medianPitch: 30,
      medianGap: 10,
      medianWidth: 100,
      medianHeight: 20,
      inferredAlignment: "left",
      sourceOrderReliable: true,
      perLineCentersY: [70, 100],
      perLineLeftX: [120, 120],
      perLineRightX: [200, 240],
      perLineHeights: [20, 20],
    });
    expect(resolveHorizontalSourceLineAnchor(region, 0, profile)).toEqual({
      contentCenterY: 35,
    });
    expect(resolveHorizontalSourceLineLayouts(region, 0, ['甲乙', '丙丁戊'], profile)).toEqual([
      { contentLeftX: 20, targetWidth: 80, targetHeight: 20, advanceScale: 1 },
      { contentLeftX: 20, targetWidth: 120, targetHeight: 20, advanceScale: 1 },
    ]);
    expect(resolveHorizontalSourceLineLayouts(region, 0, ['甲乙', '不匹配'], profile)).toBeUndefined();
  });

  it("infers centered source lines from a stable center axis", () => {
    const region = makeRegion({
      sourceLineGeometries: [
        {
          text: "甲乙",
          direction: "h",
          box: { x: 130, y: 60, width: 80, height: 20 },
          centerX: 170,
          centerY: 70,
          width: 80,
          height: 20,
        },
        {
          text: "丙丁戊",
          direction: "h",
          box: { x: 110, y: 90, width: 120, height: 20 },
          centerX: 170,
          centerY: 100,
          width: 120,
          height: 20,
        },
      ],
    });

    expect(resolveHorizontalSourceGeometryProfile(region, 2)?.inferredAlignment).toBe("center");
  });

  it("keeps global statistics but disables per-line feedback for non-monotonic source order", () => {
    const region = makeRegion({
      sourceText: "甲乙\n丙丁戊",
      sourceLineGeometries: [
        {
          text: "甲乙",
          direction: "h",
          box: { x: 120, y: 90, width: 80, height: 20 },
          centerX: 160,
          centerY: 100,
          width: 80,
          height: 20,
        },
        {
          text: "丙丁戊",
          direction: "h",
          box: { x: 120, y: 60, width: 120, height: 20 },
          centerX: 180,
          centerY: 70,
          width: 120,
          height: 20,
        },
      ],
    });

    const profile = resolveHorizontalSourceGeometryProfile(region, 2);

    expect(profile).toMatchObject({
      medianPitch: 30,
      sourceOrderReliable: false,
      perLineCentersY: [],
      perLineLeftX: [],
      perLineRightX: [],
      perLineHeights: [],
    });
  });

  it("does not invent a per-line mapping for ambiguous duplicate text", () => {
    const region = makeRegion({
      sourceText: "同\n同",
      sourceLineGeometries: [
        {
          text: "同",
          direction: "h",
          box: { x: 120, y: 90, width: 40, height: 20 },
          centerX: 140,
          centerY: 100,
          width: 40,
          height: 20,
        },
        {
          text: "同",
          direction: "h",
          box: { x: 120, y: 60, width: 40, height: 20 },
          centerX: 140,
          centerY: 70,
          width: 40,
          height: 20,
        },
      ],
    });

    expect(resolveHorizontalSourceGeometryProfile(region, 2)).toMatchObject({
      sourceOrderReliable: false,
      perLineCentersY: [],
    });
  });

  it("recovers top-to-bottom mapping through unique text matching", () => {
    const region = makeRegion({
      sourceLineGeometries: [
        {
          text: "丙丁戊",
          direction: "h",
          box: { x: 120, y: 90, width: 120, height: 20 },
          centerX: 180,
          centerY: 100,
          width: 120,
          height: 20,
        },
        {
          text: "甲乙",
          direction: "h",
          box: { x: 120, y: 60, width: 80, height: 20 },
          centerX: 160,
          centerY: 70,
          width: 80,
          height: 20,
        },
      ],
    });

    expect(resolveHorizontalSourceGeometryProfile(region, 2)).toMatchObject({
      sourceOrderReliable: true,
      perLineCentersY: [70, 100],
    });
  });

  it("infers right alignment and falls back to unknown for tied axes", () => {
    const rightAligned = makeRegion({
      sourceLineGeometries: [
        {
          text: "甲乙",
          direction: "h",
          box: { x: 140, y: 60, width: 80, height: 20 },
          centerX: 180,
          centerY: 70,
          width: 80,
          height: 20,
        },
        {
          text: "丙丁戊",
          direction: "h",
          box: { x: 100, y: 90, width: 120, height: 20 },
          centerX: 160,
          centerY: 100,
          width: 120,
          height: 20,
        },
      ],
    });
    const tied = makeRegion({
      sourceLineGeometries: [
        {
          text: "甲乙",
          direction: "h",
          box: { x: 120, y: 60, width: 80, height: 20 },
          centerX: 160,
          centerY: 70,
          width: 80,
          height: 20,
        },
        {
          text: "丙丁戊",
          direction: "h",
          box: { x: 120, y: 90, width: 80, height: 20 },
          centerX: 160,
          centerY: 100,
          width: 80,
          height: 20,
        },
      ],
    });

    expect(resolveHorizontalSourceGeometryProfile(rightAligned, 2)?.inferredAlignment).toBe("right");
    expect(resolveHorizontalSourceGeometryProfile(tied, 2)?.inferredAlignment).toBe("unknown");
  });

  it("rejects count mismatch and avoids anchoring rotated regions", () => {
    const region = makeRegion({
      quad: [
        { x: 100, y: 50 },
        { x: 300, y: 70 },
        { x: 290, y: 170 },
        { x: 90, y: 150 },
      ],
      sourceLineGeometries: [
        {
          text: "甲乙",
          direction: "h",
          box: { x: 120, y: 60, width: 80, height: 20 },
          centerX: 160,
          centerY: 70,
          width: 80,
          height: 20,
        },
      ],
    });

    expect(resolveHorizontalSourceGeometryProfile(region, 2)).toBeUndefined();
    const single = resolveHorizontalSourceGeometryProfile(
      makeRegion({
        sourceText: "甲乙",
        sourceLineGeometries: region.sourceLineGeometries,
        quad: region.quad,
      }),
      1,
    );
    expect(single).toBeUndefined();
    expect(resolveHorizontalSourceLineAnchor(region, 0, single)).toBeUndefined();
  });

  it("rejects wrong-direction and invalid-size source geometry", () => {
    const wrongDirection = makeRegion({
      sourceText: "甲乙",
      sourceLineGeometries: [{
        text: "甲乙",
        direction: "v",
        box: { x: 120, y: 60, width: 80, height: 20 },
        centerX: 160,
        centerY: 70,
        width: 80,
        height: 20,
      }],
    });
    const invalidSize = makeRegion({
      sourceText: "甲乙",
      sourceLineGeometries: [{
        text: "甲乙",
        direction: "h",
        box: { x: 120, y: 60, width: 0, height: 20 },
        centerX: 160,
        centerY: 70,
        width: 0,
        height: 20,
      }],
    });

    expect(resolveHorizontalSourceGeometryProfile(wrongDirection, 1)).toBeUndefined();
    expect(resolveHorizontalSourceGeometryProfile(invalidSize, 1)).toBeUndefined();
  });
});

describe("horizontal line metrics and mask width", () => {
  it("resets a vertical middle baseline before measuring horizontal ink", () => {
    const ctx = createMeasureContext();
    const measureText = ctx.measureText.bind(ctx);
    ctx.textBaseline = "middle";
    ctx.measureText = (text: string) => {
      const measured = measureText(text);
      if (ctx.textBaseline !== "middle") return measured;
      return {
        ...measured,
        actualBoundingBoxAscent: 10,
        actualBoundingBoxDescent: 10,
      };
    };

    expect(resolveHorizontalLineMetrics(ctx, "测试", 20)).toMatchObject({
      inkAscent: 16,
      inkDescent: 4,
    });
    expect(ctx.textBaseline).toBe("alphabetic");
  });

  it("uses real font metrics and source pitch for the line box", () => {
    expect(resolveHorizontalLineMetrics(createMeasureContext(), "测试", 20, 30)).toEqual({
      ascent: 16,
      descent: 4,
      inkAscent: 16,
      inkDescent: 4,
      inkHeight: 20,
      lineHeight: 30,
    });
  });

  it("falls back to font-size metrics when Canvas bounds are unavailable", () => {
    expect(resolveHorizontalLineMetrics(createMeasureContext(false), "测试", 20)).toEqual({
      ascent: 16,
      descent: 4,
      inkAscent: 16,
      inkDescent: 4,
      inkHeight: 20,
      lineHeight: 20,
    });
  });

  it("selects the safe mask interval containing the preferred anchor", () => {
    const mask = createMask(220, 120, (x, y) => (
      y >= 10 && y < 30
        ? (x >= 10 && x <= 60) || (x >= 100 && x <= 180)
        : true
    ));
    const region = makeRegion({ box: { x: 0, y: 0, width: 200, height: 100 } });

    expect(resolveHorizontalSafeInterval({
      mask,
      region,
      contentWidth: 200,
      localTopY: 10,
      localBottomY: 30,
      preferredContentX: 130,
      safetyMargin: 2,
    })).toEqual({ left: 102, right: 178, width: 76, source: "mask" });
  });

  it("returns different safe widths for differently shaped line bands", () => {
    const mask = createMask(220, 100, (x, y) => (
      y < 40 ? x >= 50 && x <= 150 : x >= 10 && x <= 190
    ));
    const region = makeRegion({ box: { x: 0, y: 0, width: 200, height: 80 } });
    const upper = resolveHorizontalSafeInterval({
      mask,
      region,
      contentWidth: 200,
      localTopY: 10,
      localBottomY: 30,
      preferredContentX: 100,
      safetyMargin: 2,
    });
    const lower = resolveHorizontalSafeInterval({
      mask,
      region,
      contentWidth: 200,
      localTopY: 50,
      localBottomY: 70,
      preferredContentX: 100,
      safetyMargin: 2,
    });

    expect(upper).toEqual({ left: 52, right: 148, width: 96, source: "mask" });
    expect(lower).toEqual({ left: 12, right: 188, width: 176, source: "mask" });
  });

  it("builds each line box from its own mask interval", () => {
    const mask = createMask(220, 100, (x, y) => (
      y < 40 ? x >= 50 && x <= 150 : x >= 10 && x <= 190
    ));
    const region = makeRegion({ box: { x: 0, y: 0, width: 200, height: 80 } });
    const lineBoxes = buildHorizontalLineBoxes({
      ctx: createMeasureContext(),
      lines: [
        { text: "上行", width: 20 },
        { text: "下行", width: 20 },
      ],
      region,
      contentWidth: 200,
      contentHeight: 80,
      fontSize: 20,
      padding: 0,
      alignment: "center",
      sourcePitch: 20,
      bubbleMask: mask,
    });

    expect(lineBoxes.map((line) => line.safeInterval.source)).toEqual(["mask", "mask"]);
    expect(lineBoxes[0].maxWidth).toBeLessThan(lineBoxes[1].maxWidth);
  });

  it("anchors source lines, clamps them to the safe interval, and shares scaled placements", () => {
    const mask = createMask(220, 100, (x, y) => (
      y >= 20 && y <= 60 ? x >= 50 && x <= 150 : true
    ));
    const region = makeRegion({ box: { x: 0, y: 0, width: 200, height: 80 } });
    const ctx = createMeasureContext();
    ctx.font = "20px Test Sans";
    const lineBoxes = buildHorizontalLineBoxes({
      ctx,
      lines: [{ text: "甲 乙", width: 30 }],
      region,
      contentWidth: 200,
      contentHeight: 80,
      fontSize: 20,
      padding: 0,
      alignment: "left",
      sourcePitch: 20,
      sourceLineLayouts: [{
        contentLeftX: 0,
        targetWidth: 80,
        targetHeight: 20,
        advanceScale: 80 / 30,
      }],
      bubbleMask: mask,
    });

    expect(lineBoxes[0]).toMatchObject({
      x: 50,
      width: 80,
      naturalWidth: 30,
      visualHeight: 20,
      sourceAnchored: true,
      sourceClamped: true,
    });
    const placements = buildHorizontalGlyphPlacements(ctx, lineBoxes, 0)[0];
    expect(placements).toHaveLength(3);
    expect(placements[1].ch).toBe(" ");
    expect(placements[0].centerX).toBeCloseTo(50 + 80 / 6);
    expect(placements[2].centerX).toBeCloseTo(50 + 80 * 5 / 6);
    expect(placements[0].centerY).toBe(placements[2].centerY);
  });

  it("rejects source anchoring when the target width cannot fit the safe interval", () => {
    const mask = createMask(220, 100, (x, y) => (
      y >= 20 && y <= 60 ? x >= 70 && x <= 130 : true
    ));
    const region = makeRegion({ box: { x: 0, y: 0, width: 200, height: 80 } });
    const ctx = createMeasureContext();
    ctx.font = "20px Test Sans";
    const [lineBox] = buildHorizontalLineBoxes({
      ctx,
      lines: [{ text: "甲乙丙丁", width: 40 }],
      region,
      contentWidth: 200,
      contentHeight: 80,
      fontSize: 20,
      padding: 0,
      alignment: "center",
      sourcePitch: 20,
      sourceLineLayouts: [{
        contentLeftX: 0,
        targetWidth: 120,
        targetHeight: 20,
        advanceScale: 3,
      }],
      bubbleMask: mask,
    });

    expect(lineBox.sourceAnchored).toBe(false);
    expect(lineBox.sourceAdvanceScale).toBeUndefined();
  });

  it("falls back to the content interval when no continuous mask run exists", () => {
    const mask = createMask(220, 100, () => false);
    const region = makeRegion({ box: { x: 0, y: 0, width: 200, height: 80 } });

    expect(resolveHorizontalSafeInterval({
      mask,
      region,
      contentWidth: 200,
      localTopY: 20,
      localBottomY: 40,
      preferredContentX: 100,
      safetyMargin: 2,
    })).toEqual({ left: 0, right: 200, width: 200, source: "content" });
  });

  it("falls back to content width without a mask or for a rotated region", () => {
    const plainRegion = makeRegion({ box: { x: 0, y: 0, width: 200, height: 100 } });
    const rotatedRegion = makeRegion({
      box: { x: 0, y: 0, width: 200, height: 100 },
      quad: [
        { x: 0, y: 0 },
        { x: 200, y: 20 },
        { x: 190, y: 120 },
        { x: -10, y: 100 },
      ],
    });
    const mask = createMask(220, 140, () => true);
    const baseInput = {
      contentWidth: 200,
      localTopY: 10,
      localBottomY: 30,
      preferredContentX: 100,
      safetyMargin: 2,
    };

    expect(resolveHorizontalSafeInterval({ ...baseInput, region: plainRegion })).toEqual({
      left: 0,
      right: 200,
      width: 200,
      source: "content",
    });
    expect(resolveHorizontalSafeInterval({ ...baseInput, region: rotatedRegion, mask })).toEqual({
      left: 0,
      right: 200,
      width: 200,
      source: "content",
    });
  });
});

describe("rebalanceHorizontalShortTailLines", () => {
  it("moves source-order glyphs before shrinking the font", () => {
    const ctx = createMeasureContext(false);
    ctx.font = "20px Test Sans";
    const lines = rebalanceHorizontalShortTailLines(
      ctx,
      [
        { text: "一二三四五", width: 50 },
        { text: "六", width: 10 },
      ],
      [50, 50],
      0,
    );

    expect(lines).toEqual([
      { text: "一二三", width: 30 },
      { text: "四五六", width: 30 },
    ]);
  });
});
