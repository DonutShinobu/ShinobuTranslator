import type { EditableTextLayer } from '@shinobu/image-pipeline/editor';
import type { PhotoState } from '../types';
import type { UiElements } from '../ui/imageControls';
import { renderBrowserTextLayer, loadLayerImage } from './browserLayerRenderer';
import { type EditingLayer, type LayerEditingState } from './layerEditingState';
import { resolveEditingSurface, toEditingPoint, type EditingSurface } from './imageSurface';
import { InPlaceTextEditor } from './inPlaceTextEditor';
import { hitsLayerAlpha, type LayerAlphaMask } from './layerAlphaMask';
import { observeImageEditingPreference } from './imageEditingPreference';

type Options = {
  ui: UiElements;
  getState(): PhotoState | undefined;
  getImage(): HTMLImageElement | undefined;
  getEnabled?(): boolean;
  onChange(): void;
  container?: HTMLElement;
  protect?(): () => void;
};

const DRAG_START_DISTANCE = 6;
const SELECTION_PADDING = 2;

export class ImageLayerEditor {
  private session?: LayerEditingState;
  private host?: HTMLDivElement;
  private stage?: HTMLDivElement;
  private controlPortal?: HTMLDivElement;
  private controlAnchor?: HTMLDivElement;
  private selection?: HTMLImageElement;
  private selectionFrame?: SVGPolygonElement;
  private hover?: HTMLImageElement;
  private errorLine?: HTMLSpanElement;
  private input?: InPlaceTextEditor;
  private selected?: EditingLayer;
  private hovered?: EditingLayer;
  private hoverTimer?: ReturnType<typeof setTimeout>;
  private nextHovered?: EditingLayer;
  private surface?: EditingSurface;
  private drag?: {
    pointerId: number; x: number; y: number; clientX: number; clientY: number;
    offsetX: number; offsetY: number; layer: EditingLayer; started: boolean;
  };
  private frame?: number;
  private unsubscribe?: () => void;
  private releaseProtection?: () => void;
  private stopPreference = () => {};
  private enabled = false;
  private lastEnabled = false;
  private suspended = false;
  private suspendedMode?: PhotoState['mode'];
  private disposed = false;
  private finishing?: Promise<boolean>;
  private readonly urls = new Map<Blob, string>();
  private readonly rasters = new Map<EditingLayer, HTMLImageElement>();
  private readonly coverage = new Map<Blob, {
    mask: LayerAlphaMask; highlight: Blob;
    bounds?: { x: number; y: number; width: number; height: number };
  }>();
  private readonly coverageTasks = new Set<Blob>();

  constructor(private readonly options: Options) {
    if (!options.getEnabled) this.stopPreference = observeImageEditingPreference((enabled) => {
      this.enabled = enabled; this.sync();
    });
  }

  sync(): void {
    if (this.disposed) return;
    const state = this.options.getState(), session = state?.layerEditing;
    const enabled = this.options.getEnabled?.() ?? this.enabled;
    if (enabled !== this.lastEnabled || state?.mode !== this.suspendedMode) this.suspended = false;
    this.lastEnabled = enabled;
    if (!session || session.disposed) { this.unmount(); return; }
    if (!enabled || this.suspended || state?.mode !== 'translated' || state.status !== 'translated') {
      if (session.active && !this.finishing) void this.finish();
      else if (!session.active) this.unmount();
      return;
    }
    if (session !== this.session) { this.unmount(); session.active = true; this.mount(session); }
    this.updateLayers(); this.updateGeometry();
  }

  private url(blob: Blob): string {
    let url = this.urls.get(blob);
    if (!url) { url = URL.createObjectURL(blob); this.urls.set(blob, url); }
    return url;
  }

