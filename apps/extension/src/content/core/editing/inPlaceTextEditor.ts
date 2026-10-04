import type { EditableTextLayer } from '@shinobu/image-pipeline/editor';
import { Schema, Slice } from 'prosemirror-model';
import { EditorState, Plugin, PluginKey, TextSelection } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { closeHistory, history, undo, redo } from 'prosemirror-history';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap, selectAll } from 'prosemirror-commands';
import type { EditingLayer, TextLayerRenderer } from './layerEditingState';
import { loadBrowserTypesetFonts } from './browserLayerRenderer';

type Options = {
  stage: HTMLElement;
  layer: EditingLayer & { content: EditableTextLayer };
  targetLang: string;
  render: TextLayerRenderer;
  onChange(): void;
  onCommit(): void;
  onError(error: unknown): void;
};

const schema = new Schema({ nodes: { doc: { content: 'text*', whitespace: 'pre' }, text: {} } });
const geometry = new PluginKey<DecorationSet>('imageTextGeometry');

/** ProseMirror owns native input and selection; the image typesetter owns every visible glyph. */
export class InPlaceTextEditor {
  readonly element = document.createElement('div');
  readonly layer: Options['layer'];
  preview: EditableTextLayer | null | undefined;
  previewValue: string;
  private readonly view: EditorView;
  private disposed = false;
  private composing = false;
  private commitAfterComposition = false;
  private generation = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private compositionTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: Options) {
    this.layer = options.layer; this.previewValue = this.layer.content.region.translatedText;
    const doc = schema.nodes.doc.create(null, this.previewValue ? schema.text(this.previewValue) : undefined);
    this.element.className = 'mt-x-layer-input';
    options.stage.append(this.element); this.applyGeometry(this.layer.content);
    this.view = new EditorView({ mount: this.element }, {
      state: EditorState.create({ doc, selection: TextSelection.create(doc, doc.content.size), plugins: [
        new Plugin<DecorationSet>({ key: geometry,
          state: {
            init: () => this.decorations(this.layer.content, doc),
            apply: (transaction, decorations) => transaction.getMeta(geometry) ?? decorations.map(transaction.mapping, transaction.doc),
          },
          props: { decorations: (state) => geometry.getState(state) },
        }),
        history(),
        keymap({ 'Mod-z': undo, 'Mod-Shift-z': redo, 'Mod-y': redo,
          'Mod-a': (state, dispatch) => selectAll(state, (transaction) => dispatch?.(closeHistory(transaction))),
          Enter: (state, dispatch) => { dispatch?.(state.tr.insertText('\n')); return true; } }),
        keymap(baseKeymap),
      ] }),
      attributes: { role: 'textbox', 'aria-label': '编辑文字', 'aria-multiline': 'true', spellcheck: 'false' },
      clipboardTextParser: (text) => new Slice(schema.nodes.doc.create(null, text ? schema.text(text) : undefined).content, 0, 0),
      handlePaste: (view, event) => {
        const text = event.clipboardData?.getData('text/plain'); if (text === undefined) return false;
        view.dispatch(closeHistory(view.state.tr.insertText(text.replace(/\r\n?/g, '\n')))); return true;
      },
      handleDOMEvents: { beforeinput: (view, event) => {
        const input = event as InputEvent;
        if (!input.isComposing && input.inputType === 'insertText' && input.data?.includes('\n')) {
          event.preventDefault(); view.dispatch(view.state.tr.insertText(input.data)); return true;
        }
        return false;
      } },
      dispatchTransaction: (transaction) => {
        this.view.updateState(this.view.state.apply(transaction));
        if (transaction.docChanged || transaction.getMeta(geometry)) this.positionGlyphs();
        if (transaction.docChanged) this.schedulePreview();
      },
    });
    this.positionGlyphs();
    this.element.addEventListener('compositionstart', () => { this.composing = true; });
    this.element.addEventListener('compositionend', () => {
      this.composing = false;
      // Give ProseMirror's DOM observer the completed IME text before reprojecting or committing.
      this.compositionTimer = setTimeout(() => {
        if (this.disposed) return;
        this.schedulePreview();
        if (this.commitAfterComposition) options.onCommit();
      }, 0);
    });
    this.element.addEventListener('blur', () => {
      if (this.disposed) return;
      if (this.composing) this.commitAfterComposition = true;
      else options.onCommit();
    });
    // Native selection remains usable without dragging the containing screenshot.
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'dblclick']) {
      this.element.addEventListener(type, (event) => event.stopPropagation());
    }
    this.view.focus();
    void loadBrowserTypesetFonts(options.targetLang).then(() => {
      if (this.disposed) return;
      if (!this.composing && this.value === this.content.region.translatedText) {
        this.view.dispatch(this.view.state.tr.setMeta(geometry, this.decorations(this.content, this.view.state.doc)));
      }
    }).catch((error) => { if (!this.disposed) options.onError(error); });
  }

  get value(): string { return this.view.state.doc.textContent; }
  get content(): EditableTextLayer { return this.preview ?? this.layer.content; }

  private decorations(content: EditableTextLayer, doc: EditorState['doc']): DecorationSet {
    const layout = content.layout; if (!layout) return DecorationSet.empty;
    const context = document.createElement('canvas').getContext('2d');
    if (!context) return DecorationSet.empty;
    context.font = `700 ${layout.fontSize}px ${layout.fontFamily}`;
    const vertical = layout.direction === 'v', size = layout.fontSize;
    const boxes = layout.glyphs.filter((glyph) => glyph.end > glyph.start && glyph.end <= doc.content.size).map((glyph) => {
      const metrics = context.measureText(doc.textBetween(glyph.start, glyph.end));
      const width = glyph.width, height = vertical ? glyph.height : size;
      const y = !vertical && glyph.baselineY !== undefined
        ? glyph.baselineY - (size + (metrics.fontBoundingBoxAscent || size * .8) - (metrics.fontBoundingBoxDescent || size * .2)) / 2
        : glyph.y - height / 2;
      return { start: glyph.start, end: glyph.end, x: glyph.x - width / 2, y, width, height,
        spacing: vertical ? height - size : 0 };
    });
    type Box = typeof boxes[number];
    // Whitespace omitted by typesetting still needs a native caret position beside its neighboring ink.
    const missing: Box[] = [];
    let from = 0, previous: Box | undefined;
    const gaps = [...boxes, { start: doc.content.size, end: doc.content.size }];
    for (const next of gaps) {
      if (next.start > from) {
        const text = doc.textBetween(from, next.start), following = 'x' in next ? next : undefined;
        for (const { segment, index } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) {
          const newline = /[\r\n]/u.test(segment), anchor = following ?? previous ?? boxes[0]; if (!anchor) continue;
          const x = vertical ? following?.x ?? (newline ? anchor.x - size * 1.2 : anchor.x)
            : following ? following.x - (newline ? 0 : text.length - index) : newline ? boxes[0].x : anchor.x + anchor.width + index;
          const y = vertical ? following ? following.y - (newline ? 0 : text.length - index) : newline ? boxes[0].y : anchor.y + anchor.height + index
            : following?.y ?? (newline ? anchor.y + size * 1.2 : anchor.y);
          missing.push({ start: from + index, end: from + index + segment.length,
            x: x + (vertical && newline ? size : 0), y: y - (!vertical && newline ? size : 0),
            width: vertical ? size : newline ? 0 : 1, height: vertical ? newline ? 0 : 1 : size,
            spacing: newline ? 0 : vertical ? 1 - size : 1 - context.measureText(segment).width });
        }
      }
      from = next.end; if ('x' in next) previous = next;
    }
    return DecorationSet.create(doc, [...boxes, ...missing].map((box) => Decoration.inline(box.start, box.end, {
      class: 'mt-x-layer-glyph', 'data-x': String(box.x), 'data-y': String(box.y),
      style: `width:${box.width}px;height:${box.height}px;line-height:${size}px;letter-spacing:${box.spacing}px`,
    }, { inclusiveEnd: true })));
  }

  private positionGlyphs(): void {
    // Relative inline boxes preserve native dragging and selection across positioned characters.
    const glyphs = [...this.element.querySelectorAll<HTMLElement>('.mt-x-layer-glyph')];
    for (const glyph of glyphs) { glyph.style.left = '0px'; glyph.style.top = '0px'; }
    const positions = glyphs.map((glyph) => ({ x: glyph.offsetLeft, y: glyph.offsetTop }));
    glyphs.forEach((glyph, index) => {
      glyph.style.left = `${Number(glyph.dataset.x) - positions[index].x}px`;
      glyph.style.top = `${Number(glyph.dataset.y) - positions[index].y}px`;
    });
  }

  private applyGeometry(content: EditableTextLayer): void {
    const { element } = this, layout = content.layout;
    element.style.width = `${content.width}px`; element.style.height = `${content.height}px`;
    element.style.fontFamily = layout?.fontFamily ?? '"MTX-SourceHanSans-CN", sans-serif';
    element.style.fontSize = `${layout?.fontSize ?? content.region.fontSize ?? 24}px`; element.style.fontWeight = '700';
    element.style.lineHeight = '1';
    element.style.setProperty('--mt-layer-caret', layout?.color ?? `rgb(${(content.region.fgColor ?? [35, 30, 33]).join(',')})`);
    element.style.writingMode = (layout?.direction ?? content.region.direction) === 'v' ? 'vertical-rl' : 'horizontal-tb';
    const matrix = [...content.transform]; matrix[4] += this.layer.offsetX; matrix[5] += this.layer.offsetY;
    element.style.transform = `matrix(${matrix.join(',')})`;
  }

  private schedulePreview(): void {
    const generation = ++this.generation; clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.renderPreview(generation); }, 16);
  }

  private async renderPreview(generation: number): Promise<void> {
    const value = this.value;
    try {
      const region = structuredClone(this.layer.content.region); region.translatedText = value;
      if (value !== this.layer.content.region.translatedText) region.translatedColumns = undefined;
      const preview = value === this.layer.content.region.translatedText ? this.layer.content
        : value.trim() ? await this.options.render(region, this.options.targetLang) : null;
      if (this.disposed || generation !== this.generation) return;
      this.preview = preview; this.previewValue = value;
      if (!this.composing) {
        if (preview) this.applyGeometry(preview);
        this.view.dispatch(this.view.state.tr.setMeta(geometry, this.decorations(this.content, this.view.state.doc)));
      }
      this.element.dataset.renderedText = value; this.options.onChange();
    } catch (error) { if (!this.disposed && generation === this.generation) this.options.onError(error); }
  }

  dispose(): void {
    this.disposed = true; this.generation++; clearTimeout(this.timer); clearTimeout(this.compositionTimer);
    this.view.destroy(); this.element.remove();
  }
}
