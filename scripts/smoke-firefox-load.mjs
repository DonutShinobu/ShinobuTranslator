import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function readRequiredOption(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`);
  return value;
}

function listTemporaryWebExtFirefoxPids() {
  if (process.platform !== 'win32') return [];
  const command = String.raw`
$ids = @(Get-CimInstance Win32_Process -Filter "Name = 'firefox.exe'" |
  Where-Object { $_.CommandLine -like '*-start-debugger-server*' -and $_.CommandLine -like '*AppData\Local\Temp\firefox-profile*' } |
  ForEach-Object { [int]$_.ProcessId })
ConvertTo-Json -InputObject $ids -Compress
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status !== 0 || !result.stdout.trim()) return [];
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function stopProcessTree(child, preexistingFirefoxPids) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    for (const pid of listTemporaryWebExtFirefoxPids()) {
      if (!preexistingFirefoxPids.has(pid)) {
        spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      }
    }
    return;
  }
  process.kill(-child.pid, 'SIGTERM');
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
if (
  manifest.manifest_version !== 2
  || manifest.background?.page !== 'background-firefox.html'
  || manifest.background?.persistent !== true
) {
  throw new Error('Firefox smoke requires the persistent Manifest V2 background page');
}
if (!manifest.browser_action || manifest.action !== undefined) {
  throw new Error('Firefox smoke requires the Manifest V2 browser_action shape');
}

const preexistingFirefoxPids = new Set(listTemporaryWebExtFirefoxPids());
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
try {
  await Promise.race([earlyExit, healthy]);
} finally {
  stopProcessTree(child, preexistingFirefoxPids);
}
console.log('Firefox loaded the persistent MV2 extension successfully for 20 seconds.');
