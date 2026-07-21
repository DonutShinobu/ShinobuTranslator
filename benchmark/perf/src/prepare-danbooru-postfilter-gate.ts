import { link, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_CANDIDATES = join(
  ROOT,
  "benchmark",
  "reports",
  "danbooru-face-misdetection-analysis-v1-20260721",
  "anime-face-overlap-all-candidates.json",
);
const DEFAULT_SOURCE = join(
  ROOT,
  "benchmark",
  "images",
  "danbooru-translated-comic-4000",
);
const DEFAULT_SUPPLEMENTAL = join(
  ROOT,
  "benchmark",
  "reports",
  "danbooru-face-misdetection-analysis-v1-20260721",
  "reviewed-priority-candidates.json",
);
const DEFAULT_OUTPUT = join(
  ROOT,
  "benchmark",
  "images",
  "danbooru-postfilter-study-245",
);

type Candidate = {
  input: string;
};

function readOption(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function resolveInside(root: string, relativePath: string): string {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  const relativeToRoot = relative(resolvedRoot, resolvedPath);
  if (
    relativeToRoot === ""
    || (!relativeToRoot.startsWith("..") && !isAbsolute(relativeToRoot))
  ) {
    return resolvedPath;
  }
  throw new Error(`候选路径越界: ${relativePath}`);
}

async function main(): Promise<void> {
  const candidatesPath = resolve(readOption("candidates") ?? DEFAULT_CANDIDATES);
  const supplementalPath = resolve(
    readOption("supplemental") ?? DEFAULT_SUPPLEMENTAL,
  );
  const sourceDir = resolve(readOption("source") ?? DEFAULT_SOURCE);
  const outputDir = resolve(readOption("output") ?? DEFAULT_OUTPUT);
  const candidates = JSON.parse(
    await readFile(candidatesPath, "utf8"),
  ) as Candidate[];
  const supplemental = JSON.parse(
    await readFile(supplementalPath, "utf8"),
  ) as Candidate[];
  const strictInputs = [...new Set(
    candidates.map((candidate) => candidate.input),
  )].sort();
  const supplementalInputs = [...new Set(
    supplemental.map((candidate) => candidate.input),
  )].sort();
  const inputs = [...new Set([...strictInputs, ...supplementalInputs])].sort();

  await mkdir(outputDir, { recursive: true });
  let created = 0;
  let existing = 0;
  for (const input of inputs) {
    const sourcePath = resolveInside(sourceDir, input);
    const outputPath = resolveInside(outputDir, input);
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) {
      throw new Error(`源图不是文件: ${sourcePath}`);
    }
    await mkdir(dirname(outputPath), { recursive: true });
    const outputStat = await stat(outputPath).catch(() => null);
    if (outputStat) {
      if (!outputStat.isFile() || outputStat.size !== sourceStat.size) {
        throw new Error(`已有目标与源图不一致: ${outputPath}`);
      }
      existing += 1;
      continue;
    }
    await link(sourcePath, outputPath);
    created += 1;
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    candidatesPath,
    supplementalPath,
    sourceDir,
    outputDir,
    strictCandidateCount: candidates.length,
    strictImageCount: strictInputs.length,
    supplementalCandidateCount: supplemental.length,
    supplementalImageCount: supplementalInputs.length,
    uniqueImageCount: inputs.length,
    createdHardlinks: created,
    existingFiles: existing,
    inputs,
  };
  await writeFile(
    join(outputDir, "gate-manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  console.log(JSON.stringify(manifest, null, 2));
}

await main();
