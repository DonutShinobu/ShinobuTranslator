import { ImageLayerEditor } from '../../apps/extension/src/content/core/editing/imageLayerEditor';
import { LayerEditingState } from '../../apps/extension/src/content/core/editing/layerEditingState';
import { createInitialPhotoState } from '../../apps/extension/src/content/core/state/photoStateStore';
import { createUiElements, renderUi } from '../../apps/extension/src/content/core/ui/imageControls';
import { createScreenshotResultUi, renderScreenshotResultUi } from '../../apps/extension/src/content/core/ui/screenshotOverlay';
import { attachScreenshotResultDrag, attachScreenshotResultZoom } from '../../apps/extension/src/content/core/screenshot/overlayInteraction';
import { injectStyles } from '../../apps/extension/src/content/core/ui/styles';
import type { EditableImage, EditableTextLayer } from '@shinobu/image-pipeline/editor';
import type { ExtensionBrowserApi } from '../../apps/extension/src/shared/extensionRuntime';
import { renderBrowserTextLayer } from '../../apps/extension/src/content/core/editing/browserLayerRenderer';

async function blob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve) => canvas.toBlob((value) => resolve(value!), 'image/png'));
}
function canvas(width: number, height: number, color: string): HTMLCanvasElement {
  const element = document.createElement('canvas'); element.width = width; element.height = height;
  const context = element.getContext('2d')!; context.fillStyle = color; context.fillRect(0, 0, width, height);
  return element;
}
function quad(x: number, y: number, w: number, h: number): EditableTextLayer['quad'] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
}

