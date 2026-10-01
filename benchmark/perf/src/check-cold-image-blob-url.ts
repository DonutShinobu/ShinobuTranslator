import assert from 'node:assert/strict';
import { fileToImage } from '../../../packages/image-pipeline/src/pipeline/image';
import type { PlatformProvider, PipelineImage } from '../../../packages/image-pipeline/src/runtime/platform';

const flags = globalThis as typeof globalThis & { __shinobuColdStartImageBlobUrl?: unknown };
const globals = globalThis as typeof globalThis & { FileReader?: unknown };
const saved = { create: URL.createObjectURL, revoke: URL.revokeObjectURL, reader: globals.FileReader,
  flag: flags.__shinobuColdStartImageBlobUrl };
const file = new File(['exact bytes'], 'input.png', { type: 'image/png' });
const image = {} as PipelineImage;
const events: string[] = [];
let finish: ((image: PipelineImage) => void) | undefined;
const platform = { loadImage: (url: string) => {
  events.push(`load:${url}`);
  return new Promise<PipelineImage>(resolve => { finish = resolve; });
} } as PlatformProvider;
try {
  Object.defineProperty(globals, 'FileReader', { configurable: true, writable: true, value: class {
    result = 'data:image/png;base64,ZXhhY3Q=';
    onload?: () => void;
    readAsDataURL(input: File) { assert.equal(input, file); queueMicrotask(() => this.onload?.()); }
  } });
  URL.createObjectURL = input => { assert.equal(input, file); events.push('create'); return 'blob:exact'; };
  URL.revokeObjectURL = url => { events.push(`revoke:${url}`); };
  for (const flag of [undefined, false, 1, true]) {
    flags.__shinobuColdStartImageBlobUrl = flag;
    events.length = 0;
    finish = undefined;
    const pending = fileToImage(file, platform);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(events, flag === true ? ['create', 'load:blob:exact'] : ['load:data:image/png;base64,ZXhhY3Q=']);
    const complete = finish as ((value: PipelineImage) => void) | undefined;
    assert.ok(complete);
    complete(image);
    assert.equal(await pending, image);
    assert.deepEqual(events, flag === true ? ['create', 'load:blob:exact', 'revoke:blob:exact'] : ['load:data:image/png;base64,ZXhhY3Q=']);
  }
  const failure = new Error('decode failed');
  events.length = 0;
  await assert.rejects(fileToImage(file, { loadImage: async () => { throw failure; } } as unknown as PlatformProvider), failure);
  assert.deepEqual(events, ['create', 'revoke:blob:exact']);
  URL.createObjectURL = undefined as unknown as typeof URL.createObjectURL;
  events.length = 0;
  const pending = fileToImage(file, platform);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ['load:data:image/png;base64,ZXhhY3Q=']);
  finish!(image);
  assert.equal(await pending, image);
} finally {
  URL.createObjectURL = saved.create;
  URL.revokeObjectURL = saved.revoke;
  if (saved.reader === undefined) Reflect.deleteProperty(globals, 'FileReader');
  else globals.FileReader = saved.reader as typeof FileReader;
  if (saved.flag === undefined) delete flags.__shinobuColdStartImageBlobUrl;
  else flags.__shinobuColdStartImageBlobUrl = saved.flag;
}
console.log('Image Blob URL flag/lifetime/failure/fallback check passed');
