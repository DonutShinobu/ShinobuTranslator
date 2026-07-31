import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  AMO_BUILD_CONTRACT,
} from './amo-build-contract.mjs';
import {
  AMO_CANONICAL_ZIP,
  createCanonicalZip,
} from './amo-canonical-zip.mjs';

const sourceRootFiles = Object.freeze([
  'AMO_SOURCE_BUILD.md',
  'LICENSE',
  'PRIVACY_POLICY.md',
  'THIRD_PARTY_DEPENDENCIES.json',
  'THIRD_PARTY_NOTICES.md',
  'package-lock.json',
  'package.json',
  'tsconfig.json',
]);
const sourceDirectories = Object.freeze([
  'apps',
  'packages',
  'public',
  'src',
]);
const sourceBuildScripts = Object.freeze([
  'scripts/build-worker.mjs',
  'scripts/vite-browser-runtime-boundary.ts',
]);
const deniedDirectorySegments = new Set([
  '.git',
  '.github',
  '.agents',
  '.codex',
  '.idea',
  '.ssh',
  '.tmp',
  '.vscode',
  '.worktrees',
  'artifacts',
  'benchmark',
  'benchmarks',
  'coverage',
  'dist',
  'node_modules',
  'research',
  'test',
  'tests',
  'tmp',
]);
const deniedSourcePaths = new Set([
  'apps/extension/scripts/run-firefox-basic-smoke.mjs',
]);