  private mount(session: LayerEditingState): void {
    this.session = session;
    this.releaseProtection = this.options.protect?.();
    const host = document.createElement('div');
    host.className = 'mt-x-layer-editor'; host.tabIndex = 0;
    host.setAttribute('aria-label', '图层编辑画布'); host.dataset.layerEditor = 'true';
    if (this.options.container) host.dataset.contained = 'true';
    const stage = document.createElement('div'); stage.className = 'mt-x-layer-stage';
    stage.style.width = `${session.image.width}px`; stage.style.height = `${session.image.height}px`;
    const base = document.createElement('img'); base.className = 'mt-x-layer-base';
    base.src = this.url(session.source); base.draggable = false; base.alt = '';
    base.style.width = `${session.image.width}px`; base.style.height = `${session.image.height}px`;
    const hover = document.createElement('img'), selection = document.createElement('img');
    for (const img of [hover, selection]) { img.className = 'mt-x-layer-highlight'; img.alt = ''; img.draggable = false; }
    selection.dataset.selected = 'true';
    const frame = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    frame.classList.add('mt-x-layer-selection'); frame.setAttribute('aria-hidden', 'true');
    const outline = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    outline.style.display = 'none'; frame.appendChild(outline);
    stage.append(base, hover, selection); host.append(stage, frame);
    const error = document.createElement('span'); error.className = 'mt-x-layer-error'; error.setAttribute('role', 'status');
    this.host = host; this.stage = stage; this.selection = selection; this.hover = hover;
    this.selectionFrame = outline;
    this.errorLine = error;
    (this.options.container ?? document.body).appendChild(host);
    this.options.ui.overlay.appendChild(error);
    // Keep the site's control anchor in its original layout while painting above the editing canvas.
    const anchor = this.options.ui.overlay.cloneNode(false) as HTMLDivElement;
    anchor.setAttribute('aria-hidden', 'true'); anchor.inert = true;
    this.options.ui.overlay.replaceWith(anchor); this.controlAnchor = anchor;
    const portal = document.createElement('div'); portal.className = 'mt-x-layer-control-portal';
    portal.dataset.theme = this.options.ui.host.closest<HTMLElement>('[data-theme]')?.dataset.theme ?? 'dark';
    portal.appendChild(this.options.ui.overlay); document.body.appendChild(portal); this.controlPortal = portal;
    this.options.ui.host.dataset.editing = 'true';
    host.addEventListener('pointerdown', this.onPointerDown); host.addEventListener('pointermove', this.onPointerMove);
    host.addEventListener('pointerleave', this.onPointerLeave); host.addEventListener('pointerup', this.onPointerUp);
    host.addEventListener('pointercancel', this.onPointerCancel); host.addEventListener('lostpointercapture', this.onPointerCancel);
    host.addEventListener('dblclick', this.onDoubleClick); host.addEventListener('keydown', this.onKeyDown);
    this.unsubscribe = session.subscribe(() => { if (session.disposed) this.unmount(); else this.updateLayers(); });
    const track = () => {
      if (!this.host) return;
      this.updateGeometry(); this.frame = window.requestAnimationFrame(track);
    };
    this.updateLayers(); track(); this.options.onChange();
  }

  private updateGeometry(): void {
    const image = this.options.getImage();
    if (!image?.isConnected || !this.session || !this.host || !this.stage) {
      if (this.host) this.host.style.visibility = 'hidden';
      if (this.controlPortal) this.controlPortal.style.visibility = 'hidden';
      return;
    }
    const surface = resolveEditingSurface(image, this.session.image); this.surface = surface;
    this.host.style.visibility = surface.width && surface.height ? '' : 'hidden';
    this.host.style.left = this.options.container ? '0px' : `${surface.left}px`;
    this.host.style.top = this.options.container ? '0px' : `${surface.top}px`;
    this.host.style.width = `${surface.width}px`; this.host.style.height = `${surface.height}px`;
    this.stage.style.transform = `translate(${surface.offsetX}px, ${surface.offsetY}px) scale(${surface.scaleX}, ${surface.scaleY})`;
    this.stage.style.setProperty('--mt-layer-glow', `${1.5 / Math.max(.01, Math.min(surface.scaleX, surface.scaleY))}px`);
    this.updateSelectionFrame();
    if (this.controlPortal) {
      const anchor = this.controlAnchor!;
      anchor.style.cssText = this.options.ui.overlay.style.cssText;
      const controls = this.controlPortal.getBoundingClientRect();
      anchor.style.width = `${controls.width}px`; anchor.style.height = `${controls.height}px`;
      anchor.style.visibility = 'hidden';
      const bounds = anchor.getBoundingClientRect();
      this.controlPortal.style.left = `${bounds.left}px`; this.controlPortal.style.top = `${bounds.top}px`;
      this.controlPortal.style.visibility = this.host.style.visibility;
    }
  }

