#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  CHECKSUM_ASSET,
  DEFAULT_MANIFEST,
  DEFAULT_MODEL_DIR,
  DEFAULT_REPO,
  collectModelAssets,
  fileExists,
  normalizeModelTag,
  parseChecksumText,
  parseCliArgs,
  sha256File,
} from "./model-release-assets.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.log(`Usage: node scripts/download-models.mjs [version] [options]

Downloads model assets listed in public/models/models.json from a models-* GitHub Release.

Version:
  latest                 Find the newest models-* release (default)
  0.4.0 | v0.4.0         Normalized to models-v0.4.0
  models-v0.4.0          Used as-is

Options:
  --repo=<owner/name>    GitHub repository (default: ${DEFAULT_REPO})
  --manifest=<path>      Model manifest (default: ${DEFAULT_MANIFEST})
  --dest=<path>          Download directory (default: ${DEFAULT_MODEL_DIR})
  --force                Re-download existing files
  --dry-run              Print what would be downloaded
  --help                 Show this help
`);
}

function resolveFromRoot(path) {
  return resolve(ROOT, path);
}

function githubHeaders(extra = {}) {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return {
    "Accept": "application/vnd.github+json",
    "User-Agent": "ShinobuTranslator-model-scripts",
    ...(token ? { "Authorization": `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function resolveLatestModelTag(repo) {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=100`;
  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    throw new Error(`Failed to list releases: ${response.status} ${response.statusText}`);
  }
  const releases = await response.json();
  const release = releases.find(
    (item) => typeof item.tag_name === "string" && item.tag_name.startsWith("models-"),
  );
  if (!release) {
    throw new Error(`No models-* release found in ${repo}`);
  }
  return release.tag_name;
}

async function fetchTextIfExists(url) {
  const response = await fetch(url, {
    headers: githubHeaders({ "Accept": "text/plain,application/octet-stream,*/*" }),
  });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.text();
}

async function downloadFile(url, targetPath) {
  const tempPath = `${targetPath}.download-${process.pid}.tmp`;
  const response = await fetch(url, { headers: githubHeaders({ "Accept": "application/octet-stream" }) });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  if (!response.body) {
    throw new Error(`No response body for ${url}`);
  }
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));
    await rename(tempPath, targetPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function verifyChecksum(filePath, name, checksums) {
  const expected = checksums.get(name);
  if (!expected) {
    return;
  }
  const actual = await sha256File(filePath);
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}`);
  }
}

async function main() {
  const { options, positionals } = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const repo = String(options.repo ?? DEFAULT_REPO);
  const manifestPath = resolveFromRoot(String(options.manifest ?? DEFAULT_MANIFEST));
  const destDir = resolveFromRoot(String(options.dest ?? DEFAULT_MODEL_DIR));
  const force = options.force === true;
  const dryRun = options["dry-run"] === true;
  const requestedTag = positionals[0] ?? process.env.MODEL_RELEASE_TAG ?? "latest";

  let tag = normalizeModelTag(requestedTag);
  if (tag === "latest") {
    tag = await resolveLatestModelTag(repo);
  }

  const assets = await collectModelAssets(manifestPath);
  const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;

  console.log(`Model release: ${repo}/${tag}`);
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Destination: ${destDir}`);
  for (const asset of assets) {
    console.log(`  - ${asset}`);
  }

  if (dryRun) {
    return;
  }

  await mkdir(destDir, { recursive: true });

  const checksumText = await fetchTextIfExists(`${baseUrl}/${CHECKSUM_ASSET}`);
  const checksums = checksumText ? parseChecksumText(checksumText) : new Map();
  if (checksumText) {
    await writeFile(join(destDir, CHECKSUM_ASSET), checksumText, "utf8");
    console.log(`Saved ${CHECKSUM_ASSET}`);
  } else {
    console.log(`${CHECKSUM_ASSET} not found; downloads will not be checksum verified`);
  }

  for (const asset of assets) {
    const targetPath = join(destDir, asset);
    if (!force && await fileExists(targetPath)) {
      await verifyChecksum(targetPath, asset, checksums);
      console.log(`Skip existing ${asset}`);
      continue;
    }

    console.log(`Download ${asset}`);
    await downloadFile(`${baseUrl}/${asset}`, targetPath);
    await verifyChecksum(targetPath, asset, checksums);
  }

  console.log("Model download complete.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
