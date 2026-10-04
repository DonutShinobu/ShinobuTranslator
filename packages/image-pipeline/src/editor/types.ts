import type { Rect, QuadPoint } from '../index';
import type { TextRegion } from '../types';
import type { PipelineCanvas } from '../runtime/platform';

export type LayerTransform = [number, number, number, number, number, number];

export type EditableRasterLayer = {
  id: string;
  regionId: string;
  image: Blob;
  width: number;
  height: number;
  transform: LayerTransform;
  quad: [QuadPoint, QuadPoint, QuadPoint, QuadPoint];
};

export type EditableEraseLayer = EditableRasterLayer & { kind: 'erase' };
export type EditableTextGlyph = {
  start: number;
  end: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Horizontal caret boxes share the renderer's baseline rather than each glyph's ink center. */
  baselineY?: number;
};
export type EditableTextLayout = {
  fontSize: number;
  fontFamily: string;
  color: string;
  direction: 'h' | 'v';
  glyphs: EditableTextGlyph[];
};
export type EditableTextLayer = EditableRasterLayer & { kind: 'text'; region: TextRegion; layout?: EditableTextLayout };
export type EditableLayer = EditableEraseLayer | EditableTextLayer;

export type EditableImage = {
  width: number;
  height: number;
  targetLang: string;
  layers: EditableLayer[];
};

export type TypesetLayerCanvas = {
  canvas: PipelineCanvas;
  region: TextRegion;
  transform: LayerTransform;
  quad: EditableRasterLayer['quad'];
  layout?: EditableTextLayout;
};

export type RegionMaskOwnership = {
  width: number;
  height: number;
  regionIds: string[];
  /** One-based region indices; zero is outside the mask. */
  labels: Int32Array;
};

export type EraseLayerCanvas = {
  regionId: string;
  canvas: PipelineCanvas;
  bounds: Rect;
};

export type EditableLayerCanvases = {
  erase: EraseLayerCanvas[];
  text: TypesetLayerCanvas[];
};
