import type { GroundTruthColumn } from "./types";
import type { QuadPoint, TypesetDebugRegionLog } from '@shinobu/image-pipeline/benchmark';

function quadBounds(quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const xs = quad.map((p) => p.x);
  const ys = quad.map((p) => p.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

export function debugRegionToColumns(region: TypesetDebugRegionLog): GroundTruthColumn[] {
  return region.columnGlyphCenters.map((glyphs, index) => {
    const quad = region.columnCanvasQuads[index];
    const bounds = quad
      ? quadBounds(quad)
      : glyphs.length > 0
        ? {
            minX: Math.min(...glyphs.map((g) => g.x)),
            minY: Math.min(...glyphs.map((g) => g.y)),
            maxX: Math.max(...glyphs.map((g) => g.x)),
            maxY: Math.max(...glyphs.map((g) => g.y)),
          }
      : {
          minX: 0,
          minY: 0,
          maxX: 0,
          maxY: 0,
        };
    const charCenters = glyphs.map((g) => ({ x: g.x, y: g.y }));
    return {
      index,
      text: glyphs.map((g) => g.ch).join(""),
      charCount: glyphs.length,
      centerX: (bounds.minX + bounds.maxX) / 2,
      topY: bounds.minY,
      bottomY: bounds.maxY,
      width: Math.max(0, bounds.maxX - bounds.minX),
      height: Math.max(0, bounds.maxY - bounds.minY),
      estimatedFontSize: region.fittedFontSize,
      charCenters,
      quad,
    };
  });
}
