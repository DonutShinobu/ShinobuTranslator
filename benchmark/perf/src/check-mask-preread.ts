import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { prepareTextMaskGray, refineTextMask, type PreparedTextMaskGray } from '../../../packages/image-pipeline/src/pipeline/maskRefinement';
import { toMaskCanvas } from '../../../packages/image-pipeline/src/pipeline/maskRefinement/algorithms';
import type { TextRegion } from '../../../packages/image-pipeline/src/types';
import type { PipelineCanvas, PipelineImageData, PipelineRenderingContext, PlatformProvider } from '../../../packages/image-pipeline/src/runtime/platform';
import type { PreparedInpaintSource } from '../../../packages/image-pipeline/src/pipeline/inpaint';

type FilterMode = 'unknown' | 'unsupported' | 'failed' | 'success';
let filterMode: FilterMode = 'unknown', reads = 0;
const canvases: ArrayCanvas[] = [];
class ArrayCanvas implements PipelineCanvas {
  data: Uint8ClampedArray;
  gets = 0; puts = 0; disposed = false;
  readonly context: PipelineRenderingContext;
  constructor(public width: number, public height: number) {
    this.data = new Uint8ClampedArray(width * height * 4);
    const canvas = this, mode = filterMode;
    let filter = mode === 'unsupported' ? undefined : 'none';
    this.context = {
      get filter() { return filter; }, set filter(value) { filter = value; },
      getContextAttributes: () => mode === 'unknown' ? {} : { colorSpace: 'srgb', colorType: 'unorm8' },
      save() {}, restore() { filter = 'none'; },
      drawImage(source: ArrayCanvas, _x: number, _y: number, width = source.width, height = source.height) {
        if (filter === 'contrast(100000%)' && mode === 'failed') throw new Error('Native draw failure');
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          const src = (Math.floor(y * source.height / height) * source.width + Math.floor(x * source.width / width)) * 4;
          const dst = (y * canvas.width + x) * 4;
          canvas.data.set(source.data.subarray(src, src + 4), dst);
          if (filter === 'contrast(100000%)') {
            for (let c = 0; c < 3; c++) canvas.data[dst + c] = canvas.data[dst + c] > 127 ? 255 : 0;
          }
        }
      },
      createImageData(w: number, h: number): PipelineImageData { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
      getImageData(): PipelineImageData {
        reads++; canvas.gets++; return { width: canvas.width, height: canvas.height, data: canvas.data.slice() };
      },
      putImageData(image: PipelineImageData) { canvas.puts++; canvas.data = image.data.slice(); },
    } as unknown as PipelineRenderingContext;
    canvases.push(this);
  }
  getContext(): PipelineRenderingContext { return this.context; }
  toDataURL(): string { throw new Error('No encoding in this CPU check'); }
  dispose(): void { this.disposed = true; }
}
const platform = { createCanvas: (width: number, height: number) => new ArrayCanvas(width, height) } as unknown as PlatformProvider;
const root = globalThis as {
  __shinobuColdStartSourcePreRead?: boolean;
  __shinobuColdStartMaskNativeThreshold?: boolean;
  __shinobuColdStartPixelFastPath?: boolean;
  __shinobuColdStartInpaintPixels?: boolean;
  __shinobuColdStartInpaintDirectPixels?: boolean;
  __shinobuColdStartInitMark?: (record: Record<string, unknown>) => void;
};
function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.ES2022, true);
}
const inpaintAst = parse('../../../packages/image-pipeline/src/pipeline/inpaint.ts');
const inpaintCode = inpaintAst.statements.filter(ts.isFunctionDeclaration).map(node => node.getText(inpaintAst).replace(/^export\s+/, '')).join('\n');
const inpaint = new Function('clamp', 'isContextLostRuntimeError', 'toErrorMessage', ts.transpileModule(inpaintCode, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText + '\nreturn { prepareInpaintSource, runInpaint };')(
  (v: number, low: number, high: number) => Math.max(low, Math.min(v, high)), () => false, (error: Error) => error.message,
) as {
  prepareInpaintSource: (canvas: PipelineCanvas, platform: PlatformProvider) => PreparedInpaintSource;
  runInpaint: (canvas: PipelineCanvas, mask: PipelineCanvas, platform: PlatformProvider, runtime: unknown, prepared?: PreparedInpaintSource) => Promise<{ canvas: ArrayCanvas }>;
};
const orchestrationAst = parse('../../../packages/image-pipeline/src/pipeline/orchestrator.ts');
const pipeline = orchestrationAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'runPipeline') as ts.FunctionDeclaration;
const scopeNames = new Set(['preparedMaskGray', 'preparedInpaintSource', 'sourcePreReadStarted', 'sourcePreReadEnabled', 'onDetectorSubmitted']);
const scopeCode = pipeline.body!.statements.filter(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(declaration => scopeNames.has(declaration.name.getText(orchestrationAst)))).map(node => node.getText(orchestrationAst)).join('\n');
assert.equal(pipeline.body!.statements.filter(node => ts.isVariableStatement(node)
  && node.declarationList.declarations.some(declaration => scopeNames.has(declaration.name.getText(orchestrationAst)))).length, 5);
