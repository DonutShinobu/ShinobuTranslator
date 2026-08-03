import { createHash } from 'node:crypto';
import {
  mkdirSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';

const MAX_PACKAGE_BYTES = 170 * 1024 * 1024;
const FIXED_ZIP_DATE = new Date('2000-01-01T00:00:00.000Z');
const root = resolve(import.meta.dirname, '..');

function readOption(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? resolve(process.cwd(), value) : undefined;
}

const chromiumDir = readOption('--chromium');
const firefoxDir = readOption('--firefox');
const artifactsDir = readOption('--artifacts');
if (!artifactsDir || (!chromiumDir && !firefoxDir)) {
  throw new Error('--artifacts and at least one of --chromium/--firefox are required');
}
mkdirSync(artifactsDir, { recursive: true });

const extensionPackage = JSON.parse(
  readFileSync(resolve(root, 'apps/extension/package.json'), 'utf8'),
);
const version = extensionPackage.version;

function collectDirectoryFiles(directory) {
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(directory);
  return files.sort((left, right) => left.localeCompare(right));
}

async function createZip(entries, outputPath) {
  const zip = new JSZip();
  for (const entry of entries) {
    zip.file(entry.name, readFileSync(entry.path), {
      date: FIXED_ZIP_DATE,
      unixPermissions: entry.executable ? 0o755 : 0o644,
      createFolders: false,
    });
  }
  const bytes = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  });
  writeFileSync(outputPath, bytes);
  if (bytes.length > MAX_PACKAGE_BYTES) {
    throw new Error(
      `${basename(outputPath)} exceeds the 170 MiB budget: ${(bytes.length / 1024 / 1024).toFixed(2)} MiB`,
    );
  }
  return outputPath;
}

async function packageDist(target, directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.version !== version) {
    throw new Error(`${target} manifest version does not match extension package version`);
  }
  const output = join(artifactsDir, `ShinobuTranslator-${target}-v${version}.zip`);
  return createZip(
    collectDirectoryFiles(directory).map((path) => ({
      name: relative(directory, path).replaceAll('\\', '/'),
      path,
    })),
    output,
  );
}

async function packageSource() {
  const listed = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root },
  ).toString('utf8').split('\0').filter(Boolean).sort();
  const excluded = /^(?:artifacts|node_modules|apps\/extension\/dist(?:-|\/)|\.codegraph)(?:\/|$)/;
  const entries = listed
    .filter((path) => !excluded.test(path.replaceAll('\\', '/')))
    .filter((path) => existsSync(resolve(root, path)))
    .filter((path) => statSync(resolve(root, path)).isFile())
    .map((name) => ({
      name: name.replaceAll('\\', '/'),
      path: resolve(root, name),
      executable: (statSync(resolve(root, name)).mode & 0o111) !== 0,
    }));
  return createZip(
    entries,
    join(artifactsDir, `ShinobuTranslator-source-v${version}.zip`),
  );
}

const outputs = [];
if (chromiumDir) outputs.push(await packageDist('chromium', chromiumDir));
if (firefoxDir) outputs.push(await packageDist('firefox', firefoxDir));
outputs.push(await packageSource());
const parityReport = join(artifactsDir, 'extension-parity-report.json');
if (existsSync(parityReport)) outputs.push(parityReport);

const checksums = outputs
  .map((path) => {
    const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
    return `${digest}  ${basename(path)}`;
  })
  .join('\n');
writeFileSync(join(artifactsDir, 'SHA256SUMS.txt'), `${checksums}\n`);

for (const path of outputs) {
  const size = statSync(path).size / 1024 / 1024;
  console.log(`${basename(path)}: ${size.toFixed(2)} MiB`);
}
