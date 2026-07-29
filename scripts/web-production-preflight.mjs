import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateModelPublicationPolicy,
} from './model-publication-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modes = new Set(['--repository', '--rehearsal', '--release']);
const mode = process.argv[2] ?? '--repository';

if (!modes.has(mode) || process.argv.length > 3) {
  throw new Error(
    'Usage: node scripts/web-production-preflight.mjs '
    + '[--repository|--rehearsal|--release]',
  );
}

async function readText(path) {
  return readFile(resolve(root, path), 'utf8');
}

async function readJson(path) {
  return JSON.parse(await readText(path));
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function includesAll(source, markers, label) {
  for (const marker of markers) {
    invariant(source.includes(marker), `${label} is missing: ${marker}`);
  }
}

function ordered(source, markers, label) {
  let cursor = -1;
  for (const marker of markers) {
    const next = source.indexOf(marker, cursor + 1);
    invariant(next >= 0, `${label} is missing: ${marker}`);
    invariant(next > cursor, `${label} has an unsafe step order near: ${marker}`);
    cursor = next;
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  invariant(value, `Missing required production environment value: ${name}`);
  return value;
}

function parseHttpsOrigin(name) {
  const raw = requiredEnv(name);
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid URL origin`);
  }
  invariant(url.protocol === 'https:', `${name} must use HTTPS`);
  invariant(!url.username && !url.password, `${name} must not contain credentials`);
  invariant(url.pathname === '/', `${name} must not contain a path`);
  invariant(!url.search && !url.hash, `${name} must not contain a query or fragment`);
  return url.origin;
}

function validateModelPackage(modelPackage, label) {
  invariant(
    modelPackage
    && typeof modelPackage === 'object'
    && !Array.isArray(modelPackage),
    `${label} must be an object`,
  );
  invariant(modelPackage.schemaVersion === 1, `${label} must use schemaVersion 1`);
  invariant(
    typeof modelPackage.version === 'string' && modelPackage.version.trim(),
    `${label} must have a version`,
  );
  invariant(Array.isArray(modelPackage.assets), `${label}.assets must be an array`);

  const ids = new Set();
  const paths = new Set();
  for (const asset of modelPackage.assets) {
    invariant(asset && typeof asset === 'object', `${label} contains an invalid asset`);
    invariant(
      typeof asset.id === 'string' && asset.id.trim() && !ids.has(asset.id),
      `${label} contains an empty or duplicate asset id`,
    );
    invariant(
      typeof asset.path === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(asset.path)
      && !paths.has(asset.path),
      `${label} contains an unsafe or duplicate asset path`,
    );
    invariant(
      Number.isSafeInteger(asset.size) && asset.size > 0,
      `${label} contains an invalid asset size`,
    );
    invariant(
      typeof asset.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(asset.sha256),
      `${label} contains an invalid SHA-256`,
    );
    invariant(
      typeof asset.mediaType === 'string' && asset.mediaType.trim(),
      `${label} contains an invalid media type`,
    );
    ids.add(asset.id);
    paths.add(asset.path);
  }
}

const [
  workflow,
  wrangler,
  headers,
  manifest,
  compatibility,
  policy,
  webPackage,
  releaseNotes,
] = await Promise.all([
  readText('.github/workflows/web-release.yml'),
  readText('apps/model-gateway/wrangler.jsonc'),
  readText('apps/web/_headers'),
  readJson('packages/model-manifest/manifest.json'),
  readJson('packages/model-manifest/compatibility.json'),
  readJson('packages/model-manifest/publication-policy.json'),
  readJson('apps/web/package.json'),
  readText('WEB_PUBLIC_BETA_RELEASE_NOTES.md'),
]);

includesAll(workflow, [
  'types: [published]',
  "startsWith(github.event.release.tag_name, 'web-v')",
  'group: web-production',
  'cancel-in-progress: false',
  'contents: read',
  'npm run web:production:preflight -- --release',
  'npm run models:upload-r2 -- --dry-run',
  '--tag "$WEB_RELEASE_TAG"',
  'actions/upload-artifact@v4',
  'retention-days: 30',
  '--branch main',
  '--commit-hash "${{ github.sha }}"',
], 'Web production workflow');

ordered(workflow, [
  'npm run web:production:preflight -- --release',
  'npm run models:download',
  'npm run models:upload-r2 -- --dry-run',
  'npm run check',
  'npm run models:upload-r2',
  'npx wrangler deploy',
  'npm run build:web',
  'actions/upload-artifact@v4',
  'npx wrangler pages deploy',
], 'Web production workflow');

includesAll(wrangler, [
  '"workers_dev": true',
  '"send_metrics": false',
  '"observability": {',
  '"enabled": false',
  '"SERVING_ENABLED": "false"',
  '"TURNSTILE_REQUIRED": "false"',
  '"bucket_name": "shinobu-models"',
  '"preview_bucket_name": "shinobu-models-preview"',
], 'Model gateway Wrangler configuration');

includesAll(headers, [
  "Content-Security-Policy: default-src 'self'",
  "require-trusted-types-for 'script'",
  'Cross-Origin-Opener-Policy: same-origin',
  'Cross-Origin-Embedder-Policy: require-corp',
  'Cross-Origin-Resource-Policy: same-origin',
  'Referrer-Policy: no-referrer',
  'X-Content-Type-Options: nosniff',
], 'Web security headers');

validateModelPackage(manifest, 'Current model package');
invariant(
  compatibility
  && typeof compatibility === 'object'
  && Array.isArray(compatibility.packages),
  'Model compatibility document must contain a packages array',
);
const compatibilityVersions = new Set();
for (const [index, modelPackage] of compatibility.packages.entries()) {
  validateModelPackage(modelPackage, `Compatibility model package ${index}`);
  invariant(
    modelPackage.version !== manifest.version,
    'Compatibility packages must not duplicate the current model package',
  );
  invariant(
    !compatibilityVersions.has(modelPackage.version),
    `Duplicate compatibility model package: ${modelPackage.version}`,
  );
  compatibilityVersions.add(modelPackage.version);
}

const publicationNotices = validateModelPublicationPolicy(manifest, policy);

if (mode === '--repository') {
  console.log(
    `Web production repository controls verified; `
    + `${publicationNotices.length} documented model source notice(s) remain.`,
  );
  process.exit(0);
}

const webOrigin = parseHttpsOrigin('WEB_PRODUCTION_ORIGIN');
const gatewayOrigin = parseHttpsOrigin('MODEL_GATEWAY_ORIGIN');
invariant(webOrigin !== gatewayOrigin, 'Web and model gateway origins must be different');

const pagesProject = requiredEnv('CLOUDFLARE_PAGES_PROJECT');
invariant(
  /^[a-z0-9](?:[a-z0-9-]{0,56}[a-z0-9])?$/u.test(pagesProject),
  'CLOUDFLARE_PAGES_PROJECT must be a valid Cloudflare Pages project name',
);
const accountId = requiredEnv('CLOUDFLARE_ACCOUNT_ID');
invariant(
  /^[a-f0-9]{32}$/iu.test(accountId),
  'CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account id',
);
requiredEnv('CLOUDFLARE_API_TOKEN');

const webReleaseTag = requiredEnv('WEB_RELEASE_TAG');
invariant(
  webReleaseTag === `web-v${webPackage.version}`,
  `WEB_RELEASE_TAG must match apps/web/package.json: web-v${webPackage.version}`,
);

if (mode === '--rehearsal') {
  console.log(
    `Protected-environment rehearsal preflight passed for ${webReleaseTag}; `
    + 'no production write is authorized by this mode.',
  );
  process.exit(0);
}

const modelReleaseTag = requiredEnv('MODEL_RELEASE_TAG');
invariant(
  /^models-[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(modelReleaseTag),
  'MODEL_RELEASE_TAG must start with models- and contain only release-safe characters',
);
invariant(
  !releaseNotes.includes('状态：发布草案'),
  'Public Beta release notes are still marked as a draft',
);

console.log(
  `Web production release preflight passed for ${webReleaseTag} `
  + `with model release ${modelReleaseTag}.`,
);
