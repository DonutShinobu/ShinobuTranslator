#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  generateExtensionManifest,
  serializeExtensionManifest,
} from './generate-manifest.mjs';
import { readCliOption } from './cli-options.mjs';

const declaredDifferencePaths = new Set([
  'background.scripts',
  'background.service_worker',
  'browser_specific_settings',
  'minimum_chrome_version',
  'optional_permissions',
  'permissions',
]);

function readManifest(path) {
  const bytes = readFileSync(path);
  return {
    bytes,
    manifest: JSON.parse(bytes.toString('utf8')),
  };
}

function collectDifferences(left, right, path = '') {
  if (Object.is(left, right)) return [];
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return [path];
    if (left.length !== right.length) return [path];
    for (let index = 0; index < left.length; index += 1) {
      if (
        collectDifferences(left[index], right[index], `${path}[${index}]`)
          .length > 0
      ) {
        return [path];
      }
    }
    return [];
  }
  const leftIsObject =
    left !== null && typeof left === 'object';
  const rightIsObject =
    right !== null && typeof right === 'object';
  if (!leftIsObject || !rightIsObject) return [path];
  const keys = [...new Set([
    ...Object.keys(left),
    ...Object.keys(right),
  ])].sort();
  const differences = [];
  for (const key of keys) {
    const childPath = path ? `${path}.${key}` : key;
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) {
      differences.push(childPath);
      continue;
    }
    differences.push(...collectDifferences(left[key], right[key], childPath));
  }
  return differences;
}

function assertDeclaredTargetFields(actual, expected, target) {
  for (const differencePath of declaredDifferencePaths) {
    const differenceRoot = differencePath.split('.')[0];
    const differences = collectDifferences(
      actual[differenceRoot],
      expected[differenceRoot],
      differenceRoot,
    );
    if (differences.length > 0) {
      throw new Error(
        `${target} manifest violates its declared target contract at ${differences[0]}`,
      );
    }
  }
}

function firstByteDifference(actual, expected) {
  const sharedLength = Math.min(actual.length, expected.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (actual[index] !== expected[index]) return index;
  }
  return actual.length === expected.length ? undefined : sharedLength;
}

function assertMatchesDeclarativeSpecification({
  bytes,
  manifest,
  target,
}) {
  const expectedManifest = generateExtensionManifest({ target });
  const structuralDifferences = collectDifferences(
    manifest,
    expectedManifest,
  );
  if (structuralDifferences.length > 0) {
    throw new Error(
      `${target === 'chrome' ? 'Chrome' : 'Firefox'} manifest does not byte-match the declarative specification at ${structuralDifferences.join(', ')}`,
    );
  }
  const expectedBytes = Buffer.from(
    serializeExtensionManifest(expectedManifest),
    'utf8',
  );
  const byteOffset = firstByteDifference(bytes, expectedBytes);
  if (byteOffset !== undefined) {
    throw new Error(
      `${target === 'chrome' ? 'Chrome' : 'Firefox'} manifest does not byte-match the declarative specification at byte offset ${byteOffset}`,
    );
  }
}

export function assertExtensionManifestPair({
  chromeManifest,
  firefoxManifest,
}) {
  const actualDifferencePaths = collectDifferences(
    chromeManifest,
    firefoxManifest,
  );
  const undeclaredDifferencePaths = actualDifferencePaths.filter(
    (path) => !declaredDifferencePaths.has(path),
  );
  if (undeclaredDifferencePaths.length > 0) {
    throw new Error(
      `undeclared target manifest difference at ${undeclaredDifferencePaths.join(', ')}`,
    );
  }

  assertDeclaredTargetFields(
    chromeManifest,
    generateExtensionManifest({ target: 'chrome' }),
    'Chrome',
  );
  assertDeclaredTargetFields(
    firefoxManifest,
    generateExtensionManifest({ target: 'firefox' }),
    'Firefox',
  );
  return actualDifferencePaths;
}

function runCli(argumentsList) {
  const chromePath = readCliOption(argumentsList, '--chrome');
  const firefoxPath = readCliOption(argumentsList, '--firefox');
  if (!chromePath) throw new Error('--chrome is required');
  if (!firefoxPath) throw new Error('--firefox is required');
  const chrome = readManifest(resolve(process.cwd(), chromePath));
  const firefox = readManifest(resolve(process.cwd(), firefoxPath));
  const actualDifferencePaths = assertExtensionManifestPair({
    chromeManifest: chrome.manifest,
    firefoxManifest: firefox.manifest,
  });
  assertMatchesDeclarativeSpecification({
    ...chrome,
    target: 'chrome',
  });
  assertMatchesDeclarativeSpecification({
    ...firefox,
    target: 'firefox',
  });
  console.log('Actual manifest difference paths:');
  for (const differencePath of actualDifferencePaths) {
    console.log(`- ${differencePath}`);
  }
  console.log('Chrome and Firefox manifests differ only at declared target fields.');
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runCli(process.argv.slice(2));
}
