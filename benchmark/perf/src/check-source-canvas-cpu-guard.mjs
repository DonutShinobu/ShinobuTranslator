import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../../../packages/image-pipeline/src/pipeline/image.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('image.ts', source, ts.ScriptTarget.ES2022, true);
const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === 'imageToCanvas');
assert(node);
const originalFunction = node.getText(ast).replace(/^export\s+/, '');
const token = 'const ctx = canvas.getContext("2d");';
assert.equal(originalFunction.split(token).length, 2, 'exact context token must occur once');
const candidateFunction = originalFunction.replace(token,
  'const ctx = (globalThis as { __shinobuColdStartSourceCanvasCpu?: boolean }).__shinobuColdStartSourceCanvasCpu === true'
    + ' ? canvas.getContext("2d", { willReadFrequently: true }) : canvas.getContext("2d");');
const flags = {};
const imageToCanvas = new Function('globalThis', ts.transpileModule(candidateFunction, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText + '\nreturn imageToCanvas;')(flags);
const image = { naturalWidth: 17, naturalHeight: 11 };
for (const value of [undefined, false, 0, 'true', true]) {
  flags.__shinobuColdStartSourceCanvasCpu = value;
  const calls = [], draws = [];
  const ctx = { drawImage(...args) { draws.push(args); } };
  const canvas = { getContext(...args) { assert.equal(this, canvas); calls.push(args); return ctx; } };
  let creates = 0;
  assert.equal(imageToCanvas(image, { createCanvas(...args) {
    creates++; assert.deepEqual(args, [17, 11]); return canvas;
  } }), canvas);
  assert.equal(creates, 1);
  assert.deepEqual(calls, value === true ? [['2d', { willReadFrequently: true }]] : [['2d']]);
  assert.deepEqual(draws, [[image, 0, 0]]);
}
assert.throws(() => imageToCanvas(image, { createCanvas: () => ({ getContext: () => null }) }), /无法创建 Canvas 上下文/);
const restored = new Function('globalThis', ts.transpileModule(originalFunction, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText + '\nreturn imageToCanvas;')(flags);
flags.__shinobuColdStartSourceCanvasCpu = true;
const restoredCalls = [];
const restoredCanvas = { getContext(...args) { restoredCalls.push(args); return { drawImage() {} }; } };
assert.equal(restored(image, { createCanvas: () => restoredCanvas }), restoredCanvas);
assert.deepEqual(restoredCalls, [['2d']], 'production function must remain restored even with the experimental flag');
console.log('isolated SourceCanvasCpu guard and restored production context: strict flag/options/size/draw/error passed');
