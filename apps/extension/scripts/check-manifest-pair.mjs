#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  generateExtensionManifest,
} from './generate-manifest.mjs';
import { readCliOption } from './cli-options.mjs';

const declaredDifferenceRoots = new Set([
  'background',
  'browser_specific_settings',
  'minimum_chrome_version',
  'optional_permissions',
  'permissions',
]);

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function withoutDeclaredDifferences(manifest) {
  return Object.fromEntries(
    Object.entries(manifest).filter(
      ([key]) => !declaredDifferenceRoots.has(key),
    ),
  );
}

function firstDifference(left, right, path = '') {
  if (Object.is(left, right)) return undefined;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return path;
    if (left.length !== right.length) return path;
    for (let index = 0; index < left.length; index += 1) {
      const difference = firstDifference(
        left[index],
        right[index],
        `${path}[${index}]`,
      );
      if (difference !== undefined) return difference;
    }
    return undefined;
  }
  const leftIsObject =
    left !== null && typeof left === 'object';
  const rightIsObject =
    right !== null && typeof right === 'object';
  if (!leftIsObject || !rightIsObject) return path;
  const keys = [...new Set([
    ...Object.keys(left),
    ...Object.keys(right),
  ])].sort();
  for (const key of keys) {
    const childPath = path ? `${path}.${key}` : key;
    if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) {
      return childPath;
    }
    const difference = firstDifference(left[key], right[key], childPath);
    if (difference !== undefined) return difference;
  }
  return undefined;
}

function assertDeclaredTargetFields(actual, expected, target) {
  for (const key of declaredDifferenceRoots) {
    const difference = firstDifference(actual[key], expected[key], key);
    if (difference !== undefined) {
      throw new Error(
        `${target} manifest violates its declared target contract at ${difference}`,
      );
    }
  }
}

export function assertExtensionManifestPair({
  chromeManifest,
  firefoxManifest,
}) {
  const sharedDifference = firstDifference(
    withoutDeclaredDifferences(chromeManifest),
    withoutDeclaredDifferences(firefoxManifest),
  );
  if (sharedDifference !== undefined) {
    throw new Error(
      `undeclared target manifest difference at ${sharedDifference}`,
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
}

function runCli(argumentsList) {
  const chromePath = readCliOption(argumentsList, '--chrome');
  const firefoxPath = readCliOption(argumentsList, '--firefox');
  if (!chromePath) throw new Error('--chrome is required');
  if (!firefoxPath) throw new Error('--firefox is required');
  assertExtensionManifestPair({
    chromeManifest: readJson(resolve(process.cwd(), chromePath)),
    firefoxManifest: readJson(resolve(process.cwd(), firefoxPath)),
  });
  console.log('Chrome and Firefox manifests differ only at declared target fields.');
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runCli(process.argv.slice(2));
}
