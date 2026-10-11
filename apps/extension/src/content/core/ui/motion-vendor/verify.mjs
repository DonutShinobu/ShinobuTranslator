import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Window } from 'happy-dom';
import * as kit from './motion-kit.js';

// Verify the delivered file, not the installed packages.
for (const name of ['createMorph', 'canonicalD', 'TextMorph', 'MorphController', 'segmentText', 'diffSegments']) {
  assert.equal(typeof kit[name], 'function', name + ' is exported');
}
const source = await readFile(new URL('motion-kit.js', import.meta.url));
const manifest = JSON.parse(await readFile(new URL('manifest.json', import.meta.url), 'utf8'));
assert.equal(createHash('sha256').update(source).digest('hex'), manifest.sha256);
assert.equal(source.toString().includes('Copyright (c) 2025 Lochie Axon'), true);
assert.equal(source.toString().includes('Copyright (c) 2026 Guillermo'), true);
assert.equal(/^\s*import\s/m.test(source.toString()), false, 'No runtime external imports');

// Chinese and emoji use Intl.Segmenter; repeated characters keep distinct IDs.
const oldSegments = kit.segmentText('翻译中', 'zh-CN', false);
const nextSegments = kit.diffSegments(oldSegments, '翻译完成', 'zh-CN', { numbers: false }).segments;
for (const char of ['翻', '译']) {
  assert.equal(nextSegments.find(s => s.string === char).id, oldSegments.find(s => s.string === char).id);
}
const repeat = kit.segmentText('翻翻译译', 'zh-CN', false);
assert.equal(new Set(repeat.map(s => s.id)).size, repeat.length);
assert.deepEqual(kit.segmentText('翻译👩‍💻', 'zh-CN', false).map(s => s.string), ['翻', '译', '👩‍💻']);

// Deterministic rAF advances the real morphicons DOM driver over an SVG-like target.
const frames = new Map();
let nextFrameId = 0;
globalThis.requestAnimationFrame = callback => {
  const id = ++nextFrameId;
  frames.set(id, callback);
  return id;
};
globalThis.cancelAnimationFrame = id => frames.delete(id);
const advance = time => {
  const pending = Array.from(frames.values());
  frames.clear();
  pending.forEach(callback => callback(time));
};
const values = {};
const target = { setAttribute(name, value) { values[name] = value; } };
const first = 'M4 12H20 M12 4V20';
const second = 'M5 5L19 19 M19 5L5 19';
const third = 'M5 12L10 17L19 7';
const icon = kit.createMorph(target, first, { reducedMotion: 'never' });
assert.equal(values.d, first);
icon.morphTo(second, { stiffness: 400, damping: 40 });
advance(0);
advance(16);
advance(32);
advance(48);
const interrupted = values.d;
assert.notEqual(interrupted, first);
assert.notEqual(interrupted, second);
icon.morphTo(third, { stiffness: 400, damping: 40 });
assert.equal(values.d, interrupted, 'retarget does not jump to a canonical endpoint');
advance(64);
assert.notEqual(values.d, third, 'retarget remains animated');
icon.set(first);
assert.equal(values.d, first);
assert.equal(frames.size, 0);
icon.seek(second, 0.5);
assert.notEqual(values.d, first);
assert.notEqual(values.d, second);
icon.destroy();
assert.equal(frames.size, 0);

// Happy DOM checks real Torph synchronous node identity and accessible text.
// This does not assert browser layout or compositor timing.
const window = new Window();
for (const name of ['document', 'HTMLElement', 'Element', 'Node']) globalThis[name] = window[name];
globalThis.window = window;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
globalThis.matchMedia = window.matchMedia.bind(window);
// Happy DOM creates an eager finished Promise; observe its expected cancellation.
// Keep the native Happy DOM animation object and driver behavior intact.
const domAnimate = window.Element.prototype.animate;
window.Element.prototype.animate = function (...args) {
  const animation = domAnimate.apply(this, args);
  animation.finished.catch(error => {
    if (error.name !== 'AbortError') throw error;
  });
  return animation;
};
const label = window.document.createElement('span');
window.document.body.append(label);
const text = new kit.TextMorph({
  element: label, duration: 340, ease: 'cubic-bezier(0.19, 1, 0.22, 1)',
  locale: 'zh-CN', scale: false, numbers: false, respectReducedMotion: false,
});
const active = () => Array.from(label.querySelectorAll('[torph-item][torph-id]:not([torph-exiting])'));
text.update('翻译中');
const before = new Map(active().map(node => [node.textContent, node]));
assert.equal(active().length, 3);
text.update('翻译完成');
for (const char of ['翻', '译']) {
  assert.equal(active().find(node => node.textContent === char), before.get(char), char + ' keeps its DOM node');
}
assert.equal(label.querySelector('[torph-sr]').textContent, '翻译完成');
text.update('翻译失败');
for (const char of ['翻', '译']) {
  assert.equal(active().find(node => node.textContent === char), before.get(char), char + ' survives interruption');
}
assert.equal(active().length, 4);
assert.equal(new Set(active().map(node => node.getAttribute('torph-id'))).size, 4);
text.update('文字识别中');
const chinese = new Map(active().map(node => [node.textContent, node]));
text.update('翻译中 | 去字中');
for (const char of ['字', '中']) assert(active().includes(chinese.get(char)), char + ' survives spaces in a parallel label');
assert.equal(active().length, 9);
assert(active().every(node => Array.from(new Intl.Segmenter('zh-CN', { granularity: 'grapheme' }).segment(node.textContent)).length === 1));
text.update('Gemini 3.1 Flash Image Preview 全图翻译中');
const mixed = active().find(node => node.textContent === '中');
text.update('文字排版中');
assert(active().includes(mixed), 'mixed Latin/Chinese labels preserve shared glyphs');
text.update('文本检测中');
text.update('文字识别中');
const entering = active().find(node => node.textContent === '字');
// Happy DOM does not composite WAAPI; the computed opacity is the retarget input.
entering.style.opacity = '0';
text.update('文字排版中');
assert(active().includes(entering), 'a zero-opacity shared glyph retains its node');
assert(entering.getAnimations().some(animation => animation.effect.getKeyframes().some(frame => Number(frame.opacity) === 0)), 'retarget preserves exactly zero opacity');
text.destroy();
assert.equal(label.hasAttribute('torph-root'), false);
assert.equal(label.querySelector('[torph-sr]'), null);
const quietLabel = window.document.createElement('span');
const quiet = new kit.TextMorph({ element: quietLabel, disabled: true, locale: 'zh-CN', numbers: false });
quiet.update('翻译完成');
assert.equal(quietLabel.textContent, '翻译完成');
assert.equal(quietLabel.querySelector('[torph-id]'), null);
quiet.destroy();
await window.happyDOM.abort();
console.log('Verified delivered ESM, licenses, Chinese/emoji IDs, live text node reuse, icon retarget/seek/cleanup, and disabled text.');