const makeScope = new Function('originalCanvas', 'platform', 'options', 'signal', 'stopAfterOrder', 'prepareTextMaskGray', 'prepareInpaintSource',
  ts.transpileModule(scopeCode, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  + '\nreturn { onDetectorSubmitted, gray: () => preparedMaskGray, source: () => preparedInpaintSource };') as (
    canvas: PipelineCanvas, platform: PlatformProvider, options: unknown, signal: unknown, stop: boolean,
    gray: typeof prepareTextMaskGray, original: typeof inpaint.prepareInpaintSource,
  ) => { onDetectorSubmitted?: () => void; gray: () => PreparedTextMaskGray | undefined; source: () => PreparedInpaintSource | undefined };

const original = new ArrayCanvas(44, 36), mask = new ArrayCanvas(44, 36);
const regions: TextRegion[] = [{ id: 'text', box: { x: 3, y: 4, width: 28, height: 27 }, fontSize: 13, sourceText: 'A', translatedText: '甲' }];
for (let y = 0; y < original.height; y++) for (let x = 0; x < original.width; x++) {
  const text = x >= 9 && x <= 22 && y >= 11 && y <= 22, p = (y * original.width + x) * 4;
  original.data.set([text ? 10 : 230, text ? 10 : 230, text ? 10 : 230, p / 4 % 256], p);
  mask.data.set([text ? 255 : 0, text ? 255 : 0, text ? 255 : 0, 255], p);
}
const originalBytes = original.data.slice(), maskBytes = mask.data.slice();
const feedsSeen: string[] = [];
const runtime = {
  async readModel() { return { input: [4], normalize: 'zero_to_one', outputNormalize: 'zero_to_one' }; },
  async getSession() { return { sessionId: 'test', provider: 'webgpu', inputNames: ['image', 'mask'] }; },
  async run(_session: string, feeds: unknown) {
    feedsSeen.push(JSON.stringify(feeds));
    return { outputs: { repaired: { data: Float32Array.from({ length: 48 }, (_, i) => i / 50), dims: [1, 3, 4, 4], type: 'float32' } } };
  },
};
let preparedCases = 0, nativeCases = 0;
try {
  for (const enabled of [undefined, false, true]) {
    root.__shinobuColdStartSourcePreRead = enabled;
    const before = reads;
    const scope = makeScope(original, platform, {}, undefined, false, prepareTextMaskGray, inpaint.prepareInpaintSource);
    assert.equal(reads, before, 'Scope construction must not read before actual post');
    assert.equal(typeof scope.onDetectorSubmitted, enabled === true ? 'function' : 'undefined');
    scope.onDetectorSubmitted?.(); const submittedReads = reads; scope.onDetectorSubmitted?.();
    assert.equal(reads, submittedReads, 'A repeated submitted callback must not prepare twice');
    assert.equal(!!scope.gray(), enabled === true); assert.equal(!!scope.source(), enabled === true); preparedCases++;
  }
  root.__shinobuColdStartSourcePreRead = true;
  for (const [options, stop, signal] of [[{}, true, undefined], [{ precomputedDetection: {} }, false, undefined], [{}, false, { aborted: true }]] as const) {
    const before = reads, scope = makeScope(original, platform, options, signal, stop, prepareTextMaskGray, inpaint.prepareInpaintSource);
    scope.onDetectorSubmitted?.(); assert.equal(reads, before); assert.equal(scope.source(), undefined); preparedCases++;
  }
  const failed = makeScope(original, platform, {}, undefined, false,
    () => { throw new Error('Early gray failure'); }, () => { throw new Error('Early original failure'); });
  assert.doesNotThrow(() => failed.onDetectorSubmitted?.()); assert.equal(failed.gray(), undefined); assert.equal(failed.source(), undefined); preparedCases++;
  root.__shinobuColdStartInitMark = () => { throw new Error('Observer failure'); };
  const observed = makeScope(original, platform, {}, undefined, false, prepareTextMaskGray, inpaint.prepareInpaintSource);
  assert.doesNotThrow(() => observed.onDetectorSubmitted?.()); assert.ok(observed.gray()); assert.ok(observed.source()); preparedCases++;
  delete root.__shinobuColdStartInitMark;

  for (const debug of [false, true]) {
    const baselineStartedReads = reads, baseline = refineTextMask(original, regions, mask, platform, {}, debug);
    const baselineReads = reads - baselineStartedReads, prepared = prepareTextMaskGray(original, mask.height, platform);
    for (const candidate of [prepared, { ...prepared, scaledWidth: 1 }, { ...prepared, pixels: new Uint8Array(1) },
      { ...prepared, sourceCanvas: new ArrayCanvas(original.width, original.height) }]) {
      const candidateStartedReads = reads, result = refineTextMask(original, regions, mask, platform, {}, debug, candidate);
      assert.equal(reads - candidateStartedReads, baselineReads - (candidate === prepared ? 1 : 0));
      assert.deepEqual((result.refinedMaskCanvas as ArrayCanvas).data, (baseline.refinedMaskCanvas as ArrayCanvas).data);
      assert.deepEqual(result.debugLayers, baseline.debugLayers); preparedCases++;
    }
  }
  for (const direct of [false, true]) {
    root.__shinobuColdStartInpaintDirectPixels = direct; root.__shinobuColdStartInpaintPixels = true;
    const baselineStartedReads = reads, baseline = await inpaint.runInpaint(original, mask, platform, runtime);
    const baselineReads = reads - baselineStartedReads;
    const expectedFeeds = feedsSeen.at(-1);
    for (const invalid of ['valid', 'dimensions', 'rgbaLength', 'source', 'mode']) {
      const prepared = inpaint.prepareInpaintSource(original, platform);
      if (invalid === 'dimensions') prepared.width = 1;
      if (invalid === 'rgbaLength') prepared.rgba = new Uint8ClampedArray(1);
      if (invalid === 'source') prepared.sourceCanvas = new ArrayCanvas(original.width, original.height);
      if (invalid === 'mode') prepared.direct = !direct;
      const candidateStartedReads = reads, result = await inpaint.runInpaint(original, mask, platform, runtime, prepared);
      assert.equal(reads - candidateStartedReads, baselineReads - (invalid === 'valid' ? 1 : 0));
      assert.deepEqual(result.canvas.data, baseline.canvas.data); assert.equal(feedsSeen.at(-1), expectedFeeds);
      assert.deepEqual(original.data, originalBytes); assert.deepEqual(mask.data, maskBytes); preparedCases++;
    }
  }

  const smallBinaryMask = Uint8Array.from({ length: 33 * 17 }, (_, i) => i % 4 ? 1 : 0);
  for (const packed of [false, true]) {
    root.__shinobuColdStartPixelFastPath = packed;
    filterMode = 'unknown'; root.__shinobuColdStartMaskNativeThreshold = false;
    const baseline = toMaskCanvas(smallBinaryMask, 33, 17, 66, 34, platform) as ArrayCanvas;
    for (const mode of ['unknown', 'unsupported', 'failed', 'success'] as const) {
      filterMode = mode; root.__shinobuColdStartMaskNativeThreshold = true;
      const createdBefore = canvases.length, result = toMaskCanvas(smallBinaryMask, 33, 17, 66, 34, platform) as ArrayCanvas;
      assert.deepEqual(result.data, baseline.data); assert.equal(result.width, 66); assert.equal(result.height, 34);
      if (mode === 'success') {
        assert.equal(result.gets, 0); assert.equal(result.puts, 0, 'Native target has no JS read/threshold/put');
        assert.equal(canvases[createdBefore + 1].gets, 0, 'Quantized gray is not read back before 1:1 native draw');
      } else {
        assert.equal(result.gets, 1); assert.equal(result.puts, 1, 'Fallback retains original threshold path');
        if (mode !== 'unknown') assert.ok(canvases.at(-1)!.disposed);
      }
      nativeCases++;
    }
  }
  console.log(JSON.stringify({ result: 'source-preread-scope-and-prepared-data-equivalent-native-toMask-fallback-passed',
    preparedCases, nativeCases, maxCanvasPixels: 2244,
    caveat: 'Actual private scope/helpers/consumers with tiny array Canvas and fake model; real RPC order and native filter/interpolation need Root browser gates' }));
} finally {
  for (const key of ['__shinobuColdStartSourcePreRead', '__shinobuColdStartMaskNativeThreshold', '__shinobuColdStartPixelFastPath',
    '__shinobuColdStartInpaintPixels', '__shinobuColdStartInpaintDirectPixels', '__shinobuColdStartInitMark'] as const) delete root[key];
}
