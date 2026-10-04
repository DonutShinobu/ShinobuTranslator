import type { BubbleMask, TextRegion } from '../types';
import type { EditableImage, EditableLayer, EditableTextLayout } from './types';

export const EDITABLE_IMAGE_CONTENT_TYPE = 'application/x-shinobu-layers';
type ByteRange = { offset: number; size: number };
type PackedRegion = Omit<TextRegion, 'bubbleMask'> & {
  bubbleMask?: Omit<BubbleMask, 'data'> & { data: ByteRange };
};
type PackedLayer = Omit<EditableLayer, 'image'> & {
  image: ByteRange;
  region?: PackedRegion;
  layout?: EditableTextLayout;
};

/** One binary artifact lets both extension messaging transports share a codec. */
export function packEditableImage(image: EditableImage): Blob {
  const parts: Blob[] = [];
  let offset = 0;
  const append = (blob: Blob): ByteRange => {
    const range = { offset, size: blob.size };
    parts.push(blob); offset += blob.size;
    return range;
  };
  const layers = image.layers.map((layer): PackedLayer => {
    const { id, regionId, kind, width, height, transform, quad } = layer;
    const packed: PackedLayer = { id, regionId, kind, width, height, transform, quad, image: append(layer.image) };
    if (layer.kind === 'text') {
      const { bubbleMask, ...region } = layer.region;
      packed.region = { ...region, ...(bubbleMask ? { bubbleMask: {
        ...bubbleMask, data: append(new Blob([bubbleMask.data.slice().buffer])),
      } } : {}) };
      if (layer.layout) packed.layout = layer.layout;
    }
    return packed;
  });
  const metadata = new TextEncoder().encode(JSON.stringify({
    version: 1, width: image.width, height: image.height, targetLang: image.targetLang, layers,
  }));
  const prefix = new ArrayBuffer(4);
  new DataView(prefix).setUint32(0, metadata.byteLength, true);
  return new Blob([prefix, metadata, ...parts], { type: EDITABLE_IMAGE_CONTENT_TYPE });
}

function record(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function dimension(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function rect(value: unknown): boolean {
  return record(value) && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key]))
    && value.width > 0 && value.height > 0;
}

export async function unpackEditableImage(blob: Blob): Promise<EditableImage> {
  const invalid = (): never => { throw new Error('图层结果数据无效'); };
  if (blob.size < 4) invalid();
  const length = new DataView(await blob.slice(0, 4).arrayBuffer()).getUint32(0, true);
  if (length > 16 * 1024 * 1024 || length > blob.size - 4) invalid();
  const header: unknown = JSON.parse(await blob.slice(4, 4 + length).text());
  if (!record(header) || header.version !== 1 || !dimension(header.width) || !dimension(header.height)
    || typeof header.targetLang !== 'string' || !Array.isArray(header.layers)) return invalid();
  const payloadStart = 4 + length;
  const read = (range: unknown, type = 'image/png'): Blob => {
    if (!record(range) || !Number.isSafeInteger(range.offset) || range.offset < 0
      || !Number.isSafeInteger(range.size) || range.size < 0
      || range.offset + range.size > blob.size - payloadStart) return invalid();
    return blob.slice(payloadStart + range.offset, payloadStart + range.offset + range.size, type);
  };
  const layers: EditableLayer[] = [];
  const ids = new Set<string>();
  for (const layer of header.layers) {
    if (!record(layer) || typeof layer.id !== 'string' || !layer.id || ids.has(layer.id)
      || typeof layer.regionId !== 'string' || !layer.regionId
      || !dimension(layer.width) || !dimension(layer.height)
      || !Array.isArray(layer.transform) || layer.transform.length !== 6 || !layer.transform.every(Number.isFinite)
      || !Array.isArray(layer.quad) || layer.quad.length !== 4
      || !layer.quad.every((p: unknown) => record(p) && Number.isFinite(p.x) && Number.isFinite(p.y))) return invalid();
    ids.add(layer.id);
    const base = { ...layer, image: read(layer.image) };
    if (layer.kind === 'text') {
      const region = layer.region;
      if (!record(region) || typeof region.id !== 'string' || !rect(region.box)
        || typeof region.sourceText !== 'string' || typeof region.translatedText !== 'string'
        || (region.direction !== undefined && region.direction !== 'v' && region.direction !== 'h')) return invalid();
      const layout = layer.layout;
      if (layout !== undefined && (!record(layout) || !Number.isFinite(layout.fontSize) || layout.fontSize <= 0
        || typeof layout.fontFamily !== 'string' || typeof layout.color !== 'string'
        || (layout.direction !== 'v' && layout.direction !== 'h') || !Array.isArray(layout.glyphs)
        || !layout.glyphs.every((glyph: unknown) => record(glyph)
          && Number.isSafeInteger(glyph.start) && glyph.start >= 0 && Number.isSafeInteger(glyph.end)
          && glyph.end >= glyph.start && glyph.end <= region.translatedText.length
          && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(glyph[key]))
          && (glyph.baselineY === undefined || Number.isFinite(glyph.baselineY))
          && glyph.width > 0 && glyph.height > 0))) return invalid();
      const { bubbleMask, ...rest } = region;
      if (bubbleMask && (!rect(bubbleMask) || !dimension(bubbleMask.width) || !dimension(bubbleMask.height))) return invalid();
      const data = bubbleMask ? new Uint8Array(await read(bubbleMask.data, 'application/octet-stream').arrayBuffer()) : undefined;
      if (bubbleMask && data?.length !== bubbleMask.width * bubbleMask.height) return invalid();
      layers.push({ ...base, kind: 'text', region: {
        ...rest, ...(bubbleMask ? { bubbleMask: { ...bubbleMask, data } } : {}),
      } } as EditableLayer);
    } else if (layer.kind === 'erase') {
      layers.push({ ...base, kind: 'erase' } as EditableLayer);
    } else return invalid();
  }
  return { width: header.width, height: header.height, targetLang: header.targetLang, layers };
}
