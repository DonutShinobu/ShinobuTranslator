export const CONTENT_FINGERPRINT_MAX_DISTANCE = 4;
const fingerprintWidth = 9;
const fingerprintHeight = 8;

export function contentFingerprintFromGrayscale(
  pixels: Uint8ClampedArray,
): string {
  if (pixels.length !== fingerprintWidth * fingerprintHeight) {
    throw new Error('dHash 灰度输入必须是 9×8');
  }
  let hash = 0n;
  for (let y = 0; y < fingerprintHeight; y += 1) {
    for (let x = 0; x < fingerprintWidth - 1; x += 1) {
      hash <<= 1n;
      if (pixels[y * fingerprintWidth + x] > pixels[y * fingerprintWidth + x + 1]) {
        hash |= 1n;
      }
    }
  }
  return hash.toString(16).padStart(16, '0');
}

function hammingDistance(left: string, right: string): number {
  if (!/^[0-9a-f]{16}$/u.test(left) || !/^[0-9a-f]{16}$/u.test(right)) {
    return Number.POSITIVE_INFINITY;
  }
  let value = BigInt(`0x${left}`) ^ BigInt(`0x${right}`);
  let distance = 0;
  while (value !== 0n) {
    value &= value - 1n;
    distance += 1;
  }
  return distance;
}

export function contentFingerprintsMatch(left: string, right: string): boolean {
  return hammingDistance(left, right) <= CONTENT_FINGERPRINT_MAX_DISTANCE;
}

function rgbaToGrayscale(data: Uint8ClampedArray): Uint8ClampedArray {
  const grayscale = new Uint8ClampedArray(fingerprintWidth * fingerprintHeight);
  for (let index = 0; index < grayscale.length; index += 1) {
    const offset = index * 4;
    grayscale[index] = Math.round(
      data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114,
    );
  }
  return grayscale;
}

export async function computeContentFingerprint(file: File): Promise<string> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('当前浏览器不支持页面指纹解码');
  }
  const bitmap = await createImageBitmap(file);
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const canvas = new OffscreenCanvas(fingerprintWidth, fingerprintHeight);
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('无法创建页面指纹画布');
      context.drawImage(bitmap, 0, 0, fingerprintWidth, fingerprintHeight);
      return contentFingerprintFromGrayscale(
        rgbaToGrayscale(
          context.getImageData(0, 0, fingerprintWidth, fingerprintHeight).data,
        ),
      );
    }

    const canvas = document.createElement('canvas');
    canvas.width = fingerprintWidth;
    canvas.height = fingerprintHeight;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法创建页面指纹画布');
    context.drawImage(bitmap, 0, 0, fingerprintWidth, fingerprintHeight);
    return contentFingerprintFromGrayscale(
      rgbaToGrayscale(context.getImageData(0, 0, fingerprintWidth, fingerprintHeight).data),
    );
  } finally {
    bitmap.close();
  }
}