function utf8PathCompare(left, right) {
  return Buffer.compare(
    Buffer.from(left.path, 'utf8'),
    Buffer.from(right.path, 'utf8'),
  );
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function controlledSegment(segment, controlledNames) {
  const normalized = segment.toLowerCase();
  return [...controlledNames].some((name) =>
    normalized === name
    || normalized.startsWith(`${name}.`)
    || normalized.startsWith(`${name}-`)
    || normalized.startsWith(`${name}_`));
}

function isDeniedSourcePath(path) {
  if (deniedSourcePaths.has(path.toLowerCase())) {
    return true;
  }
  const segments = path.split('/');
  if (
    segments.some((segment) =>
      controlledSegment(segment, deniedDirectorySegments))
  ) {
    return true;
  }
  const fileName = segments.at(-1)?.toLowerCase() ?? '';
  return (
    fileName === '.ds_store'
    || fileName === '.env'
    || fileName.startsWith('.env.')
    || fileName === '.netrc'
    || fileName === '.npmrc'
    || fileName === '.pypirc'
    || fileName === '.yarnrc'
    || fileName === '.yarnrc.yml'
    || fileName === 'credentials.json'
    || fileName === 'credentials.yaml'
    || fileName === 'credentials.yml'
    || fileName === 'secrets.json'
    || fileName === 'secrets.yaml'
    || fileName === 'secrets.yml'
    || fileName === 'id_dsa'
    || fileName === 'id_ecdsa'
    || fileName === 'id_ed25519'
    || fileName === 'id_rsa'
    || fileName.endsWith('.jks')
    || fileName.endsWith('.key')
    || fileName.endsWith('.kdbx')
    || fileName.endsWith('.keystore')
    || fileName.endsWith('.log')
    || fileName.endsWith('.p12')
    || fileName.endsWith('.pem')
    || fileName.endsWith('.pfx')
    || fileName.endsWith('.tmp')
  );
}

function repositoryPath(root, absolutePath) {
  const path = relative(root, absolutePath).replaceAll('\\', '/');
  if (
    path.length === 0
    || path.startsWith('../')
    || path.includes('/../')
  ) {
    throw new Error(
      `AMO source entry resolves outside the source root: ${absolutePath}`,
    );
  }
  return path;
}

function collectFile(root, absolutePath, entries) {
  const path = repositoryPath(root, absolutePath);
  if (isDeniedSourcePath(path)) return;
  const stats = lstatSync(absolutePath);
  if (stats.isSymbolicLink()) {
    throw new Error(`AMO source archive rejects symlink: ${path}`);
  }
  if (!stats.isFile()) {
    throw new Error(`AMO source archive accepts files only: ${path}`);
  }
  entries.push({
    path,
    bytes: readFileSync(absolutePath),
    kind: 'file',
  });
}

function collectDirectory(root, absoluteDirectory, entries) {
  const directoryPath = repositoryPath(root, absoluteDirectory);
  if (isDeniedSourcePath(directoryPath)) return;
  const directoryStats = lstatSync(absoluteDirectory);
  if (directoryStats.isSymbolicLink()) {
    throw new Error(`AMO source archive rejects symlink: ${directoryPath}`);
  }
  if (!directoryStats.isDirectory()) {
    throw new Error(
      `AMO source allowlist directory is not a directory: ${directoryPath}`,
    );
  }
  for (const entry of readdirSync(absoluteDirectory, {
    withFileTypes: true,
  })) {
    const absolutePath = join(absoluteDirectory, entry.name);
    const path = repositoryPath(root, absolutePath);
    if (isDeniedSourcePath(path)) continue;
    if (entry.isSymbolicLink()) {
      throw new Error(`AMO source archive rejects symlink: ${path}`);
    }
    if (entry.isDirectory()) {
      collectDirectory(root, absolutePath, entries);
    } else if (entry.isFile()) {
      collectFile(root, absolutePath, entries);
    } else {
      throw new Error(`AMO source archive accepts files only: ${path}`);
    }
  }
}

export function collectAmoSourceEntries(sourceRoot) {
  const root = resolve(sourceRoot);
  for (const requiredPath of ['package.json', 'package-lock.json']) {
    if (!existsSync(resolve(root, requiredPath))) {
      throw new Error(
        `AMO source archive is missing root package metadata: ${requiredPath}`,
      );
    }
  }
  const entries = [];
  for (const path of sourceRootFiles) {
    const absolutePath = resolve(root, path);
    if (existsSync(absolutePath)) {
      collectFile(root, absolutePath, entries);
    }
  }
  for (const path of sourceDirectories) {
    const absolutePath = resolve(root, path);
    if (existsSync(absolutePath)) {
      collectDirectory(root, absolutePath, entries);
    }
  }
  for (const path of sourceBuildScripts) {
    const absolutePath = resolve(root, path);
    if (existsSync(absolutePath)) {
      collectFile(root, absolutePath, entries);
    }
  }
  return entries.sort(utf8PathCompare);
}

export function collectAmoArchiveEntries(directory) {
  const root = resolve(directory);
  if (!existsSync(root)) {
    throw new Error(`AMO archive input directory does not exist: ${root}`);
  }
  const entries = [];
  const visit = (absoluteDirectory) => {
    for (const entry of readdirSync(absoluteDirectory, {
      withFileTypes: true,
    })) {
      const absolutePath = join(absoluteDirectory, entry.name);
      const path = repositoryPath(root, absolutePath);
      if (entry.isSymbolicLink()) {
        throw new Error(`AMO archive rejects symlink: ${path}`);
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        entries.push({
          path,
          bytes: readFileSync(absolutePath),
          kind: 'file',
        });
      } else {
        throw new Error(`AMO archive accepts files only: ${path}`);
      }
    }
  };
  visit(root);
  return entries.sort(utf8PathCompare);
}

function formatEntryManifest(entries) {
  const sortedEntries = [...entries].sort(utf8PathCompare);
  return Buffer.from(
    `${sortedEntries
      .map((entry) =>
        `${sha256(entry.bytes)}\t${entry.bytes.length}\t${entry.path}`)
      .join('\n')}\n`,
    'utf8',
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function enforceAmoArchiveSize({
  label,
  bytes,
  warn = (message) => console.error(message),
}) {
  const { warningBytes, hardLimitBytes } = AMO_BUILD_CONTRACT.archive;
  if (bytes >= hardLimitBytes) {
    throw new Error(
      `${label} is ${bytes} bytes and reaches the ${hardLimitBytes} byte AMO hard limit.`,
    );
  }
  if (bytes >= warningBytes) {
    warn(
      `[CRITICAL] ${label} is ${bytes} bytes and reaches the ${warningBytes} byte AMO warning threshold.`,
    );
  }
}

export function writeAmoArtifacts({
  outputDirectory,
  extensionVersion,
  xpiEntries,
  sourceEntries,
  receiptInputs,
  warn,
}) {
  if (!xpiEntries.some((entry) => entry.path === 'manifest.json')) {
    throw new Error('Firefox XPI must contain manifest.json at its root.');
  }
  if (!sourceEntries.some((entry) => entry.path === 'package.json')) {
    throw new Error(
      'AMO source archive must contain package.json at its root.',
    );
  }
  if (!/^\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/u.test(extensionVersion)) {
    throw new Error(`Invalid AMO extension version: ${extensionVersion}`);
  }

  const xpiArchive = createCanonicalZip(xpiEntries);
  const sourceArchive = createCanonicalZip(sourceEntries);
  enforceAmoArchiveSize({
    label: 'Firefox XPI',
    bytes: xpiArchive.length,
    warn,
  });
  enforceAmoArchiveSize({
    label: 'AMO source archive',
    bytes: sourceArchive.length,
    warn,
  });

  const fileNames = {
    xpi: `shinobu-translator-${extensionVersion}-firefox.xpi`,
    source: `shinobu-translator-${extensionVersion}-source.zip`,
    xpiManifest: 'xpi-files.sha256',
    sourceManifest: 'source-files.sha256',
    receipt: 'build-receipt.json',
  };
  const xpiManifest = formatEntryManifest(xpiEntries);
  const sourceManifest = formatEntryManifest(sourceEntries);
  const receipt = canonicalize({
    schemaVersion: AMO_BUILD_CONTRACT.schemaVersion,
    uploadable: true,
    extensionVersion,
    runtime: receiptInputs.runtime,
    install: AMO_BUILD_CONTRACT.install,
    lockfileSha256: receiptInputs.lockfileSha256,
    modelPackage: {
      version: receiptInputs.modelManifestVersion,
      manifestSha256: receiptInputs.modelManifestSha256,
      staticAssetManifestSha256:
        receiptInputs.staticAssetManifestSha256,
    },
    canonicalZip: {
      timestamp: '1980-01-01T00:00:00.000Z',
      pathEncoding: 'UTF-8',
      pathSeparator: '/',
      entryOrder: 'UTF-8 byte order',
      mode: '0644',
      compression: 'deflate',
      compressionLevel: AMO_CANONICAL_ZIP.compressionLevel,
      compressionWindowBits:
        AMO_CANONICAL_ZIP.compressionWindowBits,
      compressionMemoryLevel:
        AMO_CANONICAL_ZIP.compressionMemoryLevel,
      compressionStrategy: AMO_CANONICAL_ZIP.compressionStrategy,
      platform: 'unix',
      comment: AMO_CANONICAL_ZIP.comment,
      extra: AMO_CANONICAL_ZIP.extra,
    },
    outputs: {
      firefoxXpi: {
        file: fileNames.xpi,
        bytes: xpiArchive.length,
        sha256: sha256(xpiArchive),
        entryManifest: fileNames.xpiManifest,
        entryManifestSha256: sha256(xpiManifest),
      },
      sourceArchive: {
        file: fileNames.source,
        bytes: sourceArchive.length,
        sha256: sha256(sourceArchive),
        entryManifest: fileNames.sourceManifest,
        entryManifestSha256: sha256(sourceManifest),
      },
    },
  });
  const receiptBytes = Buffer.from(
    `${JSON.stringify(receipt, null, 2)}\n`,
    'utf8',
  );

  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(resolve(outputDirectory, fileNames.xpi), xpiArchive);
  writeFileSync(resolve(outputDirectory, fileNames.source), sourceArchive);
  writeFileSync(
    resolve(outputDirectory, fileNames.xpiManifest),
    xpiManifest,
  );
  writeFileSync(
    resolve(outputDirectory, fileNames.sourceManifest),
    sourceManifest,
  );
  writeFileSync(resolve(outputDirectory, fileNames.receipt), receiptBytes);

  return {
    fileNames,
    receipt,
  };
}
