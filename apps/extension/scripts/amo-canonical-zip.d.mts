export interface AmoCanonicalZipEntry {
  path: string;
  bytes: Uint8Array;
  kind?: string;
}

export interface AmoCanonicalZipParameters {
  madeBy: number;
  requiredVersion: number;
  flags: number;
  compression: number;
  compressionLevel: number;
  compressionWindowBits: number;
  compressionMemoryLevel: number;
  compressionStrategy: number;
  dosTime: number;
  dosDate: number;
  externalAttributes: number;
  comment: string;
  extra: string;
}

export const AMO_CANONICAL_ZIP: Readonly<AmoCanonicalZipParameters>;

export function createCanonicalZip(
  entries: AmoCanonicalZipEntry[],
): Buffer;
