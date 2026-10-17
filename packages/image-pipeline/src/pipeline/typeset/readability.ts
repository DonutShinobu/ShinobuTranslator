import type { Rect, TextRegion } from '../../types';
import { cloneRegionForTypeset } from './geometry';

/** 18px when a page is displayed at 800px wide; scale with image resolution. */
export function resolveMinimumReadableFontSize(pageWidth: number): number {
  return Math.max(8, Math.ceil(pageWidth * 18 / 800));
}

function clampBox(box: Rect, pageWidth: number, pageHeight: number): Rect {
  const x = Math.max(0, Math.min(pageWidth - 1, box.x));
  const y = Math.max(0, Math.min(pageHeight - 1, box.y));
  return {
    x, y,
    width: Math.max(1, Math.min(pageWidth, box.x + box.width) - x),
    height: Math.max(1, Math.min(pageHeight, box.y + box.height) - y),
  };
}

/** Connected bubbles can share one mask. Allocate whitespace using ORIGINAL
 * source centers, so neighboring translations cannot claim the same area. */
function ownedBounds(region: TextRegion, bounds: Rect, neighbors: readonly TextRegion[]): Rect {
  const cx = region.box.x + region.box.width / 2;
  const cy = region.box.y + region.box.height / 2;
  let left = bounds.x;
  let right = bounds.x + bounds.width;
  let top = bounds.y;
  let bottom = bounds.y + bounds.height;
  for (const other of neighbors) {
    if (other === region || other.id === region.id) continue;
    const b = other.box;
    if (b.x >= bounds.x + bounds.width || b.x + b.width <= bounds.x
      || b.y >= bounds.y + bounds.height || b.y + b.height <= bounds.y) continue;
    const dx = b.x + b.width / 2 - cx;
    const dy = b.y + b.height / 2 - cy;
    if (Math.abs(dx) >= Math.abs(dy)) {
      const cut = cx + dx / 2;
      if (dx > 0 || (dx === 0 && region.id < other.id)) right = Math.min(right, cut);
      else left = Math.max(left, cut);
    } else {
      const cut = cy + dy / 2;
      if (dy > 0) bottom = Math.min(bottom, cut);
      else top = Math.max(top, cut);
    }
  }
  return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
}

/** Largest rectangle inside the bubble that still contains this text's center. */
function findBubbleInterior(
  region: TextRegion,
  neighbors: readonly TextRegion[],
  pageWidth: number,
  pageHeight: number,
): Rect | null {
  const mask = region.bubbleMask;
  if (!mask) return null;
  const bounds = ownedBounds(region, mask, neighbors);
  const left = Math.max(0, Math.ceil(bounds.x));
  const top = Math.max(0, Math.ceil(bounds.y));
  const width = Math.floor(Math.min(pageWidth, bounds.x + bounds.width)) - left;
  const height = Math.floor(Math.min(pageHeight, bounds.y + bounds.height)) - top;
  if (width <= 0 || height <= 0) return null;
  const anchorX = region.box.x + region.box.width / 2 - left;
  const anchorY = region.box.y + region.box.height / 2 - top;
  const blockers = neighbors.filter((other) => other !== region && other.id !== region.id)
    .map((other) => other.box)
    .filter((box) => box.x < left + width && box.x + box.width > left
      && box.y < top + height && box.y + box.height > top);
  const histogram = new Int32Array(width);
  const stack = new Int32Array(width + 1);
  let best: Rect | null = null;
  let bestArea = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const imageX = left + x;
      const imageY = top + y;
      const inside = mask.data[(imageY - mask.y) * mask.width + imageX - mask.x] > 0;
      const blocked = blockers.some((box) => imageX >= box.x && imageX < box.x + box.width
        && imageY >= box.y && imageY < box.y + box.height);
      histogram[x] = inside && !blocked ? histogram[x] + 1 : 0;
    }
    let size = 0;
    for (let x = 0; x <= width; x += 1) {
      const currentHeight = x === width ? 0 : histogram[x];
      while (size > 0 && histogram[stack[size - 1]] > currentHeight) {
        const h = histogram[stack[--size]];
        const start = size > 0 ? stack[size - 1] + 1 : 0;
        const area = (x - start) * h;
        if (area > bestArea && start <= anchorX && x > anchorX
          && y + 1 - h <= anchorY && y + 1 > anchorY) {
          best = { x: left + start, y: top + y + 1 - h, width: x - start, height: h };
          bestArea = area;
        }
      }
      stack[size++] = x;
    }
  }
  return best;
}

/** Reuse bubble whitespace instead of preserving an unreadably small OCR box. */
export function prepareReadableRegion(
  region: TextRegion,
  _fittedFontSize: number,
  minimumFontSize: number,
  pageWidth: number,
  pageHeight: number,
  neighbors: readonly TextRegion[],
): TextRegion {
  const result = cloneRegionForTypeset(region);
  const interior = findBubbleInterior(region, neighbors, pageWidth, pageHeight);
  const padding = Math.max(3, Math.ceil(minimumFontSize * 0.3));
  let box: Rect;
  if (interior && interior.width > minimumFontSize + padding * 2
    && interior.height > minimumFontSize + padding * 2) {
    box = {
      x: interior.x + padding, y: interior.y + padding,
      width: interior.width - padding * 2, height: interior.height - padding * 2,
    };
  } else {
    // A missing mask is NOT evidence of empty space. In particular, scaling the
    // OCR box by minimumFontSize / fittedFontSize caused text to escape panels.
    box = ownedBounds(region, interior ?? region.box, neighbors);
  }
  result.box = clampBox(box, pageWidth, pageHeight);
  // Reflow inside an axis-aligned area: old anchors and rotation would shrink
  // the result back into the original OCR columns during compositing.
  result.quad = undefined;
  result.sourceLineGeometries = undefined;
  result.translatedColumns = undefined;
  result.bubbleMask = undefined;
  result.fontSize = minimumFontSize;
  return result;
}

/** Axis-aligned translated ink must fit its allocated area, even if its font
 * already exceeds the readability target. Source-anchored spacing can overflow. */
export function layoutOverflowsReadableArea(
  layout: { expandedRegion: TextRegion; debugColumnBoxes: readonly Rect[]; boxPadding: number; strokePadding: number },
  area: Rect,
): boolean {
  const originX = layout.expandedRegion.box.x + layout.boxPadding - layout.strokePadding;
  const originY = layout.expandedRegion.box.y + layout.boxPadding - layout.strokePadding;
  return layout.debugColumnBoxes.some((box) => (
    originX + box.x < area.x - 0.5 || originY + box.y < area.y - 0.5
    || originX + box.x + box.width > area.x + area.width + 0.5
    || originY + box.y + box.height > area.y + area.height + 0.5
  ));
}