  private prepareCoverage(layer: EditingLayer): void {
    const { image: blob, width, height } = layer.content, session = this.session;
    if (this.coverage.has(blob) || this.coverageTasks.has(blob)) return;
    this.coverageTasks.add(blob);
    void (async () => {
      const raster = await loadLayerImage(blob), canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      try {
        const ctx = canvas.getContext('2d', { willReadFrequently: true }); if (!ctx) return;
        ctx.drawImage(raster, 0, 0, width, height);
        const data = ctx.getImageData(0, 0, width, height).data, alpha = new Uint8Array(width * height);
        let left = width, top = height, right = -1, bottom = -1;
        for (let i = 0; i < alpha.length; i++) {
          alpha[i] = data[i * 4 + 3];
          if (alpha[i] <= 12) continue;
          const x = i % width, y = Math.floor(i / width);
          left = Math.min(left, x); top = Math.min(top, y);
          right = Math.max(right, x); bottom = Math.max(bottom, y);
        }
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = layer.content.kind === 'text' ? 'oklch(0.65 0.16 350)' : 'oklch(0.64 0.12 195)';
        ctx.fillRect(0, 0, width, height);
        const highlight = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (!highlight || this.disposed || session !== this.session || layer.deleted || blob !== layer.content.image) return;
        const bounds = right >= left ? { x: left, y: top, width: right - left + 1, height: bottom - top + 1 } : undefined;
        this.coverage.set(blob, { mask: { width, height, alpha }, highlight, bounds });
        const element = this.rasters.get(layer); if (element) element.dataset.hitReady = 'true';
        this.updateSelection();
      } finally { canvas.width = 0; canvas.height = 0; }
    })().catch(() => {}).finally(() => this.coverageTasks.delete(blob));
  }

  private updateLayers(): void {
    if (!this.stage || !this.session) return;
    const liveBlobs = new Set<Blob>([this.session.source]);
    for (const layer of this.session.layers) {
      let raster = this.rasters.get(layer);
      if (layer.deleted) { raster?.remove(); this.rasters.delete(layer); continue; }
      const content = this.input?.layer === layer ? this.input.content : layer.content;
      liveBlobs.add(layer.content.image); liveBlobs.add(content.image); this.prepareCoverage(layer);
      const highlight = this.coverage.get(layer.content.image)?.highlight; if (highlight) liveBlobs.add(highlight);
      if (!raster) {
        raster = document.createElement('img'); raster.className = 'mt-x-layer-raster';
        raster.draggable = false; raster.alt = ''; raster.dataset.layerId = layer.content.id;
        this.stage.insertBefore(raster, this.hover!); this.rasters.set(layer, raster);
      }
      const url = this.url(content.image);
      if (raster.src !== url) { raster.src = url; delete raster.dataset.hitReady; }
      if (this.coverage.has(layer.content.image)) raster.dataset.hitReady = 'true';
      raster.style.width = `${content.width}px`; raster.style.height = `${content.height}px`;
      const matrix = [...content.transform]; matrix[4] += layer.offsetX; matrix[5] += layer.offsetY;
      raster.style.transform = `matrix(${matrix.join(',')})`;
      raster.style.visibility = this.input?.layer === layer && this.input.preview === null ? 'hidden' : '';
    }
    for (const [blob, url] of this.urls) if (!liveBlobs.has(blob)) { URL.revokeObjectURL(url); this.urls.delete(blob); }
    for (const blob of this.coverage.keys()) if (!liveBlobs.has(blob)) this.coverage.delete(blob);
    if (this.selected?.deleted) this.selected = undefined;
    if (this.hovered?.deleted) this.hovered = undefined;
    this.updateSelection();
  }

  private showHighlight(image: HTMLImageElement | undefined, layer: EditingLayer | undefined): void {
    if (!image) return;
    const coverage = layer && this.coverage.get(layer.content.image);
    image.style.setProperty('display', coverage && !this.input ? 'block' : 'none', 'important');
    if (!layer || !coverage) return;
    image.src = this.url(coverage.highlight); image.dataset.kind = layer.content.kind; image.dataset.layerId = layer.content.id;
    image.style.width = `${layer.content.width}px`; image.style.height = `${layer.content.height}px`;
    const matrix = [...layer.content.transform]; matrix[4] += layer.offsetX; matrix[5] += layer.offsetY;
    image.style.transform = `matrix(${matrix.join(',')})`;
  }

