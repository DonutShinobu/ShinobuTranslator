#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECKSUM_ASSET,
  DEFAULT_MANIFEST,
  DEFAULT_MODEL_DIR,
  DEFAULT_REPO,
  collectModelAssets,
  fileExists,
  normalizeModelTag,
  parseCliArgs,
  sha256File,
  writeChecksumFile,
} from "./model-release-assets.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  console.log(`Usage: node scripts/upload-models.mjs <version> [title] [options]

Creates or updates a pre-release and uploads model assets listed in public/models/models.json.

Version examples:
  0.4.0 | v0.4.0 | models-v0.4.0

Options:
  --repo=<owner/name>    GitHub repository (default: ${DEFAULT_REPO})
  --manifest=<path>      Model manifest (default: ${DEFAULT_MANIFEST})
  --dir=<path>           Model directory (default: ${DEFAULT_MODEL_DIR})
  --dry-run              Print what would be uploaded
  --help                 Show this help
`);
}

function resolveFromRoot(path) {
  return resolve(ROOT, path);
}

function runGh(args, { allowFailure = false, silent = false } = {}) {
  const result = spawnSync("gh", args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: silent ? "pipe" : "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`gh ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result;
}

function getRelease(tag, repo) {
  const result = runGh(
    ["release", "view", tag, "--repo", repo, "--json", "assets,isPrerelease,name,tagName,url"],
    { allowFailure: true, silent: true },
  );
  if (result.status !== 0) {
    const message = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
    if (/not\s+found|404/i.test(message)) {
      return null;
    }
    throw new Error(`gh release view ${tag} failed: ${message || `exit code ${result.status}`}`);
  }
  return JSON.parse(result.stdout);
}

async function main() {
  const { options, positionals } = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const requestedTag = positionals[0] ?? process.env.MODEL_RELEASE_TAG;
  if (!requestedTag) {
    usage();
    throw new Error("Missing release version, for example: 0.4.0");
  }

  const tag = normalizeModelTag(requestedTag);
  if (tag === "latest") {
    throw new Error("Upload requires an explicit version tag.");
  }

  const repo = String(options.repo ?? DEFAULT_REPO);
  const manifestPath = resolveFromRoot(String(options.manifest ?? DEFAULT_MANIFEST));
  const modelDir = resolveFromRoot(String(options.dir ?? DEFAULT_MODEL_DIR));
  const title = positionals[1] ?? `ONNX models ${tag.replace(/^models-/, "")}`;
  const dryRun = options["dry-run"] === true;

  const assets = await collectModelAssets(manifestPath);
  const files = assets.map((name) => ({ name, path: join(modelDir, name) }));
  const missing = [];
  for (const file of files) {
    if (!await fileExists(file.path)) {
      missing.push(file.path);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing model assets:\n${missing.map((path) => `  - ${path}`).join("\n")}`);
  }

  const tmpDir = resolveFromRoot(".tmp/model-release");
  await mkdir(tmpDir, { recursive: true });
  const checksumPath = join(tmpDir, CHECKSUM_ASSET);
  const checksums = await writeChecksumFile(files, checksumPath);

  const uploadFiles = [
    ...await Promise.all(files.map(async (file) => {
      const info = await stat(file.path);
      return {
        ...file,
        digest: `sha256:${checksums.get(file.name)}`,
        size: info.size,
      };
    })),
    {
      name: CHECKSUM_ASSET,
      path: checksumPath,
      digest: `sha256:${await sha256File(checksumPath)}`,
      size: (await stat(checksumPath)).size,
    },
  ];
  console.log(`Release: ${repo}/${tag}`);
  console.log(`Title: ${title}`);
  console.log(`Manifest: ${manifestPath}`);
  for (const file of uploadFiles) {
    console.log(`  - ${file.name}`);
  }

  if (dryRun) {
    return;
  }

  runGh(["--version"]);

  let release = getRelease(tag, repo);
  if (!release) {
    const notes = [
      "ONNX model assets for browser-side ShinobuTranslator inference.",
      "",
      `Generated from ${DEFAULT_MANIFEST}.`,
      "",
      "Assets:",
      ...assets.map((asset) => `- ${asset}`),
      `- ${CHECKSUM_ASSET}`,
    ].join("\n");
    runGh([
      "release",
      "create",
      tag,
      "--repo",
      repo,
      "--title",
      title,
      "--notes",
      notes,
      "--prerelease",
    ]);
    release = { assets: [] };
  } else {
    console.log(`Release ${tag} already exists; checking uploaded asset digests.`);
  }

  const existingByName = new Map((release.assets ?? []).map((asset) => [asset.name, asset]));
  const pending = uploadFiles.filter((file) => {
    const existing = existingByName.get(file.name);
    if (!existing) {
      return true;
    }
    return existing.digest !== file.digest || existing.size !== file.size;
  });

  const skipped = uploadFiles.filter((file) => !pending.includes(file));
  for (const file of skipped) {
    console.log(`Skip unchanged ${file.name}`);
  }

  for (const file of pending) {
    console.log(`Upload ${file.name}`);
    runGh([
      "release",
      "upload",
      tag,
      file.path,
      "--repo",
      repo,
      "--clobber",
    ]);
  }

  console.log(`Uploaded: https://github.com/${repo}/releases/tag/${tag}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
