import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function readRequiredOption(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`);
  return value;
}

const root = resolve(import.meta.dirname, '..');
const dist = resolve(process.cwd(), readRequiredOption('--dist'));
const firefox = readRequiredOption('--firefox');
const webExtCli = resolve(root, 'node_modules/web-ext/bin/web-ext.js');
for (const artifact of [
  'manifest.json',
  'background-firefox.html',
  'background-firefox.js',
  'content.js',
  'popup.html',
  'onnxWorker.js',
]) {
  if (!existsSync(join(dist, artifact))) throw new Error(`Missing Firefox artifact: ${artifact}`);
}
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
if (manifest.browser_specific_settings?.gecko?.strict_min_version !== '140.0') {
  throw new Error('Firefox smoke requires a manifest with strict_min_version 140.0');
}

const child = spawn(
  process.execPath,
  [
    webExtCli,
    'run',
    '--source-dir', dist,
    '--target', 'firefox-desktop',
    '--firefox', firefox,
    '--no-input',
    '--no-reload',
    '--start-url', 'about:blank',
  ],
  {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  },
);
let output = '';
child.stdout.on('data', (chunk) => {
  output += chunk.toString();
  process.stdout.write(chunk);
});
child.stderr.on('data', (chunk) => {
  output += chunk.toString();
  process.stderr.write(chunk);
});

const earlyExit = new Promise((_, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    reject(new Error(`Firefox extension smoke exited early (${code ?? signal}):\n${output}`));
  });
});
const healthy = new Promise((resolveHealthy) => setTimeout(resolveHealthy, 20_000));
await Promise.race([earlyExit, healthy]);

if (process.platform === 'win32') child.kill();
else if (child.pid) process.kill(-child.pid, 'SIGTERM');
console.log('Firefox loaded the extension and kept its event page healthy for 20 seconds.');
