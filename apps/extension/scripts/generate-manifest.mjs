#!/usr/bin/env node
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCliOption } from './cli-options.mjs';

const extensionRoot = resolve(import.meta.dirname, '..');
const manifestSourceDirectory = resolve(extensionRoot, 'manifest');
const extensionPackagePath = resolve(extensionRoot, 'package.json');
const exactCsp =
  "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'self';";
const commonPermissionWhitelist = new Set([
  'contextMenus',
  'declarativeNetRequest',
  'storage',
  'tabs',
  'webRequest',
]);
const chromeRequiredPermissionAdditions = new Set([
  'cookies',
  'offscreen',
]);
const firefoxRequiredPermissionAdditions = new Set(['menus']);
const firefoxRequiredPermissionRemovals = new Set(['contextMenus']);
const firefoxOptionalPermissionAdditions = new Set(['cookies']);

function fail(path, message) {
  throw new Error(`Invalid extension manifest source at ${path}: ${message}`);
}

function assertRecord(value, path) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    fail(path, 'expected an object');
  }
}

function assertExactKeys(value, allowedKeys, path) {
  assertRecord(value, path);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(path, `unknown property ${JSON.stringify(key)}`);
    }
  }
  for (const key of allowedKeys) {
    if (!Object.hasOwn(value, key)) {
      fail(path, `missing required property ${JSON.stringify(key)}`);
    }
  }
}

function assertString(value, path) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(path, 'expected a non-empty string');
  }
}

function assertStringArray(value, path) {
  if (!Array.isArray(value)) {
    fail(path, 'expected an array');
  }
  value.forEach((item, index) => assertString(item, `${path}[${index}]`));
  if (new Set(value).size !== value.length) {
    fail(path, 'duplicate values are not allowed');
  }
}

function assertExactStringSet(value, expected, path) {
  assertStringArray(value, path);
  const actual = [...value].sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail(path, `expected exactly ${JSON.stringify(wanted)}`);
  }
}

function assertIconSet(value, path) {
  assertExactKeys(value, ['16', '32', '48', '128'], path);
  for (const size of ['16', '32', '48', '128']) {
    assertString(value[size], `${path}.${size}`);
  }
}

function validateCommonSource(common) {
  assertExactKeys(
    common,
    [
      'manifest_version',
      'name',
      'description',
      'action',
      'icons',
      'commands',
      'content_security_policy',
      'permissions',
      'host_permissions',
      'content_scripts',
      'web_accessible_resources',
    ],
    'common',
  );
  if (common.manifest_version !== 3) {
    fail('common.manifest_version', 'expected 3');
  }
  assertString(common.name, 'common.name');
  assertString(common.description, 'common.description');

  assertExactKeys(
    common.action,
    ['default_title', 'default_popup', 'default_icon'],
    'common.action',
  );
  assertString(common.action.default_title, 'common.action.default_title');
  assertString(common.action.default_popup, 'common.action.default_popup');
  assertIconSet(common.action.default_icon, 'common.action.default_icon');
  assertIconSet(common.icons, 'common.icons');

  assertRecord(common.commands, 'common.commands');
  for (const [commandName, command] of Object.entries(common.commands)) {
    const path = `common.commands.${commandName}`;
    assertExactKeys(command, ['suggested_key', 'description'], path);
    assertExactKeys(command.suggested_key, ['default'], `${path}.suggested_key`);
    assertString(command.suggested_key.default, `${path}.suggested_key.default`);
    assertString(command.description, `${path}.description`);
  }

  assertExactKeys(
    common.content_security_policy,
    ['extension_pages'],
    'common.content_security_policy',
  );
  if (common.content_security_policy.extension_pages !== exactCsp) {
    fail(
      'common.content_security_policy.extension_pages',
      `expected ${JSON.stringify(exactCsp)}`,
    );
  }

  assertExactStringSet(
    common.permissions,
    commonPermissionWhitelist,
    'common.permissions',
  );
  assertExactStringSet(
    common.host_permissions,
    new Set(['<all_urls>']),
    'common.host_permissions',
  );

  if (!Array.isArray(common.content_scripts) || common.content_scripts.length === 0) {
    fail('common.content_scripts', 'expected at least one content script');
  }
  common.content_scripts.forEach((entry, index) => {
    const path = `common.content_scripts[${index}]`;
    assertExactKeys(entry, ['matches', 'js', 'run_at'], path);
    assertStringArray(entry.matches, `${path}.matches`);
    assertStringArray(entry.js, `${path}.js`);
    if (entry.run_at !== 'document_idle') {
      fail(`${path}.run_at`, 'expected "document_idle"');
    }
  });

  if (
    !Array.isArray(common.web_accessible_resources)
    || common.web_accessible_resources.length === 0
  ) {
    fail(
      'common.web_accessible_resources',
      'expected at least one resource declaration',
    );
  }
  common.web_accessible_resources.forEach((entry, index) => {
    const path = `common.web_accessible_resources[${index}]`;
    assertExactKeys(entry, ['resources', 'matches'], path);
    assertStringArray(entry.resources, `${path}.resources`);
    assertStringArray(entry.matches, `${path}.matches`);
  });
}

