import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  generateExtensionManifest,
  serializeExtensionManifest,
} from './generate-manifest.mjs';
import { readCliOption } from './cli-options.mjs';

const root = resolve(import.meta.dirname, '../../..');
const argumentsList = process.argv.slice(2);
const requestedDistDir = readCliOption(argumentsList, '--dist');
const distDir = requestedDistDir
  ? resolve(process.cwd(), requestedDistDir)
  : join(root, 'apps', 'extension', 'dist', 'chrome');
const target = readCliOption(argumentsList, '--target') ?? 'chrome';
if (!['chrome', 'firefox', 'benchmark'].includes(target)) {
  throw new Error(`Unsupported extension release target: ${target}`);
}
const benchmarkBuild = target === 'benchmark';
const manifestTarget = target === 'firefox' ? 'firefox' : 'chrome';
const forbiddenBridgeTokens = [
  '__shinobu_bake',
  '__shinobu_render',
  '__shinobu_bridge',
];
const forbiddenLegacyWorkerTokens = [
  'runOcrBatchDecode',
  'runOcrSplitBatchDecode',
  'runOcrSingleDecode',
  'runOcrColorBatch',
  'runOcrColorSingle',
  'decodeAutoregressive',
  'gpuArgmax',
  'ocr_encoder',
  'ocr_decoder',
  'fg_ind',
];
const benchmarkArtifacts = [
  'benchmark.html',
  'benchmark.js',
  'benchmark-chunks',
  'benchmark-assets',
];
const forbiddenLegacyModelArtifacts = [
  'ocr.onnx',
  'ocr_encoder.onnx',
  'ocr_decoder.onnx',
  'ocr_dict.txt',
  'ch_PP-OCRv5_rec_mobile.onnx',
  'paddleocr_v5_dict.txt',
  'PP-OCRv6_small_rec.onnx',
  'lama_fp32.onnx',
];
const requiredReleaseArtifacts = [
  'manifest.json',
  'popup.html',
  'popup.js',
  'background.js',
  'content.js',
  'chunks/messages.js',
  'chunks/localPipelineProtocol.js',
  'chunks/perfTrace.js',
  'onnxWorker.js',
];
if (manifestTarget === 'chrome') {
  requiredReleaseArtifacts.push(
    'offscreen.html',
    'offscreen.js',
    'chunks/onnxWorkerBridge.js',
  );
}

function collectJavaScriptFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJavaScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(path);
    }
  }
  return files;
}

function matchesResourcePattern(pattern, resource) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replaceAll('*', '.*');
  return new RegExp(`^${escaped}$`).test(resource);
}

if (!existsSync(distDir)) {
  throw new Error(`Release artifact directory does not exist: ${distDir}`);
}

for (const artifact of requiredReleaseArtifacts) {
  if (!existsSync(join(distDir, artifact))) {
    throw new Error(`Release build is missing required artifact: ${artifact}`);
  }
}

const javaScriptFiles = collectJavaScriptFiles(distDir);
for (const file of javaScriptFiles) {
  const source = readFileSync(file, 'utf8');
  for (const token of forbiddenBridgeTokens) {
    if (source.includes(token)) {
      throw new Error(`Release artifact contains forbidden benchmark bridge token ${token}: ${file}`);
    }
  }
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`JavaScript syntax check failed for ${file}: ${detail}`);
  }
}

const workerSource = readFileSync(join(distDir, 'onnxWorker.js'), 'utf8');
for (const token of forbiddenLegacyWorkerTokens) {
  if (workerSource.includes(token)) {
    throw new Error(`Release Worker contains forbidden legacy OCR token ${token}`);
  }
}

const manifestPath = join(distDir, 'manifest.json');
const manifestBytes = readFileSync(manifestPath, 'utf8');
const expectedManifestBytes = serializeExtensionManifest(
  generateExtensionManifest({ target: manifestTarget }),
);
if (manifestBytes !== expectedManifestBytes) {
  throw new Error(
    `${target} manifest does not byte-match the declarative source and extension workspace version.`,
  );
}
const manifest = JSON.parse(manifestBytes);
const extensionPackage = JSON.parse(
  readFileSync(join(root, 'apps', 'extension', 'package.json'), 'utf8'),
);
if (manifest.version !== extensionPackage.version) {
  throw new Error(
    `Extension manifest version ${manifest.version} does not match workspace version ${extensionPackage.version}.`,
  );
}
if (manifestTarget === 'chrome') {
  if (manifest.minimum_chrome_version !== '109') {
    throw new Error('Chrome manifest must require Chromium 109 for the Offscreen API.');
  }
  if (!Array.isArray(manifest.permissions) || !manifest.permissions.includes('offscreen')) {
    throw new Error('Chrome manifest is missing the offscreen permission.');
  }
} else {
  if (
    existsSync(join(distDir, 'offscreen.html'))
    || existsSync(join(distDir, 'offscreen.js'))
  ) {
    throw new Error('Firefox release build contains a Chrome-only offscreen host.');
  }
  if (
    manifest.browser_specific_settings?.gecko?.id
      !== 'shinobu-translator@donutshinobu'
    || manifest.browser_specific_settings?.gecko?.strict_min_version !== '140.0'
  ) {
    throw new Error('Firefox manifest is missing the fixed Gecko identity contract.');
  }
}
if (!String(manifest.content_security_policy?.extension_pages ?? '').includes("worker-src 'self'")) {
  throw new Error("Release manifest must explicitly restrict worker-src to 'self'.");
}
const exposedResources = (manifest.web_accessible_resources ?? [])
  .flatMap((entry) => Array.isArray(entry.resources) ? entry.resources : []);
const contentSource = readFileSync(join(distDir, 'content.js'), 'utf8');
const contentRuntimeResources = new Set(
  [...contentSource.matchAll(/chrome\.runtime\.getURL\("([^"]+)"\)/g)]
    .map((match) => match[1]),
);
for (const resource of contentRuntimeResources) {
  if (!existsSync(join(distDir, resource))) {
    throw new Error(`Content script references missing runtime resource: ${resource}`);
  }
  if (!exposedResources.some((pattern) => matchesResourcePattern(pattern, resource))) {
    throw new Error(
      `Content script runtime resource is not declared web-accessible: ${resource}`,
    );
  }
}
for (const privateArtifact of ['models/*', 'ort/*', 'onnxWorker.js', 'chunks/*', 'chunks/onnxWorkerBridge.js']) {
  if (exposedResources.includes(privateArtifact)) {
    throw new Error(`Release manifest exposes private offscreen runtime artifact: ${privateArtifact}`);
  }
}

for (const artifact of forbiddenLegacyModelArtifacts) {
  if (existsSync(join(distDir, 'models', artifact))) {
    throw new Error(`Release build contains forbidden legacy model artifact: ${artifact}`);
  }
}

if (benchmarkBuild) {
  for (const artifact of ['benchmark.html', 'benchmark.js']) {
    if (!existsSync(join(distDir, artifact))) {
      throw new Error(`Benchmark build is missing required artifact: ${artifact}`);
    }
  }
} else {
  for (const artifact of benchmarkArtifacts) {
    if (existsSync(join(distDir, artifact))) {
      throw new Error(`Release build contains benchmark-only artifact: ${artifact}`);
    }
  }
}

console.log(
  benchmarkBuild
    ? 'Benchmark artifacts are isolated from the release content bridge.'
    : `${target} release artifacts contain no benchmark bridge, benchmark-only entry, or legacy OCR Worker API.`,
);
