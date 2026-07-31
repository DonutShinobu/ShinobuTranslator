import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  AMO_CANONICAL_ZIP,
  createCanonicalZip,
} from '../../apps/extension/scripts/amo-canonical-zip.mjs';

interface ParsedEntry {
  path: string;
  madeBy: number;
  requiredVersion: number;
  flags: number;
  compression: number;
  time: number;
  date: number;
  externalAttributes: number;
  extraLength: number;
  commentLength: number;
  bytes: Buffer;
}

function parseCanonicalZip(archive: Buffer): {
  entries: ParsedEntry[];
  archiveCommentLength: number;
} {
  const endOffset = archive.length - 22;
  expect(archive.readUInt32LE(endOffset)).toBe(0x06054b50);
  const entryCount = archive.readUInt16LE(endOffset + 10);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  const archiveCommentLength = archive.readUInt16LE(endOffset + 20);
  const entries: ParsedEntry[] = [];
  let offset = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    expect(archive.readUInt32LE(offset)).toBe(0x02014b50);
    const madeBy = archive.readUInt16LE(offset + 4);
    const requiredVersion = archive.readUInt16LE(offset + 6);
    const flags = archive.readUInt16LE(offset + 8);
    const compression = archive.readUInt16LE(offset + 10);
    const time = archive.readUInt16LE(offset + 12);
    const date = archive.readUInt16LE(offset + 14);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const externalAttributes = archive.readUInt32LE(offset + 38);
    const localOffset = archive.readUInt32LE(offset + 42);
    const path = archive
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8');

    expect(archive.readUInt32LE(localOffset)).toBe(0x04034b50);
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const payloadOffset =
      localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(
      payloadOffset,
      payloadOffset + compressedSize,
    );
    const bytes = compression === 8
      ? inflateRawSync(compressed)
      : Buffer.from(compressed);
    expect(bytes).toHaveLength(uncompressedSize);

    entries.push({
      path,
      madeBy,
      requiredVersion,
      flags,
      compression,
      time,
      date,
      externalAttributes,
      extraLength: extraLength + localExtraLength,
      commentLength,
      bytes,
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return { entries, archiveCommentLength };
}

describe('AMO canonical ZIP', () => {
  it('emits the same fixed metadata and UTF-8 path order for every input order', () => {
    const entries = [
      { path: 'z-last.txt', bytes: Buffer.from('last\n') },
      { path: 'manifest.json', bytes: Buffer.from('{}\n') },
    ];

    const first = createCanonicalZip(entries);
    const second = createCanonicalZip([...entries].reverse());
    const parsed = parseCanonicalZip(first);

    expect(first.equals(second)).toBe(true);
    expect(parsed.archiveCommentLength).toBe(0);
    expect(parsed.entries.map((entry) => entry.path)).toEqual([
      'manifest.json',
      'z-last.txt',
    ]);
    for (const entry of parsed.entries) {
      expect(entry).toMatchObject({
        madeBy: AMO_CANONICAL_ZIP.madeBy,
        requiredVersion: AMO_CANONICAL_ZIP.requiredVersion,
        flags: AMO_CANONICAL_ZIP.flags,
        compression: AMO_CANONICAL_ZIP.compression,
        time: AMO_CANONICAL_ZIP.dosTime,
        date: AMO_CANONICAL_ZIP.dosDate,
        externalAttributes: AMO_CANONICAL_ZIP.externalAttributes,
        extraLength: 0,
        commentLength: 0,
      });
    }
    expect(parsed.entries[0]?.bytes.toString('utf8')).toBe('{}\n');
    expect(parsed.entries[1]?.bytes.toString('utf8')).toBe('last\n');
  });

  it.each([
    {
      label: 'absolute POSIX path',
      entries: [{ path: '/manifest.json', bytes: Buffer.from('{}') }],
      error: 'absolute path',
    },
    {
      label: 'absolute Windows path',
      entries: [{ path: 'C:/manifest.json', bytes: Buffer.from('{}') }],
      error: 'absolute path',
    },
    {
      label: 'parent directory',
      entries: [{ path: 'nested/../manifest.json', bytes: Buffer.from('{}') }],
      error: 'parent directory',
    },
    {
      label: 'non-POSIX separator',
      entries: [{ path: 'nested\\manifest.json', bytes: Buffer.from('{}') }],
      error: 'POSIX path',
    },
    {
      label: 'tab in path',
      entries: [{ path: 'nested/manifest\t.json', bytes: Buffer.from('{}') }],
      error: 'control character',
    },
    {
      label: 'line feed in path',
      entries: [{ path: 'nested/manifest\n.json', bytes: Buffer.from('{}') }],
      error: 'control character',
    },
    {
      label: 'carriage return in path',
      entries: [{ path: 'nested/manifest\r.json', bytes: Buffer.from('{}') }],
      error: 'control character',
    },
    {
      label: 'duplicate entry',
      entries: [
        { path: 'manifest.json', bytes: Buffer.from('{}') },
        { path: 'manifest.json', bytes: Buffer.from('{}') },
      ],
      error: 'duplicate entry',
    },
    {
      label: 'symlink entry',
      entries: [{
        path: 'manifest.json',
        bytes: Buffer.from('{}'),
        kind: 'symlink',
      }],
      error: 'symlink',
    },
  ])('rejects $label', ({ entries, error }) => {
    expect(() => createCanonicalZip(entries)).toThrow(error);
  });
});