  private updateSelection(): void {
    this.showHighlight(this.selection, this.selected);
    this.showHighlight(this.hover, this.hovered === this.selected ? undefined : this.hovered);
    this.updateSelectionFrame();
    if (this.host) {
      this.host.style.cursor = this.input ? 'text' : this.hovered?.content.kind === 'text' ? 'move' : 'default';
      this.host.title = this.hovered?.content.kind === 'text' ? '文字：点击选中，拖动移动，双击或 Enter 编辑，Delete 删除 · Alt+单击切换图层'
        : this.hovered ? '去字：点击选中后按 Delete 删除 · Alt+单击切换图层' : '';
    }
  }

  private updateSelectionFrame(): void {
    const frame = this.selectionFrame, layer = this.selected, surface = this.surface;
    if (!frame) return;
    const bounds = layer && this.coverage.get(layer.content.image)?.bounds;
    frame.style.display = layer && bounds && surface && !this.input ? '' : 'none';
    if (!layer || !bounds || !surface || this.input) return;
    const [a, b, c, d, tx, ty] = layer.content.transform;
    const ax = a * surface.scaleX, ay = b * surface.scaleY;
    const bx = c * surface.scaleX, by = d * surface.scaleY;
    const determinant = Math.abs(ax * by - ay * bx);
    if (determinant < 1e-8) { frame.style.display = 'none'; return; }
    // Keep the gap perpendicular to each edge at two screen pixels, including rotated and stretched images.
    const paddingX = SELECTION_PADDING * Math.hypot(bx, by) / determinant;
    const paddingY = SELECTION_PADDING * Math.hypot(ax, ay) / determinant;
    const left = bounds.x - paddingX, top = bounds.y - paddingY;
    const right = bounds.x + bounds.width + paddingX, bottom = bounds.y + bounds.height + paddingY;
    const points = [[left, top], [right, top], [right, bottom], [left, bottom]].map(([x, y]) =>
      `${surface.offsetX + (a * x + c * y + tx + layer.offsetX) * surface.scaleX},${surface.offsetY + (b * x + d * y + ty + layer.offsetY) * surface.scaleY}`,
    ).join(' ');
    if (frame.getAttribute('points') !== points) frame.setAttribute('points', points);
    frame.dataset.kind = layer.content.kind; frame.dataset.layerId = layer.content.id;
  }

  private point(event: MouseEvent): { x: number; y: number } | undefined {
    this.updateGeometry();
    return this.surface?.scaleX && this.surface.scaleY ? toEditingPoint(this.surface, event.clientX, event.clientY) : undefined;
  }
  private hits(point: { x: number; y: number }, tolerance = 0): EditingLayer[] {
    // Tolerance is in screen pixels, independent of the image's display scale.
    const sourceTolerance = tolerance / Math.max(.01, Math.min(this.surface?.scaleX ?? 1, this.surface?.scaleY ?? 1));
    return this.session?.layers.filter((layer) => {
      const mask = this.coverage.get(layer.content.image)?.mask;
      return !layer.deleted && mask
        && hitsLayerAlpha(mask, layer.content, layer.offsetX, layer.offsetY, point.x, point.y, sourceTolerance);
    }).reverse() ?? [];
  }

