// Benchmark only: 8-bit sRGB, non-interlaced PNG. This is deliberately not a
// product encoder or a general PNG codec. P3/unknown Canvas formats use native
// PNG in the browser harness before this function is called.
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

export function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(data.length + 12), view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) bytes[4 + i] = type.charCodeAt(i);
  bytes.set(data, 8);
  view.setUint32(bytes.length - 4, pngCrc32(bytes.subarray(4, bytes.length - 4)));
  return bytes;
}

export function packNoneFilterRows(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, preferRgb: boolean) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || rgba.length !== width * height * 4) {
    throw new Error('PNG experiment requires same-size, complete 8-bit RGBA');
  }
  let channels = 4;
  if (preferRgb) {
    channels = 3;
    for (let p = 3; p < rgba.length; p += 4) if (rgba[p] !== 255) { channels = 4; break; }
  }
  const rowBytes = width * channels, rows = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const source = y * width * 4;
    let target = y * (rowBytes + 1) + 1; // Uint8Array initialization supplies filter=0.
    if (channels === 4) rows.set(rgba.subarray(source, source + width * 4), target);
    else for (let x = 0, p = source; x < width; x++, p += 4) {
      rows[target++] = rgba[p]; rows[target++] = rgba[p + 1]; rows[target++] = rgba[p + 2];
    }
  }
  return { rows, channels, rowBytes };
}

export function wrapNoneFilterPng(width: number, height: number, channels: number, compressed: Uint8Array): Blob {
  if (channels !== 3 && channels !== 4) throw new Error('PNG experiment supports RGB or RGBA only');
  const ihdr = new Uint8Array(13), view = new DataView(ihdr.buffer);
  view.setUint32(0, width); view.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = channels === 3 ? 2 : 6;
  return new Blob([
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), pngChunk('IHDR', ihdr),
    pngChunk('sRGB', Uint8Array.of(0)), pngChunk('IDAT', compressed), pngChunk('IEND', new Uint8Array(0)),
  ], { type: 'image/png' });
}

export async function encodeNoneFilterPng(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, preferRgb: boolean) {
  const packStarted = performance.now(), packed = packNoneFilterRows(rgba, width, height, preferRgb);
  const packMs = performance.now() - packStarted, deflateStarted = performance.now();
  const stream = new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) {
    controller.enqueue(packed.rows); controller.close();
  }}).pipeThrough(new CompressionStream('deflate'));
  // Await the complete zlib stream including its trailer, then CRC and PNG
  // envelope. Returning early or deferring export is not part of this experiment.
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  const deflateMs = performance.now() - deflateStarted, envelopeStarted = performance.now();
  const blob = wrapNoneFilterPng(width, height, packed.channels, compressed);
  return { blob, detail: { channels: packed.channels, rowBytes: packed.rowBytes, packMs, deflateMs,
    envelopeMs: performance.now() - envelopeStarted, rawBytes: packed.rows.length, compressedBytes: compressed.length } };
}
