#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateModelPublicationPolicy } from './model-publication-policy.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = join(ROOT, 'packages', 'model-manifest', 'manifest.json');
const PUBLICATION_POLICY_PATH = join(
  ROOT,
  'packages',
  'model-manifest',
  'publication-policy.json',
);

function parseArgs(args) {
  const values = new Map();
  for (const argument of args) {
    if (argument === '--dry-run') values.set('dry-run', true);
    else if (argument.startsWith('--bucket=')) values.set('bucket', argument.slice(9));
    else if (argument.startsWith('--dir=')) values.set('dir', argument.slice(6));
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return values;
}

function runWrangler(args) {
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const result = spawnSync(command, ['wrangler', ...args], {
    cwd: join(ROOT, 'apps', 'model-gateway'),
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

async function digest(path) {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bucket = String(options.get('bucket') ?? 'shinobu-models');
  const modelDir = resolve(ROOT, String(options.get('dir') ?? 'public/models'));
  const dryRun = options.get('dry-run') === true;
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const publicationPolicy = JSON.parse(await readFile(PUBLICATION_POLICY_PATH, 'utf8'));
  const publicationNotices = validateModelPublicationPolicy(manifest, publicationPolicy);
  if (publicationNotices.length > 0) {
    console.warn(
      `Model source disclosure has ${publicationNotices.length} unresolved notice(s); `
      + 'continuing because these are documented advisories for this open-source release.',
    );
  }

  for (const asset of manifest.assets) {
    const path = join(modelDir, asset.path);
    const info = await stat(path);
    if (info.size !== asset.size) {
      throw new Error(`${asset.path}: expected ${asset.size} bytes, found ${info.size}`);
    }
    const actualDigest = await digest(path);
    if (actualDigest !== asset.sha256) {
      throw new Error(`${asset.path}: SHA-256 does not match the signed-in manifest`);
    }
    const key = `models/${asset.sha256}/${asset.path}`;
    console.log(`${dryRun ? 'Would upload' : 'Upload'} ${asset.path} -> ${bucket}/${key}`);
    if (!dryRun) {
      runWrangler([
        'r2',
        'object',
        'put',
        `${bucket}/${key}`,
        `--file=${path}`,
        `--content-type=${asset.mediaType}`,
        '--remote',
        '--force',
      ]);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
