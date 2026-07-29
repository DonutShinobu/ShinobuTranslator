import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const baselinePath = path.join(
  repositoryRoot,
  'scripts',
  'workspace-import-boundary-baseline.json',
);
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.ts', '.tsx']);
const modulePathPattern = /['"]([^'"]+)['"]/gu;

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function workspaceFor(relativeFile) {
  const parts = relativeFile.split('/');
  if (
    parts.length >= 2
    && (parts[0] === 'apps' || parts[0] === 'packages')
  ) {
    return `${parts[0]}/${parts[1]}`;
  }
  return null;
}

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(target));
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(target);
    }
  }
  return files;
}

function boundaryKey(relativeFile, specifier) {
  return `${relativeFile} -> ${specifier}`;
}

async function findCrossWorkspaceImports() {
  const files = [
    ...await collectSourceFiles(path.join(repositoryRoot, 'apps')),
    ...await collectSourceFiles(path.join(repositoryRoot, 'packages')),
  ];
  const violations = [];

  for (const file of files) {
    const relativeFile = toPosix(path.relative(repositoryRoot, file));
    const owner = workspaceFor(relativeFile);
    if (!owner) continue;
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(modulePathPattern)) {
      const specifier = match[1];
      if (
        owner === 'packages/image-pipeline'
        && (
          specifier === '@shinobu/web'
          || specifier.startsWith('@shinobu/web/')
          || specifier === '@shinobu/extension'
          || specifier.startsWith('@shinobu/extension/')
        )
      ) {
        violations.push(boundaryKey(relativeFile, specifier));
        continue;
      }
      if (!specifier.startsWith('.')) continue;
      const pathOnly = specifier.split(/[?#]/u, 1)[0];
      const resolved = path.resolve(path.dirname(file), pathOnly);
      const resolvedRelative = toPosix(path.relative(repositoryRoot, resolved));
      const targetOwner = workspaceFor(resolvedRelative);
      const targetsLegacyRootSource = resolvedRelative === 'src'
        || resolvedRelative.startsWith('src/');
      const targetsAnotherWorkspace = targetOwner !== null && targetOwner !== owner;
      if (!targetsLegacyRootSource && !targetsAnotherWorkspace) continue;
      violations.push(boundaryKey(relativeFile, specifier));
    }
  }

  return violations.sort();
}

const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
if (
  !baseline
  || baseline.version !== 1
  || !Array.isArray(baseline.allowedCrossWorkspaceRelativeImports)
) {
  throw new Error('workspace import boundary baseline 格式无效');
}

const current = await findCrossWorkspaceImports();
const counts = (entries) => {
  const result = new Map();
  for (const entry of entries) {
    result.set(entry, (result.get(entry) ?? 0) + 1);
  }
  return result;
};
const currentCounts = counts(current);
const allowedCounts = counts(baseline.allowedCrossWorkspaceRelativeImports);
const expandDifference = (left, right) => {
  const difference = [];
  for (const [entry, count] of left) {
    const extra = count - (right.get(entry) ?? 0);
    for (let index = 0; index < extra; index += 1) difference.push(entry);
  }
  return difference;
};
const additions = expandDifference(currentCounts, allowedCounts);
const stale = expandDifference(allowedCounts, currentCounts);

if (additions.length > 0 || stale.length > 0) {
  if (additions.length > 0) {
    console.error('发现新增的跨 workspace 相对 import：');
    for (const entry of additions) console.error(`  + ${entry}`);
  }
  if (stale.length > 0) {
    console.error('baseline 中存在已经可以删除的遗留 import：');
    for (const entry of stale) console.error(`  - ${entry}`);
  }
  process.exitCode = 1;
} else {
  console.log(`workspace import boundary check passed (${current.length} legacy imports)`);
}