  private pickHover(point: { x: number; y: number }): EditingLayer | undefined {
    const direct = this.hits(point)[0];
    if (this.hovered?.content.kind === 'text' && (!direct || direct.content.kind === 'erase')
      && this.hits(point, 6).includes(this.hovered)) return this.hovered;
    return direct?.content.kind === 'text' ? direct : this.hits(point, 2)[0];
  }
  private setHover(layer?: EditingLayer): void {
    clearTimeout(this.hoverTimer); this.hoverTimer = undefined; this.nextHovered = undefined;
    this.hovered = layer?.deleted ? undefined : layer; this.updateSelection();
  }
  private updateHover(point: { x: number; y: number }): void {
    const layer = this.input ? undefined : this.pickHover(point);
    if (layer === this.hovered || !this.hovered || layer?.content.kind === 'text') { this.setHover(layer); return; }
    if (this.hoverTimer && layer === this.nextHovered) return;
    clearTimeout(this.hoverTimer); this.nextHovered = layer;
    // Brief gaps between glyphs do not switch the feedback to the underlying patch.
    this.hoverTimer = setTimeout(() => this.setHover(layer), 100);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest('.mt-x-layer-input'))) return;
    event.preventDefault(); event.stopPropagation(); void this.commitInput(); this.host?.focus({ preventScroll: true });
    const point = this.point(event); if (!point || !this.session) return;
    const hits = this.hits(point, 2), preferred = this.pickHover(point);
    if (preferred && !hits.includes(preferred)) hits.unshift(preferred);
    this.selected = event.altKey && hits.length ? hits[(hits.indexOf(this.selected!) + 1) % hits.length] : hits[0];
    if (!event.altKey) this.selected = preferred;
    this.setHover(this.selected);
    if (this.selected?.content.kind !== 'text' || event.altKey) return;
    this.drag = { pointerId: event.pointerId, ...point, clientX: event.clientX, clientY: event.clientY,
      offsetX: this.selected.offsetX, offsetY: this.selected.offsetY, layer: this.selected, started: false };
    this.host?.setPointerCapture(event.pointerId);
  };
  private readonly onPointerMove = (event: PointerEvent): void => {
    const point = this.point(event), drag = this.drag;
    if (!point) return;
    if (!drag) { this.updateHover(point); return; }
    if (drag.pointerId !== event.pointerId) return;
    event.preventDefault(); event.stopPropagation();
    if (!drag.started) {
      // Measure the click tolerance in screen pixels so zoom never makes a shaky click move the text.
      const dx = event.clientX - drag.clientX, dy = event.clientY - drag.clientY;
      if (dx * dx + dy * dy <= DRAG_START_DISTANCE * DRAG_START_DISTANCE) return;
      drag.started = true;
    }
    this.session?.move(drag.layer, drag.offsetX + point.x - drag.x, drag.offsetY + point.y - drag.y);
  };
  private readonly onPointerLeave = (): void => { if (!this.drag) this.setHover(); };
  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.drag?.pointerId !== event.pointerId) return;
    this.onPointerMove(event); this.drag = undefined;
    if (this.host?.hasPointerCapture(event.pointerId)) this.host.releasePointerCapture(event.pointerId);
  };
  private readonly onPointerCancel = (): void => { this.drag = undefined; };
  private readonly onDoubleClick = (event: MouseEvent): void => {
    if (event.target instanceof Element && event.target.closest('.mt-x-layer-input')) return;
    const point = this.point(event); if (!point || !this.stage || !this.session) return;
    const hits = this.hits(point, 6), layer = this.selected && hits.includes(this.selected) ? this.selected : this.pickHover(point);
    if (layer?.content.kind !== 'text') return;
    event.preventDefault(); event.stopPropagation(); this.startTextEditing(layer);
  };
  private startTextEditing(layer: EditingLayer): void {
    if (!this.stage || !this.session || layer.deleted || layer.content.kind !== 'text') return;
    void this.commitInput(); this.selected = layer; this.drag = undefined;
    this.input = new InPlaceTextEditor({ stage: this.stage, layer: layer as EditingLayer & { content: EditableTextLayer },
      targetLang: this.session.image.targetLang, render: renderBrowserTextLayer,
      onChange: () => { if (this.errorLine) this.errorLine.textContent = ''; this.updateLayers(); }, onCommit: () => { void this.commitInput(); },
      onError: (error) => this.textError(error) });
    this.updateLayers();
  }
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.input) event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (this.input) {
      if (event.key === 'Escape') {
        event.preventDefault(); const input = this.input; this.input = undefined; input.dispose();
        this.updateLayers(); this.host?.focus({ preventScroll: true });
      } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault(); void this.commitInput(); this.host?.focus({ preventScroll: true });
      }
      return;
    }
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      && this.selected?.content.kind === 'text') {
      event.preventDefault(); event.stopPropagation(); this.startTextEditing(this.selected);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && this.selected) {
      event.preventDefault(); event.stopPropagation(); this.deleteSelection();
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); this.selected = undefined; this.updateSelection();
    }
  };
  private deleteSelection(): void {
    if (this.selected && !this.input) this.session?.remove(this.selected);
    this.host?.focus({ preventScroll: true });
  }
  private textError(error: unknown): void {
    if (this.errorLine) this.errorLine.textContent = `文字更新失败：${error instanceof Error ? error.message : String(error)}`;
  }
  private async commitInput(): Promise<void> {
    const input = this.input, session = this.session; if (!input || !session) return;
    this.input = undefined; const text = input.value; input.dispose(); this.updateLayers();
    try {
      await session.editText(input.layer, text, input.previewValue === text && input.preview !== undefined
        ? async () => input.preview! : renderBrowserTextLayer);
      if (this.errorLine) this.errorLine.textContent = '';
    } catch (error) { this.textError(error); }
  }

  finish(): Promise<boolean> {
    this.suspended = true; this.suspendedMode = this.options.getState()?.mode;
    if (this.finishing) return this.finishing;
    this.finishing = this.finishEditing().finally(() => { this.finishing = undefined; }); return this.finishing;
  }
  private async finishEditing(): Promise<boolean> {
    await this.commitInput();
    const state = this.options.getState(), session = state?.layerEditing; if (!state || !session?.active) return true;
    try {
      while (session.pending.size) await Promise.allSettled([...session.pending]);
      if (session.disposed) return false;
      if (session.revision !== session.appliedRevision) {
        const revision = session.revision, canvas = document.createElement('canvas');
        canvas.width = session.image.width; canvas.height = session.image.height;
        try {
          const context = canvas.getContext('2d'); if (!context) throw new Error('无法合成译图');
          const source = await loadLayerImage(session.source); context.drawImage(source, 0, 0, canvas.width, canvas.height);
          const layers = session.layers.filter((layer) => !layer.deleted).map((layer) => ({ ...layer }));
          const rasters = await Promise.all(layers.map((layer) => loadLayerImage(layer.content.image)));
          layers.forEach((layer, index) => {
            const matrix = [...layer.content.transform]; matrix[4] += layer.offsetX; matrix[5] += layer.offsetY;
            context.setTransform(...matrix as [number, number, number, number, number, number]); context.drawImage(rasters[index], 0, 0);
          });
          const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('生成译图失败')), 'image/png'));
          if (session.disposed || this.disposed || state.layerEditing !== session) return false;
          if (session.revision !== revision || session.pending.size || this.input) return this.finishEditing();
          const url = URL.createObjectURL(blob); if (state.translatedUrl) URL.revokeObjectURL(state.translatedUrl);
          state.translatedUrl = url; session.appliedRevision = revision;
        } finally { canvas.width = 0; canvas.height = 0; }
      }
      session.active = false; this.unmount(); this.options.onChange(); return true;
    } catch (error) {
      if (this.errorLine) this.errorLine.textContent = `保存修改失败：${error instanceof Error ? error.message : String(error)}`;
      return false;
    }
  }

  private unmount(): void {
    if (!this.host) return;
    this.drag = undefined; const input = this.input; this.input = undefined; input?.dispose();
    clearTimeout(this.hoverTimer); this.hoverTimer = undefined; this.nextHovered = undefined;
    if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
    this.frame = undefined; this.unsubscribe?.(); this.unsubscribe = undefined;
    this.host.remove(); this.errorLine?.remove();
    if (this.controlPortal) { this.controlAnchor?.replaceWith(this.options.ui.overlay); this.controlPortal.remove(); this.controlPortal = undefined; }
    this.controlAnchor = undefined;
    this.host = undefined; this.stage = undefined; this.selection = undefined; this.selectionFrame = undefined; this.hover = undefined;
    this.errorLine = undefined; this.selected = undefined; this.hovered = undefined; this.session = undefined;
    this.rasters.clear(); this.coverage.clear(); this.coverageTasks.clear();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear(); delete this.options.ui.host.dataset.editing;
    this.releaseProtection?.(); this.releaseProtection = undefined;
  }
  dispose(): void {
    if (this.disposed) return;
    void this.commitInput(); this.disposed = true; this.stopPreference(); this.unmount();
  }
}
