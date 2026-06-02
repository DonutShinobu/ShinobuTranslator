import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

export const DEFAULT_REPO = "DonutShinobu/ShinobuTranslator";
export const DEFAULT_MODEL_DIR = "public/models";
export const DEFAULT_MANIFEST = "public/models/models.json";
export const CHECKSUM_ASSET = "models.sha256";

export function normalizeModelTag(input) {
  if (!input || input === "latest") {
    return input ?? "latest";
  }
  if (input.startsWith("models-")) {
    return input;
  }
  const version = input.startsWith("v") ? input : `v${input}`;
  return `models-${version}`;
}

export function parseCliArgs(argv) {
  const options = {};
  const positionals = [];
  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq === -1) {
      options[body] = true;
    } else {
      options[body.slice(0, eq)] = body.slice(eq + 1);
    }
  }
  return { options, positionals };
}

export async function collectModelAssets(manifestPath = DEFAULT_MANIFEST) {
  const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
  const assets = new Set();
  for (const model of Object.values(manifest.models ?? {})) {
    for (const key of ["url", "dictUrl"]) {
      const value = model?.[key];
      if (typeof value !== "string" || value.trim() === "") {
        continue;
      }
      const asset = assetNameFromModelUrl(value);
      if (asset) {
        assets.add(asset);
      }
    }
  }
  return [...assets].sort((a, b) => a.localeCompare(b));
}

export function assetNameFromModelUrl(value) {
  try {
    const url = new URL(value, "https://example.invalid/");
    return basename(url.pathname);
  } catch {
    return basename(value);
  }
}

export async function fileExists(path) {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

export function sha256File(path) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export async function writeChecksumFile(files, outputPath) {
  const lines = [];
  const checksums = new Map();
  for (const file of files) {
    const hash = await sha256File(file.path);
    checksums.set(file.name, hash);
    lines.push(`${hash}  ${file.name}`);
  }
  await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
  return checksums;
}

export function parseChecksumText(text) {
  const out = new Map();
  for (const rawLine of text.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match) {
      out.set(match[2].trim(), match[1].toLowerCase());
    }
  }
  return out;
}
