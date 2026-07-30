import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const LEGACY_DETECTOR_PATTERN = /tesseract|tessdata/iu;
const REMOTE_EXECUTABLE_PATTERN =
  /\bhttps?:\/\/[^\s"'`<>]+?\.(?:m?js|wasm)(?:[?#][^\s"'`<>]*)?/iu;
const TEXT_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.mjs',
  '.txt',
  '.xml',
]);

function extensionOf(path) {
  const separator = path.lastIndexOf('.');
  return separator < 0 ? '' : path.slice(separator).toLowerCase();
}

function collectFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

export function assertNoRemoteDetectionFallbackResources(directory) {
  for (const path of collectFiles(directory)) {
    const packagePath = relative(directory, path).replaceAll('\\', '/');
    if (LEGACY_DETECTOR_PATTERN.test(packagePath)) {
      throw new Error(
        `Release package contains a forbidden Tesseract resource: ${packagePath}`,
      );
    }
    if (!TEXT_EXTENSIONS.has(extensionOf(path))) continue;
    const source = readFileSync(path, 'utf8');
    if (LEGACY_DETECTOR_PATTERN.test(source)) {
      throw new Error(
        `Release package contains a forbidden Tesseract reference: ${packagePath}`,
      );
    }
    const remoteExecutable = source.match(REMOTE_EXECUTABLE_PATTERN)?.[0];
    if (remoteExecutable) {
      throw new Error(
        `Release package contains a remote executable resource URL in ${packagePath}: `
        + remoteExecutable,
      );
    }
  }
}