async function run(): Promise<void> {
  (globalThis as typeof globalThis & { chrome: ExtensionBrowserApi }).chrome = { runtime: { getURL: (path) => `/${path}` } };
  injectStyles();
  const sourceCanvas = canvas(800, 480, '#faf8f9');
  const sourceContext = sourceCanvas.getContext('2d')!; sourceContext.fillStyle = '#b82c3a'; sourceContext.fillRect(100, 100, 140, 100);
  const source = await blob(sourceCanvas), originalUrl = URL.createObjectURL(source);
  const patch = await blob(canvas(140, 100, '#faf8f9'));
  const textCanvas = canvas(110, 75, 'transparent'), context = textCanvas.getContext('2d')!;
  context.fillStyle = '#16804a'; context.fillRect(0, 0, 110, 75);
  const doc: EditableImage = { width: 800, height: 480, targetLang: 'zh-CN', layers: [
    { id: 'erase:r1', regionId: 'r1', kind: 'erase', image: patch, width: 140, height: 100,
      transform: [1, 0, 0, 1, 100, 100], quad: quad(100, 100, 140, 100) },
    { id: 'text:r1', regionId: 'r1', kind: 'text', image: await blob(textCanvas), width: 110, height: 75,
      transform: [1, 0, 0, 1, 120, 115], quad: quad(120, 115, 110, 75),
      region: { id: 'r1', box: { x: 120, y: 115, width: 110, height: 75 }, sourceText: '原文', translatedText: '译文', direction: 'h', fontSize: 24 } },
  ] };
  const params = new URLSearchParams(location.search);
  if (params.has('real')) {
    const text = doc.layers[1] as EditableTextLayer;
    text.region.translatedText = params.get('value') ?? text.region.translatedText;
    text.region.direction = params.get('direction') === 'v' ? 'v' : 'h';
    text.region.fgColor = [22, 128, 74];
    if (params.has('profile')) {
      text.region.box = { x: 120, y: 100, width: 240, height: 260 };
      text.region.sourceText = '原文前一行\n原文后\n原文'; text.region.originalLineCount = 3;
      text.region.translatedText = params.get('value') ?? '停一下，ABC 12!\n第二行文本！\n最后一行🙂';
      text.region.translatedColumns = text.region.translatedText.split('\n');
      text.region.sourceLineGeometries = ['原文前一行', '原文后', '原文'].map((value, index) => {
        const vertical = text.region.direction === 'v';
        const box = vertical ? { x: 328 - index * 60, y: [112, 143, 127][index], width: 26, height: [216, 170, 192][index] }
          : { x: [128, 167, 144][index], y: 120 + index * 68, width: [212, 140, 174][index], height: 28 };
        return { text: value, direction: text.region.direction!, box, centerX: box.x + box.width / 2,
          centerY: box.y + box.height / 2, width: box.width, height: box.height, fontSize: 24 };
      });
    }
    if (params.has('rotated')) text.region.quad = quad(text.region.box.x, text.region.box.y, text.region.box.width, text.region.box.height).map((point) => {
      const cx = text.region.box.x + text.region.box.width / 2, cy = text.region.box.y + text.region.box.height / 2;
      const dx = point.x - cx, dy = point.y - cy, angle = .3;
      return { x: cx + dx * Math.cos(angle) - dy * Math.sin(angle), y: cy + dx * Math.sin(angle) + dy * Math.cos(angle) };
    }) as EditableTextLayer['quad'];
    doc.layers[1] = (await renderBrowserTextLayer(text.region, 'zh-CN'))!;
  }
  const translatedCanvas = canvas(800, 480, 'transparent'), translatedContext = translatedCanvas.getContext('2d')!;
  translatedContext.drawImage(sourceCanvas, 0, 0);
  for (const layer of doc.layers) {
    const raster = new Image(), url = URL.createObjectURL(layer.image); raster.src = url; await raster.decode();
    translatedContext.setTransform(...layer.transform); translatedContext.drawImage(raster, 0, 0); URL.revokeObjectURL(url);
  }
  const state = createInitialPhotoState(originalUrl);
  state.status = 'translated'; state.mode = 'translated'; state.translatedUrl = URL.createObjectURL(await blob(translatedCanvas));
  state.layerEditing = new LayerEditingState(doc, source);
  const screenshot = location.pathname === '/screenshot';
  const screenshotUi = screenshot ? createScreenshotResultUi({ left: 30, top: 100, width: 400, height: 240 }) : undefined;
  const ui = screenshotUi ?? createUiElements();
  const image = screenshotUi?.image ?? new Image();
  image.src = originalUrl; image.draggable = false;
  if (!screenshot) {
    image.style.cssText = 'position:absolute;left:30px;top:100px;width:400px;height:240px;object-fit:contain';
    document.body.appendChild(image);
    // Site adapters anchor their controls inside the image's stacking context.
    ui.host.style.cssText = 'position:absolute;right:calc(100vw - 418px);top:112px;z-index:20';
  }
  document.body.appendChild(ui.host); await image.decode();
  let editor: ImageLayerEditor;
  let editingEnabled = !params.has('disabled');
  const render = () => {
    if (screenshotUi) renderScreenshotResultUi(screenshotUi, state);
    else { renderUi(ui, state); image.src = state.layerEditing?.active || state.mode === 'original' ? originalUrl : state.translatedUrl!; }
    editor?.sync();
  };
  const options = { ui, getState: () => state, getImage: () => image, getEnabled: () => editingEnabled, onChange: render,
    ...(screenshot ? { container: ui.host } : {}) };
  editor = new ImageLayerEditor(options);
  const detach = screenshotUi ? [attachScreenshotResultDrag(screenshotUi), attachScreenshotResultZoom(screenshotUi, render)] : [];
  ui.button.addEventListener('click', async () => {
    if (state.layerEditing?.active && !(await editor.finish())) return;
    state.mode = state.mode === 'translated' ? 'original' : 'translated';
    state.status = state.mode === 'translated' ? 'translated' : 'showingOriginal'; render();
  });
  render();
  let resumeComposition: (() => void) | undefined;
  let resumeTextEncoding: (() => void) | undefined;
  Object.assign(window, { layerFixture: {
    state, image, ui,
    async hitPoints() {
      const layer = state.layerEditing!.layers[1].content;
      const raster = new Image(), url = URL.createObjectURL(layer.image); raster.src = url; await raster.decode();
      const c = canvas(layer.width, layer.height, 'transparent').getContext('2d')!; c.drawImage(raster, 0, 0); URL.revokeObjectURL(url);
      const pixels = c.getImageData(0, 0, layer.width, layer.height).data;
      const [a, b, cc, d, tx, ty] = layer.transform;
      const toPoint = (x: number, y: number) => {
        const stage = document.querySelector('.mt-x-layer-stage')!.getBoundingClientRect();
        return { x: stage.left + (a * x + cc * y + tx) * stage.width / 800,
          y: stage.top + (b * x + d * y + ty) * stage.height / 480 };
      };
      let ink: { x: number; y: number } | undefined, empty: { x: number; y: number } | undefined, gap: { x: number; y: number } | undefined;
      const nearInk = (x: number, y: number, radius: number) => {
        for (let py = Math.max(0, y - radius); py <= Math.min(layer.height - 1, y + radius); py++)
          for (let px = Math.max(0, x - radius); px <= Math.min(layer.width - 1, x + radius); px++)
            if (pixels[(py * layer.width + px) * 4 + 3] > 12) return true;
        return false;
      };
      for (let y = 2; y < layer.height - 2; y++) for (let x = 2; x < layer.width - 2; x++) {
        const alpha = pixels[(y * layer.width + x) * 4 + 3];
        if (!ink && alpha > 240) ink = toPoint(x + .5, y + .5);
        if (alpha === 0 && a * x + cc * y + tx > 102 && a * x + cc * y + tx < 238
          && b * x + d * y + ty > 102 && b * x + d * y + ty < 198) {
          if (!empty && !nearInk(x, y, 8)) empty = toPoint(x + .5, y + .5);
          if (!gap && nearInk(x, y, 2)) gap = toPoint(x + .5, y + .5);
        }
      }
      // An uncovered point of the repair patch also works for very tightly fitted text sprites.
      const determinant = a * d - b * cc, dx = 103 - tx, dy = 103 - ty;
      return { ink: ink!, empty: empty ?? toPoint((d * dx - cc * dy) / determinant, (a * dy - b * dx) / determinant), gap: gap! };
    },
    async setEditing(enabled: boolean) {
      editingEnabled = enabled;
      if (!enabled) await editor.finish();
      render();
    },
    rebind() {
      editor.dispose(); ui.host.remove();
      if (!screenshot) { image.remove(); document.body.appendChild(image); }
      document.body.appendChild(ui.host); editor = new ImageLayerEditor(options); render();
    },
    dispose() { editor.dispose(); state.layerEditing?.dispose(); detach.forEach((fn) => fn()); ui.host.remove(); },
    pauseComposition() {
      const encode = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
        if (this.width === 800 && this.height === 480) {
          HTMLCanvasElement.prototype.toBlob = encode;
          resumeComposition = () => { encode.call(this, callback, ...args); resumeComposition = undefined; };
        } else encode.call(this, callback, ...args);
      };
    },
    compositionPaused: () => Boolean(resumeComposition),
    releaseComposition: () => resumeComposition?.(),
    pauseTextEncoding() {
      const encode = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function(callback, ...args) {
        if (this.width > 1 && this.height > 1 && this.width !== 800) {
          HTMLCanvasElement.prototype.toBlob = encode;
          resumeTextEncoding = () => { encode.call(this, callback, ...args); resumeTextEncoding = undefined; };
        } else encode.call(this, callback, ...args);
      };
    },
    textEncodingPaused: () => Boolean(resumeTextEncoding),
    releaseTextEncoding: () => resumeTextEncoding?.(),
    async pixel(x: number, y: number) {
      const raster = new Image(); raster.src = state.translatedUrl!; await raster.decode();
      const c = canvas(800, 480, 'transparent').getContext('2d')!; c.drawImage(raster, 0, 0);
      return [...c.getImageData(x, y, 1, 1).data];
    },
    async renderedDirections() {
      const counts: number[] = [];
      for (const direction of ['h', 'v'] as const) {
        const result = await renderBrowserTextLayer({ ...(doc.layers[1] as EditableTextLayer).region, direction }, 'zh-CN');
        const img = new Image(); img.src = URL.createObjectURL(result!.image); await img.decode();
        const c = canvas(img.width, img.height, 'transparent').getContext('2d')!; c.drawImage(img, 0, 0);
        counts.push(c.getImageData(0, 0, img.width, img.height).data.filter((value, index) => index % 4 === 3 && value > 0).length);
        URL.revokeObjectURL(img.src);
      }
      return counts;
    },
  } });
}
void run();
