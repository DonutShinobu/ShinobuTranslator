import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type {
  PipelineCanvas, PipelineImage, PipelineImageData, PipelineRenderingContext, PlatformProvider,
} from '../../../packages/image-pipeline/src/runtime/platform';

// Exercise the actual private functions without loading models or adding an API.
const source = readFileSync(new URL('../../../packages/image-pipeline/src/pipeline/detect/onnxDetect.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('onnxDetect.ts', source, ts.ScriptTarget.ES2022, true);
const names = ['binaryMaskToCanvas', 'scaleMaskToOriginal', 'buildMaskCanvasFromBinary'];
const declarations = names.map(name => {
  const node = ast.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!node) throw new Error(`Missing ${name}`);
  return node.getText(ast);
});
const functions = new Function(ts.transpileModule(declarations.join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText + `\nreturn { ${names.join(', ')} };`)() as {
  binaryMaskToCanvas: (mask: Uint8Array, width: number, height: number, platform: PlatformProvider) => PixelCanvas;
  scaleMaskToOriginal: (canvas: PipelineCanvas, image: PipelineImage, platform: PlatformProvider) => PixelCanvas;
  buildMaskCanvasFromBinary: (mask: Uint8Array, width: number, height: number, image: PipelineImage, platform: PlatformProvider) => PixelCanvas;
};

class PixelCanvas implements PipelineCanvas {
  readonly storage: Uint8Array;
  readonly data: Uint8ClampedArray;
  readonly calls: string[] = [];
  constructor(public width: number, public height: number, offset: number, initial?: Uint8ClampedArray) {
    this.storage = new Uint8Array(offset + width * height * 4 + 7).fill(63);
    this.data = new Uint8ClampedArray(this.storage.buffer, offset, width * height * 4);
    this.data.set(initial ?? new Uint8ClampedArray(this.data.length));
  }
  getContext(type: '2d', options?: CanvasRenderingContext2DSettings): PipelineRenderingContext {
    this.calls.push(`context:${type}:${options?.willReadFrequently ?? false}`);
    const canvas = this;
    return {
      set imageSmoothingEnabled(enabled: boolean) { canvas.calls.push(`smoothing:${enabled}`); },
      drawImage(from: PixelCanvas, x: number, y: number, width: number, height: number) {
        canvas.calls.push(`draw:${x},${y},${width},${height}`);
        for (let iy = 0; iy < height; iy++) for (let ix = 0; ix < width; ix++) {
          const src = (Math.floor(iy * from.height / height) * from.width + Math.floor(ix * from.width / width)) * 4;
          canvas.data.set(from.data.subarray(src, src + 4), (iy * canvas.width + ix) * 4);
        }
      },
      createImageData(width: number, height: number): PipelineImageData {
        canvas.calls.push(`create:${width},${height}`);
        return { width, height, data: canvas.data };
      },
      getImageData(x: number, y: number, width: number, height: number): PipelineImageData {
        canvas.calls.push(`get:${x},${y},${width},${height}`);
        return { width, height, data: canvas.data };
      },
      putImageData(image: PipelineImageData, x: number, y: number) {
        canvas.calls.push(`put:${x},${y}`); assert.equal(image.data, canvas.data);
      },
    } as unknown as PipelineRenderingContext;
  }
  toDataURL(): string { throw new Error('No encoder in this CPU check'); }
  checkPadding(): void {
    assert.ok(this.storage.subarray(0, this.data.byteOffset).every(value => value === 63));
    assert.ok(this.storage.subarray(this.data.byteOffset + this.data.length).every(value => value === 63));
  }
}
const root = globalThis as { __shinobuColdStartMaskPacked?: boolean };
let state = 0x4011ba3d, checked = 0;
function random(): number { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; }
try {
  for (const [width, height] of [[256, 1], [17, 19], [129, 257]]) {
    const mask = Uint8Array.from({ length: width * height }, (_, i) => [0, 1, 2, 255][i % 4]);
    const rgba = Uint8ClampedArray.from({ length: width * height * 4 }, (_, p) =>
      p % 4 === 0 && width === 256 ? p / 4 : random() % 256);
    for (const offset of [0, 1, 2, 3, 4]) {
      const platform = { createCanvas: (w: number, h: number) => new PixelCanvas(w, h, offset) } as unknown as PlatformProvider;
      const input = new PixelCanvas(width, height, offset, rgba), original = input.data.slice();
      const image = { naturalWidth: width, naturalHeight: height } as PipelineImage;
      for (const run of [
        () => functions.binaryMaskToCanvas(mask, width, height, platform),
        () => functions.scaleMaskToOriginal(input, image, platform),
        () => functions.buildMaskCanvasFromBinary(mask, width, height, image, platform),
      ]) {
        root.__shinobuColdStartMaskPacked = false; const reference = run();
        root.__shinobuColdStartMaskPacked = true; const candidate = run();
        assert.deepEqual(candidate.data, reference.data); assert.deepEqual(candidate.calls, reference.calls);
        assert.ok(candidate.data.every((value, p) => p % 4 !== 3 || value === 255));
        candidate.checkPadding(); reference.checkPadding(); assert.deepEqual(input.data, original);
        checked++;
      }
      // Independent byte oracle verifies both threshold rules, including red127/128.
      const binaryExpected = new Uint8ClampedArray(mask.length * 4), scaledExpected = binaryExpected.slice();
      for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
        binaryExpected.set([mask[i] > 0 ? 255 : 0, mask[i] > 0 ? 255 : 0, mask[i] > 0 ? 255 : 0, 255], p);
        const v = rgba[p] > 127 ? 255 : 0; scaledExpected.set([v, v, v, 255], p);
      }
      assert.deepEqual(functions.binaryMaskToCanvas(mask, width, height, platform).data, binaryExpected);
      assert.deepEqual(functions.scaleMaskToOriginal(input, image, platform).data, scaledExpected);
    }
  }
  // Emulate either host byte order; production derives its black word from native bytes.
  for (const littleEndian of [false, true]) {
    const black = new DataView(Uint8Array.of(0, 0, 0, 255).buffer).getUint32(0, littleEndian);
    const output = new Uint8Array(8), view = new DataView(output.buffer);
    view.setUint32(0, black, littleEndian); view.setUint32(4, 0xffffffff, littleEndian);
    assert.deepEqual(output, Uint8Array.of(0, 0, 0, 255, 255, 255, 255, 255));
  }
  console.log(JSON.stringify({ result: 'packed-detector-mask-exactRGBA-byte-oracle-and-old-functions-identical',
    checked, maxCanvasPixels: 129 * 257, offsets: [0, 1, 2, 3, 4], maskValues: [0, 1, 2, 255],
    redValues: 'all0..255 plus deterministic random', emulatedByteOrders: ['big', 'little'],
    caveat: 'Small CPU array Canvas; native interpolation and full detector SHA/RGBA are separate' }));
} finally { delete root.__shinobuColdStartMaskPacked; }
