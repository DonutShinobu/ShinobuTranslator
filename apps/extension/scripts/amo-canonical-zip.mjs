import { deflateRawSync, constants as zlibConstants } from 'node:zlib';

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_UINT16_MAX = 0xffff;
const ZIP_UINT32_MAX = 0xffffffff;

export const AMO_CANONICAL_ZIP = Object.freeze({
  madeBy: 0x0314,
  requiredVersion: 20,
  flags: 0x0800,
  compression: 8,
  compressionLevel: 9,
  compressionWindowBits: 15,
  compressionMemoryLevel: 8,
  compressionStrategy: zlibConstants.Z_DEFAULT_STRATEGY,
  dosTime: 0,
  dosDate: 0x0021,
  externalAttributes: ((0o100000 | 0o644) << 16) >>> 0,
  comment: '',
  extra: '',
});

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1
      ? 0xedb88320 ^ (value >>> 1)
      : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function compareUtf8Paths(left, right) {
  return Buffer.compare(
    Buffer.from(left.path, 'utf8'),
    Buffer.from(right.path, 'utf8'),
  );
}

function assertCanonicalEntry(entry, seenPaths) {
  if (entry.kind !== undefined && entry.kind !== 'file') {
    throw new Error(
      `Canonical ZIP rejects ${String(entry.kind)} entries: ${String(entry.path)}`,
    );
  }
  if (typeof entry.path !== 'string' || entry.path.length === 0) {
    throw new Error('Canonical ZIP entry requires a non-empty path.');
  }
  if (
    entry.path.startsWith('/')
    || /^[A-Za-z]:\//u.test(entry.path)
  ) {
    throw new Error(`Canonical ZIP rejects absolute path: ${entry.path}`);
  }
  if (entry.path.includes('\\')) {
    throw new Error(`Canonical ZIP requires a POSIX path: ${entry.path}`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(entry.path)) {
    throw new Error(
      `Canonical ZIP rejects control character in path: ${JSON.stringify(entry.path)}`,
    );
  }
  const segments = entry.path.split('/');
  if (segments.includes('..')) {
    throw new Error(
      `Canonical ZIP rejects parent directory entry: ${entry.path}`,
    );
  }
  if (
    segments.some((segment) => segment === '' || segment === '.')
  ) {
    throw new Error(`Canonical ZIP rejects invalid entry path: ${entry.path}`);
  }
  if (seenPaths.has(entry.path)) {
    throw new Error(`Canonical ZIP rejects duplicate entry: ${entry.path}`);
  }
  seenPaths.add(entry.path);
}

function createLocalHeader({
  name,
  checksum,
  compressedSize,
  uncompressedSize,
}) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(AMO_CANONICAL_ZIP.requiredVersion, 4);
  header.writeUInt16LE(AMO_CANONICAL_ZIP.flags, 6);
  header.writeUInt16LE(AMO_CANONICAL_ZIP.compression, 8);
  header.writeUInt16LE(AMO_CANONICAL_ZIP.dosTime, 10);
  header.writeUInt16LE(AMO_CANONICAL_ZIP.dosDate, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(uncompressedSize, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function createCentralHeader({
  name,
  checksum,
  compressedSize,
  uncompressedSize,
  localOffset,
}) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_DIRECTORY_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(AMO_CANONICAL_ZIP.madeBy, 4);
  header.writeUInt16LE(AMO_CANONICAL_ZIP.requiredVersion, 6);
  header.writeUInt16LE(AMO_CANONICAL_ZIP.flags, 8);
  header.writeUInt16LE(AMO_CANONICAL_ZIP.compression, 10);
  header.writeUInt16LE(AMO_CANONICAL_ZIP.dosTime, 12);
  header.writeUInt16LE(AMO_CANONICAL_ZIP.dosDate, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(uncompressedSize, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(AMO_CANONICAL_ZIP.externalAttributes, 38);
  header.writeUInt32LE(localOffset, 42);
  return header;
}

function createEndRecord(entryCount, centralSize, centralOffset) {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(centralSize, 12);
  record.writeUInt32LE(centralOffset, 16);
  record.writeUInt16LE(0, 20);
  return record;
}

export function createCanonicalZip(entries) {
  if (entries.length > ZIP_UINT16_MAX) {
    throw new Error('Canonical ZIP does not support more than 65535 entries.');
  }
  const seenPaths = new Set();
  const sortedEntries = entries
    .map((entry) => {
      assertCanonicalEntry(entry, seenPaths);
      return {
        path: entry.path,
        bytes: Buffer.from(entry.bytes),
      };
    })
    .sort(compareUtf8Paths);
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of sortedEntries) {
    const name = Buffer.from(entry.path, 'utf8');
    const compressed = deflateRawSync(entry.bytes, {
      level: AMO_CANONICAL_ZIP.compressionLevel,
      windowBits: AMO_CANONICAL_ZIP.compressionWindowBits,
      memLevel: AMO_CANONICAL_ZIP.compressionMemoryLevel,
      strategy: AMO_CANONICAL_ZIP.compressionStrategy,
    });
    if (
      name.length > ZIP_UINT16_MAX
      || entry.bytes.length > ZIP_UINT32_MAX
      || compressed.length > ZIP_UINT32_MAX
      || localOffset > ZIP_UINT32_MAX
    ) {
      throw new Error(`Canonical ZIP entry exceeds ZIP32 limits: ${entry.path}`);
    }
    const checksum = crc32(entry.bytes);
    const headerValues = {
      name,
      checksum,
      compressedSize: compressed.length,
      uncompressedSize: entry.bytes.length,
      localOffset,
    };
    const localHeader = createLocalHeader(headerValues);
    localParts.push(localHeader, name, compressed);
    centralParts.push(createCentralHeader(headerValues), name);
    localOffset += localHeader.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (
    localOffset > ZIP_UINT32_MAX
    || centralDirectory.length > ZIP_UINT32_MAX
  ) {
    throw new Error('Canonical ZIP exceeds ZIP32 archive limits.');
  }
  return Buffer.concat([
    ...localParts,
    centralDirectory,
    createEndRecord(
      sortedEntries.length,
      centralDirectory.length,
      localOffset,
    ),
  ]);
}
