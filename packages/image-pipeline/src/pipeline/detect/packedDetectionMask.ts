const edgeThickness = 2;

function validateDimensions(width: number, height: number): number {
  if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0) {
    throw new Error('检测 mask 尺寸无效');
  }
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount)) throw new Error('检测 mask 尺寸无效');
  return pixelCount;
}

export function packDetectionMask(
  binaryMask: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const pixelCount = validateDimensions(width, height);
  if (binaryMask.length !== pixelCount) throw new Error('检测 mask 数据与尺寸不匹配');
  const packed = new Uint8Array(Math.ceil(pixelCount / 8));
  for (let index = 0; index < pixelCount; index += 1) {
    if (binaryMask[index] > 0) packed[index >> 3] |= 1 << (index & 7);
  }
  return packed;
}

export function unpackDetectionMask(
  packedMask: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const pixelCount = validateDimensions(width, height);
  const expectedLength = Math.ceil(pixelCount / 8);
  if (packedMask.length !== expectedLength) throw new Error('检测 mask bitset 长度无效');
  const binary = new Uint8Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    binary[index] = (packedMask[index >> 3] >> (index & 7)) & 1;
  }
  return binary;
}

function hasPackedPixel(
  packedMask: Uint8Array,
  start: number,
  end: number,
): boolean {
  for (let index = start; index < end; index += 1) {
    if (((packedMask[index >> 3] >> (index & 7)) & 1) === 1) return true;
  }
  return false;
}

export function inspectPackedDetectionMaskEdges(
  packedMask: Uint8Array,
  width: number,
  height: number,
): { topTouches: boolean; bottomTouches: boolean } {
  const pixelCount = validateDimensions(width, height);
  if (packedMask.length !== Math.ceil(pixelCount / 8)) {
    throw new Error('检测 mask bitset 长度无效');
  }
  const rows = Math.min(edgeThickness, height);
  return {
    topTouches: hasPackedPixel(packedMask, 0, width * rows),
    bottomTouches: hasPackedPixel(packedMask, width * (height - rows), pixelCount),
  };
}