function validatePermissionDelta(value, path) {
  assertExactKeys(value, ['add', 'remove'], path);
  assertStringArray(value.add, `${path}.add`);
  assertStringArray(value.remove, `${path}.remove`);
}

function validateChromeTarget(target) {
  assertExactKeys(
    target,
    [
      'schema_version',
      'browser',
      'minimum_version',
      'background',
      'permission_overrides',
    ],
    'target',
  );
  if (target.schema_version !== 1) {
    fail('target.schema_version', 'expected 1');
  }
  if (target.browser !== 'chrome') {
    fail('target.browser', 'expected "chrome"');
  }
  if (target.minimum_version !== '109') {
    fail('target.minimum_version', 'expected "109"');
  }
  assertExactKeys(
    target.background,
    ['kind', 'script', 'type'],
    'target.background',
  );
  if (
    target.background.kind !== 'service_worker'
    || target.background.script !== 'background.js'
    || target.background.type !== 'module'
  ) {
    fail(
      'target.background',
      'expected the module background.js service worker contract',
    );
  }
  assertExactKeys(
    target.permission_overrides,
    ['required', 'optional'],
    'target.permission_overrides',
  );
  validatePermissionDelta(
    target.permission_overrides.required,
    'target.permission_overrides.required',
  );
  validatePermissionDelta(
    target.permission_overrides.optional,
    'target.permission_overrides.optional',
  );
  assertExactStringSet(
    target.permission_overrides.required.add,
    chromeRequiredPermissionAdditions,
    'target.permission_overrides.required.add',
  );
  assertExactStringSet(
    target.permission_overrides.required.remove,
    new Set(),
    'target.permission_overrides.required.remove',
  );
  assertExactStringSet(
    target.permission_overrides.optional.add,
    new Set(),
    'target.permission_overrides.optional.add',
  );
  assertExactStringSet(
    target.permission_overrides.optional.remove,
    new Set(),
    'target.permission_overrides.optional.remove',
  );
}

function validateFirefoxTarget(target) {
  assertExactKeys(
    target,
    [
      'schema_version',
      'browser',
      'background',
      'gecko',
      'permission_overrides',
    ],
    'target',
  );
  if (target.schema_version !== 1) {
    fail('target.schema_version', 'expected 1');
  }
  if (target.browser !== 'firefox') {
    fail('target.browser', 'expected "firefox"');
  }
  assertExactKeys(
    target.background,
    ['kind', 'scripts', 'type'],
    'target.background',
  );
  if (
    target.background.kind !== 'scripts'
    || target.background.type !== 'module'
  ) {
    fail(
      'target.background',
      'expected a module background scripts contract',
    );
  }
  assertExactStringSet(
    target.background.scripts,
    new Set(['background.js']),
    'target.background.scripts',
  );

  assertExactKeys(
    target.gecko,
    ['id', 'strict_min_version', 'data_collection_permissions'],
    'target.gecko',
  );
  if (target.gecko.id !== 'shinobu-translator@donutshinobu') {
    fail(
      'target.gecko.id',
      'expected "shinobu-translator@donutshinobu"',
    );
  }
  if (target.gecko.strict_min_version !== '140.0') {
    fail('target.gecko.strict_min_version', 'expected "140.0"');
  }
  assertExactKeys(
    target.gecko.data_collection_permissions,
    ['required', 'optional'],
    'target.gecko.data_collection_permissions',
  );
  assertExactStringSet(
    target.gecko.data_collection_permissions.required,
    new Set(['websiteContent']),
    'target.gecko.data_collection_permissions.required',
  );
  assertExactStringSet(
    target.gecko.data_collection_permissions.optional,
    new Set(['authenticationInfo']),
    'target.gecko.data_collection_permissions.optional',
  );

  assertExactKeys(
    target.permission_overrides,
    ['required', 'optional'],
    'target.permission_overrides',
  );
  validatePermissionDelta(
    target.permission_overrides.required,
    'target.permission_overrides.required',
  );
  validatePermissionDelta(
    target.permission_overrides.optional,
    'target.permission_overrides.optional',
  );
  assertExactStringSet(
    target.permission_overrides.required.add,
    firefoxRequiredPermissionAdditions,
    'target.permission_overrides.required.add',
  );
  assertExactStringSet(
    target.permission_overrides.required.remove,
    firefoxRequiredPermissionRemovals,
    'target.permission_overrides.required.remove',
  );
  assertExactStringSet(
    target.permission_overrides.optional.add,
    firefoxOptionalPermissionAdditions,
    'target.permission_overrides.optional.add',
  );
  assertExactStringSet(
    target.permission_overrides.optional.remove,
    new Set(),
    'target.permission_overrides.optional.remove',
  );
}

