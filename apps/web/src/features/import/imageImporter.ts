export type SupportedImageFormat = 'png' | 'jpeg' | 'webp' | 'avif';

export type ImageImportLimits = {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxBatchCount: number;
  maxOriginalPixels: number;
  maxLongEdge: number;
  workPixelBudget: number;
  thumbnailMaxEdge: number;
};

export const DESKTOP_IMAGE_IMPORT_LIMITS: Readonly<ImageImportLimits> = {
  maxFileBytes: 32 * 1024 * 1024,
  maxTotalBytes: 500 * 1024 * 1024,
  maxBatchCount: 100,
  maxOriginalPixels: 40_000_000,
  maxLongEdge: 8_192,
  workPixelBudget: 8_000_000,
  thumbnailMaxEdge: 512,
};

export const MOBILE_IMAGE_IMPORT_LIMITS: Readonly<ImageImportLimits> = {
  ...DESKTOP_IMAGE_IMPORT_LIMITS,
  maxFileBytes: 20 * 1024 * 1024,
};

export function imageImportLimitsForDevice(
  mobile: boolean,
  workPixelBudget: number,
): Readonly<ImageImportLimits> {
  const base = mobile ? MOBILE_IMAGE_IMPORT_LIMITS : DESKTOP_IMAGE_IMPORT_LIMITS;
  return {
    ...base,
    workPixelBudget: Math.max(
      1_000_000,
      Math.min(12_000_000, Math.floor(workPixelBudget)),
    ),
  };
}

export type ImageImportRejectionCode =
  | 'empty-file'
  | 'file-too-large'
  | 'batch-count-limit'
  | 'batch-size-limit'
  | 'unsupported-format'
  | 'animated-image'
  | 'decode-failed'
  | 'invalid-dimensions'
  | 'dimensions-too-large'
  | 'thumbnail-failed';

export type ImageImportRejection = {
  file: File;
  code: ImageImportRejectionCode;
};

export type WorkingCopyPlan = {
  required: boolean;
  width: number;
  height: number;
  scale: number;
};

export type ImportedImage = {
  id: string;
  file: File;
  format: SupportedImageFormat;
  width: number;
  height: number;
  pixelCount: number;
  thumbnailUrl: string;
  duplicate: boolean;
  workingCopy: WorkingCopyPlan;
};

export type ImageImportResult = {
  accepted: ImportedImage[];
  rejected: ImageImportRejection[];
};

export type DecodedImage = {
  width: number;
  height: number;
  createThumbnail(maxEdge: number): Promise<string>;
  dispose(): void;
};

export type ImageDecoder = (file: File) => Promise<DecodedImage>;

export type ImageImporter = {
  importFiles(
    files: readonly File[],
    existingImages?: readonly ImportedImage[],
  ): Promise<ImageImportResult>;
};

type ImageImporterDependencies = {
  decodeImage: ImageDecoder;
  limits?: Readonly<ImageImportLimits>;
  createId?: () => string;
};

type DetectedImage = {
  format: SupportedImageFormat;
  animated: boolean;
};

const PROBE_BYTES = 256 * 1024;

function hasBytes(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset + expected.length > bytes.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return '';
  let value = '';
  for (let index = offset; index < offset + length; index += 1) {
    value += String.fromCharCode(bytes[index]);
  }
  return value;
}

