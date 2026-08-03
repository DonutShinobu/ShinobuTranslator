import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

function readRequiredOption(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline?.slice(name.length + 1)) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`);
  return value;
}

function readOptionalOption(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1) || undefined;
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : undefined;
}

const chromiumDir = resolve(process.cwd(), readRequiredOption('--chromium'));
const firefoxDir = resolve(process.cwd(), readRequiredOption('--firefox'));
const reportPathOption = readOptionalOption('--report');

for (const [target, directory] of [['chromium', chromiumDir], ['firefox', firefoxDir]]) {
  if (!existsSync(directory)) throw new Error(`${target} directory does not exist: ${directory}`);
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, normalize(nested)]),
  );
}

function assertEqual(label, left, right) {
  if (JSON.stringify(normalize(left)) !== JSON.stringify(normalize(right))) {
    throw new Error(`Extension parity mismatch: ${label}`);
  }
}

const chromiumManifest = JSON.parse(readFileSync(join(chromiumDir, 'manifest.json'), 'utf8'));
const firefoxManifest = JSON.parse(readFileSync(join(firefoxDir, 'manifest.json'), 'utf8'));
for (const field of [
  'manifest_version',
  'name',
  'version',
  'description',
  'action',
  'icons',
  'optional_permissions',
  'host_permissions',
  'commands',
  'content_scripts',
  'web_accessible_resources',
  'content_security_policy',
]) {
  assertEqual(`manifest.${field}`, chromiumManifest[field], firefoxManifest[field]);
}
assertEqual(
  'manifest common permission intent',
  chromiumManifest.permissions.filter((permission) => permission !== 'offscreen').sort(),
  [...firefoxManifest.permissions].sort(),
);

function collectFiles(directory) {
  const result = new Map();
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        result.set(relative(directory, path).replaceAll('\\', '/'), path);
      }
    }
  };
  visit(directory);
  return result;
}

function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isAllowedTargetDifference(path) {
  return path === 'manifest.json'
    || path === 'background-chromium.js'
    || path === 'background-firefox.js'
    || path === 'background-firefox.html'
    || path === 'offscreen.html'
    || path === 'offscreen.js';
}

const chromiumFiles = collectFiles(chromiumDir);
const firefoxFiles = collectFiles(firefoxDir);
const paths = [...new Set([...chromiumFiles.keys(), ...firefoxFiles.keys()])].sort();
const verified = [];
const allowedDifferences = [];
for (const path of paths) {
  const chromiumPath = chromiumFiles.get(path);
  const firefoxPath = firefoxFiles.get(path);
  if (isAllowedTargetDifference(path)) {
    if (!chromiumPath || !firefoxPath || hash(chromiumPath) !== hash(firefoxPath)) {
      allowedDifferences.push(path);
    } else {
      verified.push(path);
    }
    continue;
  }
  if (!chromiumPath || !firefoxPath) {
    throw new Error(`Non-adapter artifact exists in only one target: ${path}`);
  }
  const chromiumHash = hash(chromiumPath);
  const firefoxHash = hash(firefoxPath);
  if (chromiumHash !== firefoxHash) {
    throw new Error(`Shared artifact SHA-256 mismatch: ${path}`);
  }
  verified.push(path);
}

for (const path of paths.filter((value) => /^(models|ort|fonts)\//.test(value))) {
  if (!verified.includes(path)) throw new Error(`Public runtime asset was not parity-verified: ${path}`);
}

const report = {
  schemaVersion: 1,
  version: chromiumManifest.version,
  chromiumDir,
  firefoxDir,
  verifiedSharedFileCount: verified.length,
  verifiedSharedFiles: verified,
  allowedTargetDifferences: allowedDifferences,
};
if (reportPathOption) {
  const reportPath = resolve(process.cwd(), reportPathOption);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`Extension parity verified for ${verified.length} shared files.`);
