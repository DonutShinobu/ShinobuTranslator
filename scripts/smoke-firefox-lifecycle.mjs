import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function readRequiredOption(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`${name} is required`);
  return value;
}

function readNumberOption(name, fallback) {
  const index = process.argv.indexOf(name);
  const raw = index >= 0 ? process.argv[index + 1] : undefined;
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
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
const firefox = resolve(readRequiredOption('--firefox'));
const idleTimeoutMs = readNumberOption('--idle-timeout-ms', 1_000);
if (!existsSync(firefox)) throw new Error(`Firefox executable does not exist: ${firefox}`);

const token = randomUUID();
let resolveReport;
let rejectReport;
const reportPromise = new Promise((resolvePromise, rejectPromise) => {
  resolveReport = resolvePromise;
  rejectReport = rejectPromise;
});
const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== `/pipeline-lifecycle-test-report/${token}`) {
    response.writeHead(404).end();
    return;
  }
  let body = '';
  request.setEncoding('utf8');
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    try {
      const report = JSON.parse(body);
      response.writeHead(204).end();
      resolveReport(report);
    } catch (error) {
      response.writeHead(400).end();
      rejectReport(error);
    }
  });
});
await new Promise((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', resolveListen);
});
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Lifecycle report server has no TCP port');
const reportUrl = `http://127.0.0.1:${address.port}/pipeline-lifecycle-test-report/${token}`;

const buildEnv = {
  ...process.env,
  SHINOBU_LIFECYCLE_TEST_IDLE_TIMEOUT_MS: String(idleTimeoutMs),
  SHINOBU_LIFECYCLE_TEST_REPORT_URL: reportUrl,
};
for (const [script, args, cwd] of [
  [resolve(root, 'node_modules/vite/bin/vite.js'), ['build', '--mode', 'firefox-lifecycle-test'], resolve(root, 'apps/extension')],
  [resolve(root, 'apps/extension/scripts/build-content.mjs'), ['--out-dir', 'dist-firefox-lifecycle-test'], resolve(root, 'apps/extension')],
  [resolve(root, 'scripts/build-worker.mjs'), ['--out-dir', 'apps/extension/dist-firefox-lifecycle-test'], root],
]) {
  const build = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: buildEnv,
    stdio: 'inherit',
  });
  if (build.status !== 0) {
    server.close();
    throw new Error(
      `Firefox lifecycle test build failed in ${script}: ${build.error?.message ?? build.status}`,
    );
  }
}

const dist = resolve(root, 'apps/extension/dist-firefox-lifecycle-test');
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 2 || manifest.background?.persistent !== true) {
  server.close();
  throw new Error('Firefox lifecycle test did not produce a persistent MV2 manifest');
}

const webExtCli = resolve(root, 'node_modules/web-ext/bin/web-ext.js');
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
    reject(new Error(`Firefox lifecycle smoke exited early (${code ?? signal}):\n${output}`));
  });
});
let timeoutId;
const timeout = new Promise((_, reject) => {
  timeoutId = setTimeout(
    () => reject(new Error(`Firefox lifecycle report timed out after ${idleTimeoutMs + 30_000}ms`)),
    idleTimeoutMs + 30_000,
  );
});

try {
  const report = await Promise.race([reportPromise, earlyExit, timeout]);
  if (!report?.ok) throw new Error(`Firefox lifecycle self-test failed: ${report?.error ?? 'unknown error'}`);
  if (
    report.idleTimeoutMs !== idleTimeoutMs
    || !report.firstHostInstanceId
    || !report.secondHostInstanceId
    || report.firstHostInstanceId === report.secondHostInstanceId
    || report.closedSnapshot?.lastClosedHostInstanceId !== report.firstHostInstanceId
  ) {
    throw new Error(`Firefox lifecycle self-test returned an invalid report: ${JSON.stringify(report)}`);
  }
  console.log(`Firefox persistent-host lifecycle passed at ${idleTimeoutMs}ms TTL.`);
} finally {
  clearTimeout(timeoutId);
  server.close();
  stopProcessTree(child, preexistingFirefoxPids);
}