function containsAscii(bytes: Uint8Array, expected: string): boolean {
  if (expected.length === 0 || expected.length > bytes.length) return false;
  for (let offset = 0; offset <= bytes.length - expected.length; offset += 1) {
    let matches = true;
    for (let index = 0; index < expected.length; index += 1) {
      if (bytes[offset + index] !== expected.charCodeAt(index)) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function readUint32BigEndian(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) return 0;
  return (
    bytes[offset] * 0x1000000
    + bytes[offset + 1] * 0x10000
    + bytes[offset + 2] * 0x100
    + bytes[offset + 3]
  );
}

function detectAvif(bytes: Uint8Array): DetectedImage | null {
  if (readAscii(bytes, 4, 4) !== 'ftyp') return null;
  const declaredBoxSize = readUint32BigEndian(bytes, 0);
  const boxEnd = Math.min(
    bytes.length,
    declaredBoxSize >= 16 ? declaredBoxSize : Math.min(bytes.length, 64),
  );
  const brands = [readAscii(bytes, 8, 4)];
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    brands.push(readAscii(bytes, offset, 4));
  }
  if (!brands.includes('avif') && !brands.includes('avis')) return null;
  return {
    format: 'avif',
    animated: brands.includes('avis'),
  };
}

export function detectImageSignature(bytes: Uint8Array): DetectedImage | null {
  if (hasBytes(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return {
      format: 'png',
      animated: containsAscii(bytes, 'acTL'),
    };
  }

  if (hasBytes(bytes, 0, [0xff, 0xd8, 0xff])) {
    return {
      format: 'jpeg',
      animated: false,
    };
  }

  if (readAscii(bytes, 0, 4) === 'RIFF' && readAscii(bytes, 8, 4) === 'WEBP') {
    const extendedAnimationFlag =
      readAscii(bytes, 12, 4) === 'VP8X'
      && bytes.length > 20
      && (bytes[20] & 0x02) !== 0;
    return {
      format: 'webp',
      animated:
        extendedAnimationFlag
        || containsAscii(bytes, 'ANIM')
        || containsAscii(bytes, 'ANMF'),
    };
  }

  return detectAvif(bytes);
}

function createWorkingCopyPlan(
  width: number,
  height: number,
  workPixelBudget: number,
): WorkingCopyPlan {
  const pixelCount = width * height;
  if (pixelCount <= workPixelBudget) {
    return {
      required: false,
      width,
      height,
      scale: 1,
    };
  }

  const scale = Math.sqrt(workPixelBudget / pixelCount);
  return {
    required: true,
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scale,
  };
}

function fingerprint(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

function defaultCreateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `image-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function readProbe(file: File): Promise<Uint8Array> {
  const buffer = await file.slice(0, Math.min(file.size, PROBE_BYTES)).arrayBuffer();
  return new Uint8Array(buffer);
}

export function createImageImporter({
  decodeImage,
  limits = DESKTOP_IMAGE_IMPORT_LIMITS,
  createId = defaultCreateId,
}: ImageImporterDependencies): ImageImporter {
  return {
    async importFiles(
      files: readonly File[],
      existingImages: readonly ImportedImage[] = [],
    ): Promise<ImageImportResult> {
      const accepted: ImportedImage[] = [];
      const rejected: ImageImportRejection[] = [];
      const fingerprints = new Set(existingImages.map((image) => fingerprint(image.file)));
      let acceptedBytes = existingImages.reduce((sum, image) => sum + image.file.size, 0);

      for (const file of files) {
        if (existingImages.length + accepted.length >= limits.maxBatchCount) {
          rejected.push({ file, code: 'batch-count-limit' });
          continue;
        }
        if (file.size === 0) {
          rejected.push({ file, code: 'empty-file' });
          continue;
        }
        if (file.size > limits.maxFileBytes) {
          rejected.push({ file, code: 'file-too-large' });
          continue;
        }
        if (acceptedBytes + file.size > limits.maxTotalBytes) {
          rejected.push({ file, code: 'batch-size-limit' });
          continue;
        }

        let detected: DetectedImage | null = null;
        try {
          detected = detectImageSignature(await readProbe(file));
        } catch {
          rejected.push({ file, code: 'unsupported-format' });
          continue;
        }
        if (!detected) {
          rejected.push({ file, code: 'unsupported-format' });
          continue;
        }
        if (detected.animated) {
          rejected.push({ file, code: 'animated-image' });
          continue;
        }

        let decoded: DecodedImage;
        try {
          decoded = await decodeImage(file);
        } catch {
          rejected.push({ file, code: 'decode-failed' });
          continue;
        }

        try {
          const { width, height } = decoded;
          if (
            !Number.isSafeInteger(width)
            || !Number.isSafeInteger(height)
            || width <= 0
            || height <= 0
          ) {
            rejected.push({ file, code: 'invalid-dimensions' });
            continue;
          }

          const pixelCount = width * height;
          if (
            pixelCount > limits.maxOriginalPixels
            || Math.max(width, height) > limits.maxLongEdge
          ) {
            rejected.push({ file, code: 'dimensions-too-large' });
            continue;
          }

          let thumbnailUrl: string;
          try {
            thumbnailUrl = await decoded.createThumbnail(limits.thumbnailMaxEdge);
          } catch {
            rejected.push({ file, code: 'thumbnail-failed' });
            continue;
          }

          const fileFingerprint = fingerprint(file);
          const duplicate = fingerprints.has(fileFingerprint);
          fingerprints.add(fileFingerprint);
          acceptedBytes += file.size;
          accepted.push({
            id: createId(),
            file,
            format: detected.format,
            width,
            height,
            pixelCount,
            thumbnailUrl,
            duplicate,
            workingCopy: createWorkingCopyPlan(width, height, limits.workPixelBudget),
          });
        } finally {
          decoded.dispose();
        }
      }

      return { accepted, rejected };
    },
  };
}
