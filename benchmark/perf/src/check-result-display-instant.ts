import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Tiny DOM API gate exercises the actual constructor and render functions.
// Native CSS/paint/decode speed and final computed styles remain Root's gate.
const path = '../../../apps/extension/src/content/core/ui/screenshotOverlay.ts';
const source = readFileSync(new URL(path, import.meta.url), 'utf8');
const ast = ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true);
const names = ['setRectStyle', 'createScreenshotResultUi', 'renderScreenshotResultUi'];
const functions = ast.statements.filter(ts.isFunctionDeclaration).filter(node => names.includes(node.name!.text));
if (functions.length !== names.length) throw new Error('Actual overlay function source changed');
const code = ts.transpileModule(functions.map(node => node.getText(ast)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^export\s+/gm, '');

class Element {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  className = '';
  alt = '';
  title = '';
  type = '';
  draggable = true;
  children: Element[] = [];
  srcWrites: string[] = [];
  constructor(public tag: string) {}
  get src(): string { return this.srcWrites.at(-1) ?? ''; }
  set src(value: string) { this.srcWrites.push(value); }
  appendChild(child: Element): void { this.children.push(child); }
}
type Ui = {
  host: Element; image: Element; closeButton: Element; primaryAction: Element; overlayPositioned: boolean;
};
const overlay = new Function('document', 'createUiElements', 'createIcon', 'renderUi',
  'positionScreenshotResultOverlay', 'syncScreenshotResultOverlayPosition', `${code}
    return { createScreenshotResultUi, renderScreenshotResultUi };`)(
  { createElement: (tag: string) => new Element(tag) },
  () => ({ host: new Element('div'), primaryAction: new Element('div') }),
  () => new Element('span'), () => {}, () => true, () => {},
) as {
  createScreenshotResultUi(rect: { left: number; top: number; width: number; height: number }): Ui;
  renderScreenshotResultUi(ui: Ui, state: { originalUrl: string; translatedUrl?: string; status: string }): void;
};
const root = globalThis as { __shinobuColdStartResultDisplayInstant?: unknown };
const oldFlag = root.__shinobuColdStartResultDisplayInstant;
const rect = { left: 11, top: 23, width: 720, height: 1009 };
const states = [
  { originalUrl: 'blob:http://example/original', status: 'running' },
  { originalUrl: 'blob:http://example/original', translatedUrl: 'blob:http://example/translated', status: 'translated' },
  { originalUrl: 'blob:http://example/original', translatedUrl: 'blob:http://example/translated', status: 'translated' },
  { originalUrl: 'blob:http://example/original', translatedUrl: 'blob:http://example/translated', status: 'showingOriginal' },
  { originalUrl: 'blob:http://example/original', translatedUrl: 'blob:http://example/second', status: 'translated' },
];
function run(flag: unknown) {
  root.__shinobuColdStartResultDisplayInstant = flag;
  const ui = overlay.createScreenshotResultUi(rect), snapshots = [];
  for (const state of states) {
    overlay.renderScreenshotResultUi(ui, state);
    snapshots.push({ rectStyle: { ...ui.host.style }, dataset: { ...ui.host.dataset }, src: ui.image.src,
      srcWrites: [...ui.image.srcWrites], className: ui.host.className, alt: ui.image.alt, draggable: ui.image.draggable,
      imageStyle: Object.fromEntries(Object.entries(ui.image.style).filter(([key]) => key !== 'transition')),
      hostChildren: ui.host.children.map(child => child.tag), closeTitle: ui.closeButton.title });
  }
  assert.deepEqual(ui.image.srcWrites, ['blob:http://example/original', 'blob:http://example/translated',
    'blob:http://example/original', 'blob:http://example/second']);
  assert.deepEqual(ui.host.style, { left: '11px', top: '23px', width: '720px', height: '1009px' });
  assert.equal(ui.image.style.transition, flag === true ? 'none' : undefined);
  return snapshots;
}
try {
  const baseline = run(undefined);
  for (const flag of [false, true, 'true', 1, null]) assert.deepEqual(run(flag), baseline);
  console.log(JSON.stringify({ result: 'actual overlay constructor/render DOM API gate passed', flags: 6, statesPerFlag: states.length,
    caveat: 'Only transition inline config changes when strict true; no native CSS/PNG/paint/decode speed claim.' }));
} finally {
  if (oldFlag === undefined) delete root.__shinobuColdStartResultDisplayInstant;
  else root.__shinobuColdStartResultDisplayInstant = oldFlag;
}
