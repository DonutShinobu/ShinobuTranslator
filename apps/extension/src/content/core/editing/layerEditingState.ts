import type { EditableImage, EditableLayer, EditableTextLayer } from '@shinobu/image-pipeline/editor';

export type LayerSelectionKind = 'all' | 'text' | 'erase';
export type EditingLayer = {
  content: EditableLayer;
  offsetX: number;
  offsetY: number;
  deleted: boolean;
  generation: number;
};
export type TextLayerRenderer = (region: EditableTextLayer['region'], targetLang: string) => Promise<EditableTextLayer | null>;

export function layerBounds(layer: EditingLayer) {
  const xs = layer.content.quad.map((point) => point.x + layer.offsetX);
  const ys = layer.content.quad.map((point) => point.y + layer.offsetY);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

function contains(layer: EditingLayer, x: number, y: number): boolean {
  const points = layer.content.quad;
  x -= layer.offsetX; y -= layer.offsetY;
  let positive = false, negative = false;
  for (let i = 0; i < 4; i++) {
    const a = points[i], b = points[(i + 1) % 4];
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    positive ||= cross > 1e-5; negative ||= cross < -1e-5;
  }
  return !(positive && negative);
}

/** Session data belongs to the photo, rather than its temporarily mounted DOM. */
export class LayerEditingState {
  readonly image: EditableImage;
  readonly layers: EditingLayer[];
  active = false;
  revision = 0;
  appliedRevision = 0;
  disposed = false;
  readonly pending = new Set<Promise<void>>();
  private readonly listeners = new Set<() => void>();

  constructor(image: EditableImage, readonly source: Blob) {
    this.image = structuredClone(image);
    this.layers = this.image.layers.map((content) => ({ content, offsetX: 0, offsetY: 0, deleted: false, generation: 0 }));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  notify(): void { for (const listener of this.listeners) listener(); }
  private changed(): void { this.revision++; this.notify(); }

  hitTest(x: number, y: number, kind: LayerSelectionKind = 'all'): EditingLayer[] {
    return this.layers.filter((layer) => !layer.deleted
      && (kind === 'all' || kind === layer.content.kind) && contains(layer, x, y)).reverse();
  }

  move(layer: EditingLayer, x: number, y: number): void {
    if (this.disposed || layer.deleted || layer.content.kind !== 'text') return;
    const xs = layer.content.quad.map((point) => point.x), ys = layer.content.quad.map((point) => point.y);
    const minX = -Math.min(...xs), minY = -Math.min(...ys);
    x = Math.max(minX, Math.min(Math.max(minX, this.image.width - Math.max(...xs)), x));
    y = Math.max(minY, Math.min(Math.max(minY, this.image.height - Math.max(...ys)), y));
    if (x === layer.offsetX && y === layer.offsetY) return;
    layer.offsetX = x; layer.offsetY = y;
    this.changed();
  }

  remove(layer: EditingLayer): void {
    if (this.disposed || layer.deleted) return;
    layer.deleted = true; layer.generation++;
    this.changed();
  }

  editText(layer: EditingLayer, text: string, render: TextLayerRenderer): Promise<void> {
    if (this.disposed || layer.deleted || layer.content.kind !== 'text') return Promise.resolve();
    const generation = ++layer.generation;
    if (text === layer.content.region.translatedText) return Promise.resolve();
    const region = structuredClone(layer.content.region);
    region.translatedText = text;
    region.translatedColumns = undefined;
    const promise = (async () => {
      let next: EditableTextLayer | null;
      try { next = text.trim() ? await render(region, this.image.targetLang) : null; }
      catch (error) {
        if (this.disposed || layer.deleted || generation !== layer.generation) return;
        throw error;
      }
      if (this.disposed || layer.deleted || generation !== layer.generation) return;
      if (next) layer.content = next;
      else layer.deleted = true;
      this.changed();
    })();
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => undefined);
    return promise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.active = false;
    this.notify();
    this.listeners.clear();
  }
}
