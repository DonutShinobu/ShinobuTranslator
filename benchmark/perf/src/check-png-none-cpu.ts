import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { encodeNoneFilterPng, packNoneFilterRows, pngCrc32, wrapNoneFilterPng } from './png-none-experiment';

// Only the supplied non-interlaced 8-bit RGBA fixture is unfiltered here. This
// probe is not a PNG loader: unsupported fixture encodings fail explicitly.
function inspectPng(png: Uint8Array) {
  const buffer = Buffer.from(png.buffer, png.byteOffset, png.byteLength), idat: Uint8Array[] = [];
  const chunks: { type: string; bytes: number }[] = [];
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  for (let p = 8; p < buffer.length;) {
    const length = buffer.readUInt32BE(p), type = buffer.toString('ascii', p + 4, p + 8), end = p + length + 12;
    if (end > buffer.length) throw new Error('PNG chunk length invalid');
    const payload = buffer.subarray(p + 8, p + 8 + length);
    if (pngCrc32(buffer.subarray(p + 4, p + 8 + length)) !== buffer.readUInt32BE(end - 4)) throw new Error('PNG CRC invalid: ' + type);
    chunks.push({ type, bytes: length });
    if (type === 'IHDR') {
      width = payload.readUInt32BE(0); height = payload.readUInt32BE(4);
      bitDepth = payload[8]; colorType = payload[9]; interlace = payload[12];
      if (payload[10] !== 0 || payload[11] !== 0) throw new Error('Unsupported PNG compression/filter method');
    }
    if (type === 'IDAT') idat.push(payload);
    p = end;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2) || interlace !== 0) throw new Error('Probe accepts only non-interlaced RGB/RGBA8');
  const channels = colorType === 6 ? 4 : 3, rowBytes = width * channels;
  const inflated = inflateSync(Buffer.concat(idat));
  if (inflated.length !== (rowBytes + 1) * height) throw new Error('PNG scanline length invalid');
  const filters = [0, 0, 0, 0, 0];
  for (let y = 0; y < height; y++) filters[inflated[y * (rowBytes + 1)]]++;
  return { width, height, bitDepth, colorType, interlace, channels, rowBytes, filters, chunks, inflated,
    idatChunks: idat.length, compressedBytes: idat.reduce((sum, value) => sum + value.length, 0) };
}

function decodeNonePng(png: Uint8Array): Uint8Array {
  const info = inspectPng(png), rgba = new Uint8Array(info.width * info.height * 4);
  if (info.filters[0] !== info.height) throw new Error('Candidate wrote a nonzero filter');
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const from = y * (info.rowBytes + 1) + 1 + x * info.channels, to = (y * info.width + x) * 4;
    rgba[to] = info.inflated[from]; rgba[to + 1] = info.inflated[from + 1]; rgba[to + 2] = info.inflated[from + 2];
    rgba[to + 3] = info.channels === 4 ? info.inflated[from + 3] : 255;
  }
  return rgba;
}

function equal(a: Uint8Array, b: Uint8Array, label: string): void {
  if (a.length !== b.length || a.some((value, index) => value !== b[index])) throw new Error(label + ' differs');
}

let checks = 0;
for (const [width, height] of [[1, 1], [17, 13], [256, 3]]) for (const opaque of [false, true]) for (const preferRgb of [false, true]) {
  // Nonzero byteOffset is deliberately exercised. Alpha covers all 256 values.
  const buffer = new Uint8Array(width * height * 4 + 5), rgba = buffer.subarray(1, buffer.length - 4);
  for (let p = 0, i = 0; p < rgba.length; p += 4, i++) {
    rgba[p] = i * 17 % 256; rgba[p + 1] = i * 37 % 256; rgba[p + 2] = i * 71 % 256; rgba[p + 3] = opaque ? 255 : i % 256;
  }
  const before = buffer.slice(), packed = packNoneFilterRows(rgba, width, height, preferRgb);
  const result = await encodeNoneFilterPng(rgba, width, height, preferRgb);
  equal(decodeNonePng(new Uint8Array(await result.blob.arrayBuffer())), rgba, 'PNG roundtrip');
  equal(buffer, before, 'input/padding unchanged');
  if (packed.channels !== (preferRgb && opaque ? 3 : 4)) throw new Error('RGB opacity guard failed');
  if (pngCrc32(rgba) !== crc32(rgba)) throw new Error('CRC disagrees with native zlib');
  checks++;
}
let invalidRejected = false;
try { packNoneFilterRows(new Uint8Array(4), 2, 1, true); } catch { invalidRejected = true; }
if (!invalidRejected || pngCrc32(new TextEncoder().encode('123456789')) !== 0xcbf43926) throw new Error('PNG shape/CRC oracle failed');

const fixturePath = process.argv.find(arg => arg.startsWith('--fixture='))?.slice('--fixture='.length);
const fixture = fixturePath ? readFileSync(fixturePath)
  : readFileSync(new URL('../../color/fixtures/typeset-debug-log-2026-05-23T06-03-39-877Z.png', import.meta.url));
const info = inspectPng(fixture);
if (info.colorType !== 6 || info.filters[2] !== info.height) throw new Error('Expected fixture RGBA8/Up-only; extend no general decoder');
const rgba = new Uint8Array(info.width * info.height * 4), started = performance.now();
for (let y = 0; y < info.height; y++) {
  const from = y * (info.rowBytes + 1) + 1, to = y * info.rowBytes;
  for (let x = 0; x < info.rowBytes; x++) rgba[to + x] = (info.inflated[from + x] + (y ? rgba[to + x - info.rowBytes] : 0)) & 255;
}
const unfilterJsMs = performance.now() - started;
let nonopaquePixels = 0;
for (let p = 3; p < rgba.length; p += 4) if (rgba[p] !== 255) nonopaquePixels++;
const estimates = [];
for (const preferRgb of [false, true]) {
  const packStarted = performance.now(), packed = packNoneFilterRows(rgba, info.width, info.height, preferRgb), packMs = performance.now() - packStarted;
  for (const level of [1, 6]) {
    const deflateStarted = performance.now(), compressed = deflateSync(packed.rows, { level }), deflateMs = performance.now() - deflateStarted;
    const blob = wrapNoneFilterPng(info.width, info.height, packed.channels, compressed);
    equal(decodeNonePng(new Uint8Array(await blob.arrayBuffer())), rgba, 'fixture PNG roundtrip');
    estimates.push({ channels: packed.channels, level, packMs, deflateMs, pngBytes: blob.size, sizeRatio: blob.size / fixture.length });
  }
}
const result = { checks, crcOracle: 'node:zlib.crc32 + standard known vector', pngBytes: fixture.length,
  width: info.width, height: info.height, bitDepth: info.bitDepth, colorType: info.colorType, interlace: info.interlace,
  idatChunks: info.idatChunks, chunkTypes: [...new Set(info.chunks.map(chunk => chunk.type))], rowFilters: info.filters,
  compressedBytes: info.compressedBytes, inflatedBytes: info.inflated.length, nonopaquePixels,
  rgbaSha256: createHash('sha256').update(rgba).digest('hex'), unfilterJsMs, estimates,
  caveat: 'Node zlib size/CPU probe, one round. Not Chromium CompressionStream or native image.decode timing; no full-flow speed claim.' };
const out = process.argv.find(arg => arg.startsWith('--out='))?.slice('--out='.length);
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
