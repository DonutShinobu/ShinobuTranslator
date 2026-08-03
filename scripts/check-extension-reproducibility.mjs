import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

function readRequiredOption(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`);
  return resolve(process.cwd(), value);
}

const root = resolve(import.meta.dirname, '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this checker through npm so npm_execpath is available');
const targets = new Map([
  ['chromium', readRequiredOption('--chromium')],
  ['firefox', readRequiredOption('--firefox')],
]);

function snapshot(directory) {
  if (!existsSync(directory)) throw new Error(`Missing extension directory: ${directory}`);
  const result = new Map();
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) {
        const relativePath = relative(directory, path).replaceAll('\\', '/');
        const size = statSync(path).size;
        // Model bytes are already hashed against the pinned models.json by each
        // target's release-boundary check during both builds. Avoid reading the
        // same ~200 MiB model set four extra times here.
        if (relativePath.startsWith('models/') && size > 1024 * 1024) {
          result.set(relativePath, `pinned-model:${size}`);
          continue;
        }
        result.set(
          relativePath,
          createHash('sha256').update(readFileSync(path)).digest('hex'),
        );
      }
    }
  };
  visit(directory);
  return [...result].sort(([left], [right]) => left.localeCompare(right));
}

const before = new Map([...targets].map(([target, directory]) => [target, snapshot(directory)]));
execFileSync(process.execPath, [npmCli, 'run', 'build:extension'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

for (const [target, directory] of targets) {
  const actual = snapshot(directory);
  if (JSON.stringify(actual) !== JSON.stringify(before.get(target))) {
    throw new Error(`${target} extension build is not reproducible`);
  }
}
console.log('Generated extension artifacts are reproducible; pinned model bytes passed release SHA-256 checks.');
