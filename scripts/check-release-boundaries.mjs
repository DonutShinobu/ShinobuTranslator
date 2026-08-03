import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');

function readRequiredOption(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) {
    const value = inline.slice(name.length + 1);
    if (value) return value;
  }
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`);
  return value;
}

const target = readRequiredOption('--target');
if (target !== 'chromium' && target !== 'firefox') {
  throw new Error('--target must be chromium or firefox');
}
const distDir = resolve(process.cwd(), readRequiredOption('--dist'));
const benchmarkBuild = process.argv.includes('--benchmark');

function collectFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
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
if (existsSync(join(root, 'apps', 'extension', 'dist'))) {
  throw new Error('Legacy apps/extension/dist must not exist. Use a target-specific directory.');
}

const commonArtifacts = [
  'manifest.json',
  'popup.html',
  'popup.js',
  'content.js',
  'chunks/messages.js',
  'chunks/localPipelineProtocol.js',
  'chunks/perfTrace.js',
  'chunks/onnxWorkerBridge.js',
  'onnxWorker.js',
];
const targetArtifacts = target === 'chromium'
  ? ['background-chromium.js', 'offscreen.html', 'offscreen.js']
  : ['background-firefox.html', 'background-firefox.js'];
for (const artifact of [...commonArtifacts, ...targetArtifacts]) {
  if (!existsSync(join(distDir, artifact))) {
    throw new Error(`${target} build is missing required artifact: ${artifact}`);
  }
}
if (target === 'firefox') {
  for (const chromiumOnly of ['offscreen.html', 'offscreen.js']) {
    if (existsSync(join(distDir, chromiumOnly))) {
      throw new Error(`Firefox build contains Chromium-only artifact: ${chromiumOnly}`);
    }
  }
}

const files = collectFiles(distDir);
for (const file of files.filter((path) => path.endsWith('.js'))) {
  const source = readFileSync(file, 'utf8');
  for (const token of ['__shinobu_bake', '__shinobu_render', '__shinobu_bridge']) {
    if (source.includes(token)) {
      throw new Error(`Release artifact contains forbidden benchmark token ${token}: ${file}`);
    }
  }
  if (/tesseract(?:\.js)?|cdn\.jsdelivr\.net|unpkg\.com/i.test(source)) {
    throw new Error(`Extension artifact contains Tesseract or remote executable code: ${file}`);
  }
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`JavaScript syntax check failed for ${file}: ${String(error)}`);
  }
}

const workerSource = readFileSync(join(distDir, 'onnxWorker.js'), 'utf8');
for (const token of [
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
]) {
  if (workerSource.includes(token)) {
    throw new Error(`Release Worker contains forbidden legacy OCR token ${token}`);
  }
}

const manifest = JSON.parse(readFileSync(join(distDir, 'manifest.json'), 'utf8'));
const extensionPackage = JSON.parse(
  readFileSync(join(root, 'apps', 'extension', 'package.json'), 'utf8'),
);
if (manifest.version !== extensionPackage.version) {
  throw new Error(`Manifest version ${manifest.version} does not match package ${extensionPackage.version}`);
}
if (manifest.permissions?.includes('tabs')) {
  throw new Error('The verified extension permission set must not include tabs.');
}
if (!manifest.permissions?.includes('cookies') || manifest.optional_permissions?.includes('cookies')) {
  throw new Error('cookies must be granted at install time in both extension targets.');
}
if (!String(manifest.content_security_policy?.extension_pages ?? '').includes("worker-src 'self'")) {
  throw new Error("Extension CSP must explicitly restrict worker-src to 'self'.");
}

if (target === 'chromium') {
  if (manifest.minimum_chrome_version !== '109') {
    throw new Error('Chromium manifest must require version 109.');
  }
  if (!manifest.permissions?.includes('offscreen')) {
    throw new Error('Chromium manifest is missing the offscreen permission.');
  }
  if (manifest.background?.service_worker !== 'background-chromium.js') {
    throw new Error('Chromium must use the module service worker background.');
  }
} else {
  const gecko = manifest.browser_specific_settings?.gecko;
  if (manifest.minimum_chrome_version !== undefined || manifest.permissions?.includes('offscreen')) {
    throw new Error('Firefox manifest contains Chromium-only fields or permissions.');
  }
  if (manifest.background?.page !== 'background-firefox.html' || manifest.background?.persistent === true) {
    throw new Error('Firefox must use the non-persistent background page.');
  }
  if (gecko?.id !== 'shinobu-translator@donutshinobu' || gecko?.strict_min_version !== '140.0') {
    throw new Error('Firefox Gecko identity or minimum version is incorrect.');
  }
  if (!gecko?.data_collection_permissions?.required?.includes('websiteContent')) {
    throw new Error('Firefox websiteContent data declaration is missing.');
  }
  if (!gecko?.data_collection_permissions?.required?.includes('authenticationInfo')) {
    throw new Error('Firefox required authenticationInfo data declaration is missing.');
  }
  if (gecko?.data_collection_permissions?.optional?.includes('authenticationInfo')) {
    throw new Error('Firefox authenticationInfo must not trigger a second optional consent.');
  }
}

const exposedResources = (manifest.web_accessible_resources ?? [])
  .flatMap((entry) => Array.isArray(entry.resources) ? entry.resources : []);
const contentSource = readFileSync(join(distDir, 'content.js'), 'utf8');
const contentRuntimeResources = new Set(
  [...contentSource.matchAll(/runtime\.getURL\("([^"]+)"\)/g)].map((match) => match[1]),
);
for (const resource of contentRuntimeResources) {
  if (!existsSync(join(distDir, resource))) {
    throw new Error(`Content script references missing runtime resource: ${resource}`);
  }
  if (!exposedResources.some((pattern) => matchesResourcePattern(pattern, resource))) {
    throw new Error(`Content runtime resource is not web-accessible: ${resource}`);
  }
}

const modelManifest = JSON.parse(readFileSync(join(distDir, 'models', 'models.json'), 'utf8'));
for (const model of Object.values(modelManifest.models ?? {})) {
  for (const [urlKey, sizeKey, hashKey] of [
    ['url', 'size', 'sha256'],
    ['dictUrl', 'dictSize', 'dictSha256'],
  ]) {
    if (!model[urlKey]) continue;
    if (/^https?:/i.test(model[urlKey])) {
      throw new Error(`Remote model URL is forbidden in extension output: ${model[urlKey]}`);
    }
    const modelPath = join(distDir, String(model[urlKey]).replace(/^\//, ''));
    if (!existsSync(modelPath)) throw new Error(`Missing model asset: ${modelPath}`);
    if (statSync(modelPath).size !== model[sizeKey]) {
      throw new Error(`Model size mismatch: ${relative(distDir, modelPath)}`);
    }
    if (sha256(modelPath) !== model[hashKey]) {
      throw new Error(`Model SHA-256 mismatch: ${relative(distDir, modelPath)}`);
    }
  }
}

for (const file of files) {
  const path = relative(distDir, file).replaceAll('\\', '/');
  if (/^assets\/ort-wasm.*\.wasm$/i.test(path)) {
    throw new Error(`Duplicate emitted ORT Wasm is forbidden; public/ort is canonical: ${path}`);
  }
}
for (const requiredOrtAsset of [
  'ort/ort-wasm-simd-threaded.jsep.mjs',
  'ort/ort-wasm-simd-threaded.jsep.wasm',
]) {
  if (!existsSync(join(distDir, requiredOrtAsset))) {
    throw new Error(`Extension is missing its pinned ORT JSEP runtime: ${requiredOrtAsset}`);
  }
}
for (const unusedOrtAsset of [
  'ort/ort-wasm-simd-threaded.asyncify.mjs',
  'ort/ort-wasm-simd-threaded.asyncify.wasm',
  'ort/ort-wasm-simd-threaded.mjs',
  'ort/ort-wasm-simd-threaded.wasm',
]) {
  if (existsSync(join(distDir, unusedOrtAsset))) {
    throw new Error(`Extension contains an unused ORT runtime variant: ${unusedOrtAsset}`);
  }
}

for (const artifact of [
  'ocr.onnx',
  'ocr_encoder.onnx',
  'ocr_decoder.onnx',
  'ocr_dict.txt',
  'ch_PP-OCRv5_rec_mobile.onnx',
  'paddleocr_v5_dict.txt',
  'PP-OCRv6_small_rec.onnx',
  'lama_fp32.onnx',
]) {
  if (existsSync(join(distDir, 'models', artifact))) {
    throw new Error(`Release build contains forbidden legacy model: ${artifact}`);
  }
}

const benchmarkArtifacts = ['benchmark.html', 'benchmark.js', 'benchmark-chunks', 'benchmark-assets'];
if (benchmarkBuild) {
  for (const artifact of benchmarkArtifacts.slice(0, 2)) {
    if (!existsSync(join(distDir, artifact))) throw new Error(`Missing benchmark artifact: ${artifact}`);
  }
} else {
  for (const artifact of benchmarkArtifacts) {
    if (existsSync(join(distDir, artifact))) throw new Error(`Release contains benchmark artifact: ${artifact}`);
  }
}

console.log(`${target} release boundaries verified: ${distDir}`);