function applySetDelta(baseValues, delta, path) {
  const values = new Set(baseValues);
  for (const value of delta.remove) {
    if (!values.delete(value)) {
      fail(path, `cannot remove missing value ${JSON.stringify(value)}`);
    }
  }
  for (const value of delta.add) {
    if (values.has(value)) {
      fail(path, `cannot add existing value ${JSON.stringify(value)}`);
    }
    values.add(value);
  }
  return [...values].sort();
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

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function generateExtensionManifest({
  target,
  commonPath = resolve(manifestSourceDirectory, 'common.json'),
  targetPath = resolve(manifestSourceDirectory, 'targets', `${target}.json`),
}) {
  if (target !== 'chrome' && target !== 'firefox') {
    throw new Error(`Unsupported extension manifest target: ${target}`);
  }
  const common = readJson(commonPath);
  const targetSource = readJson(targetPath);
  const extensionPackage = readJson(extensionPackagePath);
  validateCommonSource(common);
  if (target === 'chrome') {
    validateChromeTarget(targetSource);
  } else {
    validateFirefoxTarget(targetSource);
  }
  assertString(extensionPackage.version, 'extension package version');

  const permissions = applySetDelta(
    common.permissions,
    targetSource.permission_overrides.required,
    'target.permission_overrides.required',
  );
  const optionalPermissions = applySetDelta(
    [],
    targetSource.permission_overrides.optional,
    'target.permission_overrides.optional',
  );
  const manifest = {
    manifest_version: common.manifest_version,
    name: common.name,
    version: extensionPackage.version,
    description: common.description,
    action: common.action,
    icons: common.icons,
    commands: common.commands,
    content_security_policy: common.content_security_policy,
    permissions,
    host_permissions: common.host_permissions,
    content_scripts: common.content_scripts,
    web_accessible_resources: common.web_accessible_resources,
  };
  if (optionalPermissions.length > 0) {
    manifest.optional_permissions = optionalPermissions;
  }
  if (target === 'chrome') {
    manifest.background = {
      service_worker: targetSource.background.script,
      type: targetSource.background.type,
    };
    manifest.minimum_chrome_version = targetSource.minimum_version;
  } else {
    manifest.background = {
      scripts: targetSource.background.scripts,
      type: targetSource.background.type,
    };
    manifest.browser_specific_settings = {
      gecko: {
        id: targetSource.gecko.id,
        strict_min_version: targetSource.gecko.strict_min_version,
        data_collection_permissions:
          targetSource.gecko.data_collection_permissions,
      },
    };
  }
  return canonicalize(manifest);
}

export function serializeExtensionManifest(manifest) {
  return `${JSON.stringify(canonicalize(manifest), null, 2)}\n`;
}

export function writeExtensionManifest({
  outputPath,
  ...generationOptions
}) {
  const bytes = serializeExtensionManifest(
    generateExtensionManifest(generationOptions),
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, bytes, 'utf8');
  return bytes;
}

function runCli(argumentsList) {
  const target = readCliOption(argumentsList, '--target');
  const outputPath = readCliOption(argumentsList, '--output');
  if (readCliOption(argumentsList, '--package')) {
    throw new Error(
      'manifest version always comes from apps/extension/package.json',
    );
  }
  if (!target) throw new Error('--target is required');
  if (!outputPath) throw new Error('--output is required');
  writeExtensionManifest({
    target,
    outputPath: resolve(process.cwd(), outputPath),
    commonPath: readCliOption(argumentsList, '--common'),
    targetPath: readCliOption(argumentsList, '--target-source'),
  });
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  runCli(process.argv.slice(2));
}
